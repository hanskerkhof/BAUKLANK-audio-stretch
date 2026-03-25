# Changelog

All notable changes to this project should be documented in this file.

## [Unreleased]

### Fixed
- Corrected incoming `volume` value interpretation in `app/multi/app.mjs` so integer `0..100` values are treated as percent. This fixes the edge case where value `1` was interpreted as 100% instead of 1%.

### Changed
- Added randomized one-time startup input-position offsets in `app/multi/app.mjs`:
  - `CHANNEL_AUDIO_START_INPUT_OFFSET_MIN_MS = 60 * 1000`
  - `CHANNEL_AUDIO_START_INPUT_OFFSET_MAX_MS = 3 * 60 * 1000`
  Each engine now starts playback from a one-time random position offset in that range at boot, without delaying playback start or overriding later scrub/runtime updates.
- Debian kiosk audio hardening:
  - `launch_on_debian.sh` now enforces sink port (`analog-output-headphones` by default), unmute, and volume at startup.
  - `deploy/debian/provision_debian_kiosk.sh` now disables HDA power save and Pulse `module-suspend-on-idle`, and updates the audio defaults helper to force headphone sink port.

## [2026-03-24]

### Added
- Debian provisioning script: `deploy/debian/provision_debian_kiosk.sh`.
- Audio test assets and launcher:
  - `tests/audio-test.html`
  - `tests/audio-test.sh`
  - `tests/00001 - you-should-be-hearing-this.mp3`
- Agent runbook file: `AGENTS.md`.

### Changed
- Debian kiosk service template defaults to 2-engine startup:
  - `BAUKLANK_ENGINE_COUNT=2`
  - `BAUKLANK_APP_URL=http://127.0.0.1:8080/index.html?engines=2`
- Provision script improvements:
  - handles non-git bootstrap path
  - installs `curl`
  - enables passwordless sudo for `pi`
  - configures locale (`en_US.UTF-8`) and SSH `AcceptEnv LANG`
  - disables XFCE screen blanking/locking
- Documentation refresh for canonical Debian kiosk flow and SSH key setup (`ssh-copy-id`).

### Fixed
- Resolved merge conflict markers in `app/multi/app.mjs`.
- Made `tests/audio-test.sh` SSH-friendly by defaulting to desktop X session:
  - `DISPLAY=:0`
  - `XAUTHORITY=/home/pi/.Xauthority`
