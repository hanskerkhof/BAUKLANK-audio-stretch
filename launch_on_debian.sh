#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# BAUKLANK Debian Kiosk Launcher
# File: launch_on_debian.sh
#
# Responsibilities
# - Start the local static web app (python3 http.server)
# - Start BAUKLANK serial/WebSocket bridge (server-multi.py)
# - Start Chromium in kiosk mode against local URL
# - Keep all child processes supervised and stop them cleanly
#
# Integration context
# - Intended for Debian 13 kiosk installs on stronger x86 hardware
# - Intended to run as desktop user "pi" (not root)
# - Works with either:
#   1) systemd user service (recommended)
#   2) XFCE autostart entry
#
# Design notes
# - Uses a dedicated Chromium profile dir to avoid first-run noise
# - Uses --password-store=basic to avoid keyring popups
# - Keeps Chromium flags intentionally minimal and stable
# - GPU stays enabled by default; enable disable-gpu only if needed
# ============================================================

readonly USER_NAME="pi"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ------- Runtime config (override via environment when needed) -------
readonly WEB_ROOT="${BAUKLANK_WEB_ROOT:-$SCRIPT_DIR/app/multi}"
readonly WEB_PORT="${BAUKLANK_WEB_PORT:-8080}"
readonly WS_HOST="${BAUKLANK_WS_HOST:-127.0.0.1}"
readonly WS_PORT="${BAUKLANK_WS_PORT:-8765}"
readonly ENGINE_COUNT="${BAUKLANK_ENGINE_COUNT:-1}"
readonly ENGINE_SLOT="${BAUKLANK_ENGINE_SLOT:-A}"
readonly APP_URL="${BAUKLANK_APP_URL:-http://127.0.0.1:8080/index.html?engines=1&slot=A}"
readonly CHROMIUM_PROFILE_DIR="${BAUKLANK_CHROMIUM_PROFILE_DIR:-$HOME/.config/chromium-kiosk}"
readonly CHROMIUM_DISABLE_GPU="${BAUKLANK_CHROMIUM_DISABLE_GPU:-0}"
readonly PREFERRED_SINK_PORT="${BAUKLANK_PREFERRED_SINK_PORT:-analog-output-headphones}"
readonly CLICK_TO_START="${BAUKLANK_CLICK_TO_START:-0}"
readonly CLICK_X="${BAUKLANK_CLICK_X:-30}"
readonly CLICK_Y="${BAUKLANK_CLICK_Y:-30}"
readonly DISPLAY="${DISPLAY:-:0}"
readonly XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"

http_pid=""
bridge_pid=""
chrome_pid=""

log() {
  printf '[%s] %s\n' "$(date +'%F %T')" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

kill_process_group() {
  local pid="$1"
  local label="$2"

  [[ -z "${pid:-}" ]] && return 0
  kill -0 "$pid" 2>/dev/null || return 0

  log "Stopping $label (pgid=$pid)"
  kill -TERM "-$pid" 2>/dev/null || true

  for _ in {1..30}; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done

  log "$label still running; forcing kill (pgid=$pid)"
  kill -KILL "-$pid" 2>/dev/null || true
}

cleanup() {
  log "Cleanup starting"
  kill_process_group "$chrome_pid" "Chromium"
  kill_process_group "$bridge_pid" "server-multi.py"
  kill_process_group "$http_pid" "http.server"
  log "Cleanup finished"
}
trap cleanup EXIT INT TERM

resolve_chromium() {
  if [[ -n "${BAUKLANK_CHROMIUM_BIN:-}" ]] && has_cmd "$BAUKLANK_CHROMIUM_BIN"; then
    printf '%s' "$BAUKLANK_CHROMIUM_BIN"
    return 0
  fi

  if has_cmd chromium; then
    printf '%s' "chromium"
    return 0
  fi

  if has_cmd chromium-browser; then
    printf '%s' "chromium-browser"
    return 0
  fi

  return 1
}

wait_for_http() {
  local url="$1"
  local timeout_sec="$2"
  local deadline=$((SECONDS + timeout_sec))

  while (( SECONDS < deadline )); do
    if python3 - "$url" >/dev/null 2>&1 <<'PY'
import sys
import urllib.request

url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=0.5) as response:
        sys.exit(0 if 200 <= response.status < 500 else 1)
except Exception:
    sys.exit(1)
PY
    then
      return 0
    fi
    sleep 0.25
  done

  return 1
}

wait_for_default_sink() {
  local timeout_sec="$1"
  local deadline=$((SECONDS + timeout_sec))

  while (( SECONDS < deadline )); do
    local sink=""
    sink="$(pactl info 2>/dev/null | sed -n 's/^Default Sink: //p' || true)"
    if [[ -n "$sink" ]]; then
      printf '%s' "$sink"
      return 0
    fi
    sleep 0.25
  done

  return 1
}

enforce_audio_route() {
  if ! has_cmd pactl; then
    log "WARN: pactl not found; skipping audio route enforcement"
    return 0
  fi

  local default_sink=""
  default_sink="$(wait_for_default_sink 10 || true)"
  if [[ -z "$default_sink" ]]; then
    log "WARN: Pulse default sink unavailable; skipping audio route enforcement"
    return 0
  fi

  log "Enforcing audio sink settings on '$default_sink' (port=$PREFERRED_SINK_PORT)"
  pactl set-sink-port "$default_sink" "$PREFERRED_SINK_PORT" || true
  pactl set-sink-mute "$default_sink" 0 || true
  pactl set-sink-volume "$default_sink" 90% || true

  # Re-apply once shortly after startup to survive late jack/profile churn.
  (
    sleep 2
    pactl set-sink-port "$default_sink" "$PREFERRED_SINK_PORT" || true
    pactl set-sink-mute "$default_sink" 0 || true
    pactl set-sink-volume "$default_sink" 90% || true
  ) >/dev/null 2>&1 &
}

maybe_click_play() {
  [[ "$CLICK_TO_START" == "1" ]] || return 0

  if ! has_cmd xdotool; then
    log "CLICK_TO_START=1 but xdotool is missing; skipping click"
    return 0
  fi

  log "CLICK_TO_START enabled; waiting for Chromium window"
  local win_id=""
  for _ in {1..80}; do
    win_id="$(xdotool search --onlyvisible --class chromium | tail -n 1 || true)"
    [[ -n "$win_id" ]] && break
    sleep 0.25
  done

  if [[ -z "$win_id" ]]; then
    log "Chromium window not found; skipping click"
    return 0
  fi

  xdotool windowactivate --sync "$win_id" || true
  sleep 0.5
  xdotool mousemove --sync "$CLICK_X" "$CLICK_Y"
  xdotool click 1
  log "Startup click sent at x=$CLICK_X y=$CLICK_Y"
}

# ------- Preconditions -------
[[ "$(id -un)" == "$USER_NAME" ]] || fail "Run this as user '$USER_NAME' (current: $(id -un))."
[[ -d "$WEB_ROOT" ]] || fail "Web root not found: $WEB_ROOT"
[[ -f "$SCRIPT_DIR/server-multi.py" ]] || fail "Missing file: $SCRIPT_DIR/server-multi.py"
has_cmd python3 || fail "python3 is not installed"

chromium_bin="$(resolve_chromium)" || fail "Chromium binary not found (tried chromium, chromium-browser)"

if [[ ! -f "$XAUTHORITY" ]]; then
  log "WARN: XAUTHORITY file not found at $XAUTHORITY"
fi

log "BAUKLANK launcher starting"
log "Repo dir: $SCRIPT_DIR"
log "App URL:  $APP_URL"
log "DISPLAY:  $DISPLAY"

mkdir -p "$CHROMIUM_PROFILE_DIR"

# ------- Start static web server -------
log "Starting python3 -m http.server on :$WEB_PORT from $WEB_ROOT"
setsid python3 -m http.server "$WEB_PORT" --directory "$WEB_ROOT" &
http_pid="$!"

wait_for_http "$APP_URL" 30 || fail "Web app did not become reachable at $APP_URL"

# ------- Enforce sink port/mute/volume -------
enforce_audio_route

# ------- Start BAUKLANK bridge -------
log "Starting server-multi.py (engine-count=$ENGINE_COUNT, slot=$ENGINE_SLOT)"
setsid python3 "$SCRIPT_DIR/server-multi.py" \
  --engine-count "$ENGINE_COUNT" \
  --slot "$ENGINE_SLOT" \
  --ws-host "$WS_HOST" \
  --ws-port "$WS_PORT" \
  --startup-log-level INFO \
  --run-log-level WARNING &
bridge_pid="$!"

# Small stabilization delay before browser launch
sleep 0.5

# ------- Start Chromium kiosk -------
chromium_flags=(
  --kiosk
  --password-store=basic
  --user-data-dir="$CHROMIUM_PROFILE_DIR"
  --no-first-run
  --no-default-browser-check
  --autoplay-policy=no-user-gesture-required
  --disable-session-crashed-bubble
)

if [[ "$CHROMIUM_DISABLE_GPU" == "1" ]]; then
  chromium_flags+=(--disable-gpu)
  log "Chromium GPU disabled (BAUKLANK_CHROMIUM_DISABLE_GPU=1)"
fi

log "Starting Chromium kiosk"
setsid "$chromium_bin" "${chromium_flags[@]}" "$APP_URL" &
chrome_pid="$!"

# Optional, only if explicitly enabled
maybe_click_play

# ------- Supervision loop -------
log "Kiosk stack is running"
while true; do
  kill -0 "$http_pid" 2>/dev/null || fail "http.server exited unexpectedly"
  kill -0 "$bridge_pid" 2>/dev/null || fail "server-multi.py exited unexpectedly"
  kill -0 "$chrome_pid" 2>/dev/null || fail "Chromium exited unexpectedly"
  sleep 2
done
