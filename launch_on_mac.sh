#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# BAUKLANK macOS Dev Launcher
# File: launch_on_mac.sh
#
# Starts:
# 1) Static web app server (python3 http.server)
# 2) BAUKLANK serial/WebSocket bridge (server-multi.py)
# 3) Browser (default: Google Chrome) at APP_URL
#
# Stops all child process groups on exit.
# ============================================================

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ------- Runtime config (override with env vars) -------
readonly WEB_ROOT="${BAUKLANK_WEB_ROOT:-$SCRIPT_DIR/app/multi}"
readonly WEB_PORT="${BAUKLANK_WEB_PORT:-8080}"
readonly WS_HOST="${BAUKLANK_WS_HOST:-127.0.0.1}"
readonly WS_PORT="${BAUKLANK_WS_PORT:-8765}"
readonly ENGINE_COUNT="${BAUKLANK_ENGINE_COUNT:-2}"
readonly ENGINE_SLOT="${BAUKLANK_ENGINE_SLOT:-A}"
readonly APP_URL="${BAUKLANK_APP_URL:-http://127.0.0.1:8080/index.html?engines=2}"
readonly OPEN_BROWSER="${BAUKLANK_OPEN_BROWSER:-1}"
readonly BROWSER_APP="${BAUKLANK_BROWSER_APP:-Google Chrome}"
readonly BROWSER_KIOSK_DEFAULT="${BAUKLANK_BROWSER_KIOSK:-0}"
readonly MAC_CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
readonly MAC_CHROME_PROFILE_DIR="${BAUKLANK_MAC_CHROME_PROFILE_DIR:-$SCRIPT_DIR/.runtime/chrome-dev-profile}"
readonly PYTHON_BIN_DEFAULT="$SCRIPT_DIR/.venv/bin/python"
readonly PYTHON_BIN="${BAUKLANK_PYTHON_BIN:-$PYTHON_BIN_DEFAULT}"

BROWSER_KIOSK="$BROWSER_KIOSK_DEFAULT"
USE_PROCESS_GROUPS="0"

http_pid=""
bridge_pid=""
browser_pid=""

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

usage() {
  cat <<'EOF'
Usage: ./launch_on_mac.sh [--kiosk] [--help]

Options:
  --kiosk    Launch browser in kiosk mode (Google Chrome/Chromium path).
  --help     Show this help.

Environment overrides:
  BAUKLANK_BROWSER_KIOSK=1  Default kiosk mode without passing --kiosk
  BAUKLANK_OPEN_BROWSER=0   Start backend/web only, do not open browser
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --kiosk)
        BROWSER_KIOSK="1"
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail "Unknown argument: $1 (try --help)"
        ;;
    esac
  done
}

kill_process_group() {
  local pid="$1"
  local label="$2"

  [[ -z "${pid:-}" ]] && return 0
  kill -0 "$pid" 2>/dev/null || return 0

  log "Stopping $label (pgid=$pid)"
  if [[ "$USE_PROCESS_GROUPS" == "1" ]]; then
    kill -TERM "-$pid" 2>/dev/null || true
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi

  for _ in {1..30}; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done

  log "$label still running; forcing kill (pgid=$pid)"
  if [[ "$USE_PROCESS_GROUPS" == "1" ]]; then
    kill -KILL "-$pid" 2>/dev/null || true
  else
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  log "Cleanup starting"
  kill_process_group "$browser_pid" "Browser"
  kill_process_group "$bridge_pid" "server-multi.py"
  kill_process_group "$http_pid" "http.server"
  log "Cleanup finished"
}
trap cleanup EXIT INT TERM

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

start_browser() {
  [[ "$OPEN_BROWSER" == "1" ]] || return 0

  if [[ "$BROWSER_KIOSK" == "1" ]]; then
    local chrome_bin="$MAC_CHROME_BIN"
    if [[ -x "$chrome_bin" ]]; then
      log "Opening $APP_URL in Google Chrome kiosk mode"
      if [[ "$USE_PROCESS_GROUPS" == "1" ]]; then
        setsid "$chrome_bin" \
          --kiosk \
          --new-window \
          --autoplay-policy=no-user-gesture-required \
          --disable-session-crashed-bubble \
          "$APP_URL" >/dev/null 2>&1 &
      else
        "$chrome_bin" \
          --kiosk \
          --new-window \
          --autoplay-policy=no-user-gesture-required \
          --disable-session-crashed-bubble \
          "$APP_URL" >/dev/null 2>&1 &
      fi
      browser_pid="$!"
      return 0
    fi

    if has_cmd chromium; then
      log "Opening $APP_URL in Chromium kiosk mode"
      if [[ "$USE_PROCESS_GROUPS" == "1" ]]; then
        setsid chromium \
          --kiosk \
          --new-window \
          --autoplay-policy=no-user-gesture-required \
          --disable-session-crashed-bubble \
          "$APP_URL" >/dev/null 2>&1 &
      else
        chromium \
          --kiosk \
          --new-window \
          --autoplay-policy=no-user-gesture-required \
          --disable-session-crashed-bubble \
          "$APP_URL" >/dev/null 2>&1 &
      fi
      browser_pid="$!"
      return 0
    fi

    log "WARN: --kiosk requested but Chrome/Chromium kiosk binary not found; falling back to normal open"
  fi

  if [[ "$BROWSER_APP" == "Google Chrome" ]] && [[ -x "$MAC_CHROME_BIN" ]]; then
    install -d -m 0755 "$MAC_CHROME_PROFILE_DIR"
    log "Opening $APP_URL in Google Chrome (dedicated dev window)"
    if [[ "$USE_PROCESS_GROUPS" == "1" ]]; then
      setsid "$MAC_CHROME_BIN" \
        --new-window \
        --user-data-dir="$MAC_CHROME_PROFILE_DIR" \
        --no-first-run \
        --no-default-browser-check \
        --autoplay-policy=no-user-gesture-required \
        --disable-session-crashed-bubble \
        "$APP_URL" >/dev/null 2>&1 &
    else
      "$MAC_CHROME_BIN" \
        --new-window \
        --user-data-dir="$MAC_CHROME_PROFILE_DIR" \
        --no-first-run \
        --no-default-browser-check \
        --autoplay-policy=no-user-gesture-required \
        --disable-session-crashed-bubble \
        "$APP_URL" >/dev/null 2>&1 &
    fi
    browser_pid="$!"
    return 0
  fi

  if [[ -n "${BAUKLANK_BROWSER_CMD:-}" ]]; then
    log "Starting browser via BAUKLANK_BROWSER_CMD"
    if [[ "$USE_PROCESS_GROUPS" == "1" ]]; then
      setsid bash -lc "$BAUKLANK_BROWSER_CMD \"$APP_URL\"" >/dev/null 2>&1 &
    else
      bash -lc "$BAUKLANK_BROWSER_CMD \"$APP_URL\"" >/dev/null 2>&1 &
    fi
    browser_pid="$!"
    return 0
  fi

  if has_cmd open; then
    log "Opening $APP_URL in $BROWSER_APP"
    open -a "$BROWSER_APP" "$APP_URL" >/dev/null 2>&1 || true
    return 0
  fi

  log "WARN: Could not open browser automatically (no 'open' command)"
  log "Manual URL: $APP_URL"
}

# ------- Preconditions -------
[[ -d "$WEB_ROOT" ]] || fail "Web root not found: $WEB_ROOT"
[[ -f "$SCRIPT_DIR/server-multi.py" ]] || fail "Missing file: $SCRIPT_DIR/server-multi.py"
if [[ -x "$PYTHON_BIN" ]]; then
  :
elif has_cmd python3; then
  :
else
  fail "No usable Python found (tried '$PYTHON_BIN' and python3 in PATH)"
fi
if has_cmd setsid; then
  USE_PROCESS_GROUPS="1"
fi

parse_args "$@"

log "BAUKLANK mac launcher starting"
log "Repo dir: $SCRIPT_DIR"
log "App URL:  $APP_URL"
log "Browser mode: $([[ "$BROWSER_KIOSK" == "1" ]] && echo kiosk || echo windowed)"
log "Open browser: $OPEN_BROWSER"
log "setsid available: $([[ "$USE_PROCESS_GROUPS" == "1" ]] && echo yes || echo no)"
log "Python: $([[ -x "$PYTHON_BIN" ]] && echo "$PYTHON_BIN" || echo "python3")"

# ------- Start static web server -------
log "Starting python3 -m http.server on :$WEB_PORT from $WEB_ROOT"
if [[ "$USE_PROCESS_GROUPS" == "1" ]]; then
  setsid "$([[ -x "$PYTHON_BIN" ]] && echo "$PYTHON_BIN" || echo python3)" -m http.server "$WEB_PORT" --directory "$WEB_ROOT" &
else
  "$([[ -x "$PYTHON_BIN" ]] && echo "$PYTHON_BIN" || echo python3)" -m http.server "$WEB_PORT" --directory "$WEB_ROOT" &
fi
http_pid="$!"

wait_for_http "$APP_URL" 30 || fail "Web app did not become reachable at $APP_URL"

# ------- Start BAUKLANK bridge -------
log "Starting server-multi.py (engine-count=$ENGINE_COUNT, slot=$ENGINE_SLOT)"
if [[ "$USE_PROCESS_GROUPS" == "1" ]]; then
  setsid "$([[ -x "$PYTHON_BIN" ]] && echo "$PYTHON_BIN" || echo python3)" "$SCRIPT_DIR/server-multi.py" \
    --engine-count "$ENGINE_COUNT" \
    --slot "$ENGINE_SLOT" \
    --ws-host "$WS_HOST" \
    --ws-port "$WS_PORT" \
    --startup-log-level INFO \
    --run-log-level WARNING &
else
  "$([[ -x "$PYTHON_BIN" ]] && echo "$PYTHON_BIN" || echo python3)" "$SCRIPT_DIR/server-multi.py" \
    --engine-count "$ENGINE_COUNT" \
    --slot "$ENGINE_SLOT" \
    --ws-host "$WS_HOST" \
    --ws-port "$WS_PORT" \
    --startup-log-level INFO \
    --run-log-level WARNING &
fi
bridge_pid="$!"

sleep 0.5
start_browser

log "Stack running. Press Ctrl+C to stop."

while true; do
  sleep 1
  kill -0 "$http_pid" 2>/dev/null || fail "http.server exited unexpectedly"
  kill -0 "$bridge_pid" 2>/dev/null || fail "server-multi.py exited unexpectedly"
done
