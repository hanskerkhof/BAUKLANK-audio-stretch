#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# launch_on_debian.sh
#
# Purpose
# - Launch BAUKLANK kiosk stack on a Debian PC:
#   1) Static web server (python3 -m http.server)
#   2) WebSocket/serial bridge (python3 server-multi.py)
#   3) Chromium kiosk
#   4) Optional: xdotool click to start playback
#
# Behavior
# - Starts each process in its own process group so we can kill cleanly.
# - On exit (Ctrl+C, error), kills all started processes.
#
# Notes
# - Debian Chromium is usually "chromium" (not "chromium-browser").
# - Add --password-store=basic to avoid keyring prompts on autologin systems.
# - Add --disable-gpu for old Intel graphics stability.
# ============================================================

user_name="pi"
user_home="/home/$user_name"

# URL to open in Chromium
# url="http://127.0.0.1:8080/"
url="http://127.0.0.1:8080/index.html?engines=1&slot=A"

# Web root for the static site
web_root="app/multi"
web_port="8080"

# X session (typical for LightDM + XFCE autologin)
export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-$user_home/.Xauthority}"

http_pid=""
py_pid=""
chrome_pid=""

log() {
  local msg="$1"
  echo "[$(date +'%F %T')] $msg"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

kill_process_group() {
  local pid="$1"
  local label="$2"

  if [[ -z "$pid" ]]; then
    return 0
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  log "Stopping $label (pgid: $pid)..."
  # Send SIGTERM to the whole process group
  kill -TERM "-$pid" 2>/dev/null || true

  # Give it a moment, then SIGKILL if needed
  for _ in {1..15}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done

  log "$label did not stop in time, forcing kill (pgid: $pid)..."
  kill -KILL "-$pid" 2>/dev/null || true
}

cleanup() {
  log "Cleanup..."
  kill_process_group "$chrome_pid" "Chromium"
  kill_process_group "$py_pid" "server-multi.py"
  kill_process_group "$http_pid" "python http.server"
  log "Cleanup done."
}
trap cleanup EXIT

# ------------------------------------------------------------
# Checks
# ------------------------------------------------------------
if [[ ! -d "$web_root" ]]; then
  log "ERROR: web_root not found: $web_root"
  exit 1
fi

if ! has_cmd python3; then
  log "ERROR: python3 not found."
  exit 1
fi

if [[ ! -f "server-multi.py" ]]; then
  log "ERROR: server-multi.py not found in current directory. Run from repo root."
  exit 1
fi

if ! has_cmd xdotool; then
  log "WARN: xdotool not found. Auto-click step will be skipped."
fi

chromium_cmd=""
if has_cmd chromium; then
  chromium_cmd="chromium"
elif has_cmd chromium-browser; then
  chromium_cmd="chromium-browser"
else
  log "ERROR: Chromium not found. Install with: sudo apt install chromium"
  exit 1
fi

# systemd-cat is nice, but optional
use_systemd_cat="0"
if has_cmd systemd-cat; then
  use_systemd_cat="1"
fi

# Helper to run commands as pi if script is started as root/systemd
run_as_pi() {
  local cmd="$1"
  if [[ "$(id -un)" == "$user_name" ]]; then
    bash -lc "$cmd"
  else
    sudo -u "$user_name" -H bash -lc "$cmd"
  fi
}

# ------------------------------------------------------------
# Start Python http.server in its own process group
# ------------------------------------------------------------
log "Starting python http.server on port $web_port, serving: $web_root"
http_pid="$(setsid bash -lc "exec python3 -m http.server '$web_port' --directory '$web_root'" >/dev/null 2>&1 & echo \$!)"
log "python http.server pid/pgid: $http_pid"

# ------------------------------------------------------------
# Start server-multi.py in its own process group
# ------------------------------------------------------------
log "Starting server-multi.py"
if [[ "$use_systemd_cat" == "1" ]]; then
  py_pid="$(setsid bash -lc "
    exec python3 server-multi.py \
      --engine-count 1 \
      --slot A \
      --startup-log-level INFO \
      --run-log-level WARNING \
    " > >(systemd-cat -t bauklank-server-multi) 2> >(systemd-cat -t bauklank-server-multi -p warning) & echo \$!)"
else
  py_pid="$(setsid bash -lc "
    exec python3 server-multi.py \
      --engine-count 1 \
      --slot A \
      --startup-log-level INFO \
      --run-log-level WARNING \
    " >/tmp/bauklank-server-multi.log 2>&1 & echo \$!)"
fi
log "server-multi.py pid/pgid: $py_pid"

# Small pause so server-multi can bind sockets
sleep 0.5

# ------------------------------------------------------------
# Start Chromium in its own process group (as pi)
# ------------------------------------------------------------
log "Starting Chromium kiosk at $url"

chrome_pid="$(
  run_as_pi "
    export DISPLAY='$DISPLAY'
    export XAUTHORITY='$XAUTHORITY'

    setsid $chromium_cmd \
      --kiosk \
      --disable-gpu \
      --noerrdialogs \
      --password-store=basic \
      --disk-cache-dir=/run/chromium-cache \
      --user-data-dir

