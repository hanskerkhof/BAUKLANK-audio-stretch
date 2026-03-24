#!/usr/bin/env bash
set -euo pipefail

# BAUKLANK audio test launcher
# - Stops kiosk service (if running)
# - Opens tests/audio-test.html in Chromium kiosk mode

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_HTML="${REPO_DIR}/tests/audio-test.html"
PROFILE_DIR="${HOME}/.config/chromium-audio-test"

# Allow running from SSH by defaulting to the main local X session.
export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-${HOME}/.Xauthority}"

if [[ ! -f "${TEST_HTML}" ]]; then
  echo "ERROR: Missing ${TEST_HTML}"
  exit 1
fi

if command -v chromium >/dev/null 2>&1; then
  CHROME_BIN="chromium"
elif command -v chromium-browser >/dev/null 2>&1; then
  CHROME_BIN="chromium-browser"
else
  echo "ERROR: chromium not found."
  exit 1
fi

echo "Stopping BAUKLANK kiosk service (ignore errors if not running)..."
systemctl --user stop bauklank-kiosk.service >/dev/null 2>&1 || true

mkdir -p "${PROFILE_DIR}"

echo "Starting audio test in kiosk mode..."
exec "${CHROME_BIN}" \
  --kiosk \
  --password-store=basic \
  --user-data-dir="${PROFILE_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  --autoplay-policy=no-user-gesture-required \
  "file://${TEST_HTML}"
