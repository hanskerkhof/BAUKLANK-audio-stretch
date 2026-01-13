#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Kiosk stack launcher:
# 1) Web server (Python http.server)
# 2) WebSocket/serial bridge (python3 server-multi.py)
# 3) Chromium kiosk + click play
#
# All processes are killed when this script exits.
#
#
# ============================================================

user_name="pi"
user_home="/home/$user_name"
#url="http://127.0.0.1:8080/"  # default to ...
url="http://127.0.0.1:8080/index.html?engines=1&slot=A"

# Web root for the static site
web_root="app/multi"
web_port="8080"

export DISPLAY=:0
export XAUTHORITY="$user_home/.Xauthority"

http_pid=""
py_pid=""
chrome_pid=""

log() { echo "[$(date +'%H:%M:%S')] $*"; }

# Kill a process group (negative PID).
# This works well when each service is started with setsid (new session == new process group).
kill_process_group() {
  local pid="$1"
  local name="$2"

  [[ -z "$pid" ]] && return 0
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  log "Stopping $name (pgid=$pid)..."
  kill -TERM "-$pid" 2>/dev/null || true

  # Give it a moment to exit gracefully
  for _ in {1..30}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      log "$name stopped."
      return 0
    fi
    sleep 0.1
  done

  log "$name did not stop gracefully; force killing..."
  kill -KILL "-$pid" 2>/dev/null || true
}

cleanup() {
  log "Cleanup triggered."

  # Stop in reverse order (UI last started -> stop first)
  kill_process_group "$chrome_pid" "Chromium"
  kill_process_group "$py_pid"     "server-multi.py"
  kill_process_group "$http_pid"   "python http.server"

  log "Cleanup done."
}

trap cleanup EXIT INT TERM

# ------------------------------------------------------------
# Start Python static web server in background (own process group)
# ------------------------------------------------------------
log "Starting Python http.server on port $web_port, serving: $web_root"
http_pid="$(setsid bash -lc "exec python3 -m http.server '$web_port' --directory '$web_root'" >/dev/null 2>&1 & echo $!)"
log "python http.server pid/pgid: $http_pid"

# Wait until the web server responds
log "Waiting for web server at $url ..."
for _ in {1..80}; do
  if curl -fsS "$url" >/dev/null 2>&1; then
    log "Web server is up."
    break
  fi
  sleep 0.25
done

# ------------------------------------------------------------
# Start python websocket/serial bridge in background (own process group)
# ------------------------------------------------------------
log "Starting server-multi.py"
# NOTE start with --engine-count 1 --slot A to start only one engine
#      start with --engine-count 2 --slot A,B to start two engines
py_pid="$(setsid bash -lc "exec python3 server-multi.py --engine-count 1 --slot A --startup-log-level INFO --run-log-level WARNING" & echo $!)"

log "server-multi.py pid/pgid: $py_pid"

# Optional: small pause so server-multi.py can bind the port
sleep 0.5

# ------------------------------------------------------------
# Start Chromium as desktop user, in its own process group
# ------------------------------------------------------------
log "Starting Chromium kiosk at $url"
chrome_pid="$(sudo -u "$user_name" -H bash -lc "
  export DISPLAY=:0
  export XAUTHORITY='$user_home/.XAUTHORITY'
  # NOTE: keep correct case below (your original was .Xauthority). Use that:
  export XAUTHORITY='$user_home/.Xauthority'

#  setsid chromium-browser \
#    --kiosk \
#    --disk-cache-dir=/run/chromium-cache \
#    --no-default-browser-check \
#    --user-data-dir=/home/pi/.config/chromium-kiosk \
#    --no-first-run \
#    --disable-infobars \
#    --disable-session-crashed-bubble \
#    --autoplay-policy=no-user-gesture-required \
#    # ---- Reduce background writes / network noise (kiosk/offline friendly)
#    --disable-background-networking \
#    --disable-component-update \
#    --disable-domain-reliability \
#    --disable-sync \
#    --disable-default-apps \
#    --disable-pings \
#    --metrics-recording-only \
#    --disable-crash-reporter \
#    --disable-breakpad \
#    --disable-features=Translate,MediaRouter \
#    \
#    '$url' >/dev/null 2>&1 &

setsid chromium-browser \
  --kiosk \
  --disk-cache-dir=/run/chromium-cache \
  --user-data-dir=/home/pi/.config/chromium-kiosk \
  --no-first-run \
  --no-default-browser-check \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --autoplay-policy=no-user-gesture-required \
  --disable-background-networking \
  --disable-component-update \
  --disable-domain-reliability \
  --disable-sync \
  --disable-default-apps \
  --disable-pings \
  --metrics-recording-only \
  --disable-crash-reporter \
  --disable-breakpad \
  --disable-notifications \
  --disable-features=Translate,MediaRouter,PushMessaging \
  "$url" >/dev/null 2>&1 &

  echo \$!
")"
log "Chromium pid/pgid: $chrome_pid"

# Give Chromium time to create a window
sleep 9

# ------------------------------------------------------------
# Focus window and click Play
# ------------------------------------------------------------
log "Waiting for Chromium window..."
win_id=""
for _ in {1..40}; do
  win_id="$(xdotool search --onlyvisible --class chromium | tail -n 1 || true)"
  [[ -n "$win_id" ]] && break
  sleep 0.5
done

if [[ -n "$win_id" ]]; then
  log "Activating Chromium window: $win_id"
  xdotool windowactivate --sync "$win_id"
else
  log "WARNING: No Chromium window found (skipping click)."
fi

#echo "Waiting 10 seconds for page to load..."
#sleep 10
# Wait shorter when booting from SSD drive
echo "Waiting 3 seconds for page to load..."
sleep 3

log "Click play skippep"
xdotool mousemove --sync 30 30
xdotool click 1

# ------------------------------------------------------------
# Keep script alive until stopped (Ctrl+C)
# ------------------------------------------------------------
log "Kiosk stack running. Press Ctrl+C to stop."
while true; do
  sleep 1
done

