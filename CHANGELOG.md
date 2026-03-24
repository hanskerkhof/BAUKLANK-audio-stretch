# Changelog

All notable changes to this project should be documented in this file.

## [Unreleased]

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
