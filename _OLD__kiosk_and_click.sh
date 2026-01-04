#!/usr/bin/env bash
set -euo pipefail

user_name="pi"
user_home="/home/$user_name"
url="http://127.0.0.1:8080/"

export DISPLAY=:0
export XAUTHORITY="$user_home/.Xauthority"

chrome_pid=""

cleanup() {
  # Try graceful close first
  if [[ -n "${chrome_pid}" ]] && kill -0 "${chrome_pid}" 2>/dev/null; then
    # Kill the whole process group (Chromium spawns children)
    kill -TERM "-${chrome_pid}" 2>/dev/null || true
    sleep 1
    kill -KILL "-${chrome_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Start Chromium as the desktop user, in its own process group, and print its PID
chrome_pid="$(sudo -u "$user_name" -H bash -lc "
  export DISPLAY=:0
  export XAUTHORITY='$user_home/.Xauthority'
  setsid chromium-browser \
    --kiosk \
    --no-first-run \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --autoplay-policy=no-user-gesture-required \
    '$url' >/dev/null 2>&1 &

  echo \$!
")"

  sleep 9

# Wait until Chromium window exists
win_id=""
for _ in {1..40}; do
  win_id="$(xdotool search --onlyvisible --class chromium | tail -n 1 || true)"
  [[ -n "$win_id" ]] && break
  sleep 0.5
  echo "sleep"
done

if [[ -n "$win_id" ]]; then
  xdotool windowactivate --sync "$win_id"
fi

# Click play
echo "click play"
xdotool mousemove --sync 30 30
# xdotool mousemove --sync 30 190
xdotool click 1

# Keep script alive until you stop it (Ctrl+C)
# (When you stop it, trap will close Chromium.)
while true; do
  sleep 1
done
