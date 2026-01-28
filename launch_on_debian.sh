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
# Notes
# - Debian Chromium binary is usually "chromium".
# - Add --password-store=basic to avoid keyring prompts.
# - Add --disable-gpu for old Intel graphics stability.
# ============================================================

user_name="pi"
user_home="/home/$user_name"

# URL to open in Chromium
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

  if [[ -z "${pid:-}" ]]; then
    return 0
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  log "Stopping $label (pgid: $pid)..."
  kill -TERM "-$pid" 2>/dev/null || true

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

use_systemd_cat="0"
if has_cmd systemd-cat; then
  use_systemd_cat="1"
fi

# Helper: run a script as pi if invoked from root/systemd
run_script_as_pi() {
  local script_path="$1"
  if [[ "$(id -un)" == "$user_name" ]]; then
    bash "$script_path"
  else
    sudo -u "$user_name" -H bash "$script_path"
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
# Adjust flags here if your server-multi.py differs.
# ------------------------------------------------------------
log "Starting server-multi.py"
if [[ "$use_systemd_cat" == "1" ]]; then
  py_pid="$(setsid bash -lc "exec python3 server-multi.py --startup-log-level INFO --run-log-level WARNING --engine-count 1" \
    > >(systemd-cat -t bauklank-server-multi) 2> >(systemd-cat -t bauklank-server-multi -p warning) & echo \$!)"
else
  py_pid="$(setsid bash -lc "exec python3 server-multi.py --startup-log-level INFO --run-log-level WARNING --engine-count 1" \
    >/tmp/bauklank-server-multi.log 2>&1 & echo \$!)"
fi
log "server-multi.py pid/pgid: $py_pid"

sleep 0.5

# ------------------------------------------------------------
# Start Chromium in its own process group (as pi), with robust quoting
# ------------------------------------------------------------
log "Starting Chromium kiosk at $url"

tmp_script="$(mktemp)"
cat >"$tmp_script" <<EOF
#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY}"
export XAUTHORITY="${XAUTHORITY}"

mkdir -p /run/chromium-cache 2>/dev/null || true

setsid "${chromium_cmd}" \\
#  --kiosk \\
  --disable-gpu \\
  --noerrdialogs \\
  --password-store=basic \\
  --disk-cache-dir=/run/chromium-cache \\
  --user-data-dir="${user_home}/.config/chromium-kiosk" \\
  --no-first-run \\
  --no-default-browser-check \\
  --disable-infobars \\
  --disable-session-crashed-bubble \\
  --autoplay-policy=no-user-gesture-required \\
  --disable-background-networking \\
  --disable-component-update \\
  --disable-domain-reliability \\
  --disable-sync \\
  --disable-default-apps \\
  --disable-pings \\
  --metrics-recording-only \\
  --disable-crash-reporter \\
  --disable-breakpad \\
  --disable-notifications \\
  --disable-features=Translate,MediaRouter,PushMessaging \\
  "${url}" >/dev/null 2>&1 &

echo \$!
EOF
chmod +x "$tmp_script"

chrome_pid="$(run_script_as_pi "$tmp_script")"
rm -f "$tmp_script"

log "Chromium pid/pgid: $chrome_pid"

# Give Chromium time to create a window on slow hardware
sleep 12

# ------------------------------------------------------------
# Focus window and click (optional)
# ------------------------------------------------------------
if has_cmd xdotool; then
  log "Waiting for Chromium window..."
  win_id=""
  for _ in {1..80}; do
    win_id="$(xdotool search --onlyvisible --class chromium | tail -n 1 || true)"
    if [[ -n "$win_id" ]]; then
      break
    fi
    sleep 0.25
  done

  if [[ -n "$win_id" ]]; then
    log "Found Chromium window: $win_id, activating..."
    xdotool windowactivate --sync "$win_id" || true
    sleep 1
    log "Click play"
    xdotool mousemove --sync 30 30
    xdotool click 1
  else
    log "WARN: Chromium window not found, skipping auto-click."
  fi
fi

# ------------------------------------------------------------
# Keep script alive until stopped (Ctrl+C)
# ------------------------------------------------------------
log "Kiosk stack running. Press Ctrl+C to stop."
while true; do
  sleep 1
done
