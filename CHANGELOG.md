# Changelog

All notable changes to this project should be documented in this file.

## [Unreleased]

### Added
- Added `launch_on_mac.sh` to run local macOS development stack end-to-end (static web app + `server-multi.py` + browser open) with clean shutdown on Ctrl+C.
- `launch_on_mac.sh` now supports `--kiosk` to launch browser in kiosk mode only when requested.

### Fixed
- Corrected incoming `volume` value interpretation in `app/multi/app.mjs` so integer `0..100` values are treated as percent. This fixes the edge case where value `1` was interpreted as 100% instead of 1%.
- Changed web app startup default channel volume from `10%` to `0%` so playback starts silent until controller values are received.
- Updated static `volumePercent` input defaults in `app/multi/index.html` from `35` to `0` (both channels) to prevent a brief pre-init UI flash at `35` before JS applies runtime values.
- Updated static `pan` input defaults in `app/multi/index.html` to match runtime channel defaults (A=`-1`, B=`1`) so pan no longer flashes at `0` before JS initialization.
- Deferred numeric `volumePercent` and `rate` edits until commit (`Enter`/`blur`) and added focused-input locks so incoming controller updates do not animate/overwrite those fields while typing.
- Set initial/default `rate` to `0.01` and set static rate input defaults in `app/multi/index.html` to `0.01` so startup UI and runtime defaults match.
- Normalized rate UI rendering to `0.001` precision to avoid padded values like `0.0100` while animating.

### Changed
- Added randomized one-time startup input-position offsets in `app/multi/app.mjs`:
  - `CHANNEL_AUDIO_START_INPUT_OFFSET_MIN_MS = 60 * 1000`
  - `CHANNEL_AUDIO_START_INPUT_OFFSET_MAX_MS = 3 * 60 * 1000`
  Each engine now starts playback from a one-time random position offset in that range at boot, without delaying playback start or overriding later scrub/runtime updates.
- Updated volume transition behavior in `app/multi/app.mjs` to use an adaptive ramp for all volume changes (controller + UI): `25ms` for small deltas up to `80ms` for large jumps.
- Updated volume UI painting to animate `volumePercent` controls over the same adaptive fade window, so sliders/numeric inputs visually ramp instead of jumping to target values.
- Applied the same adaptive transition behavior to `rate` changes (controller + UI), including visual ramping of rate controls instead of instant jumps.
- Increased adaptive `rate` ramp window to `800ms`–`1600ms` for clearer controller fade testing.
- Fixed volume slider click behavior so `volumePercent` controls animate gradually on every volume update (not only on throttled UI repaint), matching numeric-field fade behavior.
- Fixed range-input interaction handling for `volumePercent` and `rate` to distinguish click-jump vs drag, so click-on-track now animates while drag remains responsive.
- Added a short local-input priority window for `rate` (`UI_RATE_OVERRIDE_MS=1500`) so manual UI rate adjustments are not immediately overwritten by incoming controller rate messages.
- Fixed `rate` numeric input editing so typed values commit on `change` (not per keystroke), preventing animation updates from interfering with text entry.
- Fixed a scope regression in adaptive `rate` ramping (`controlsChanged` reference), restoring rate slider drag/click and numeric rate input behavior.
- Enforced a hard minimum `rate` floor of `0.0001` across UI and scheduler paths (`app/multi/app.mjs`) and aligned all multi-app rate inputs to `min=0.0001` with `step=0.0001` to prevent zero/near-zero stall values.
- Retuned adaptive fade ranges for balanced responsiveness: volume `120ms`–`240ms` and rate `120ms`–`240ms` (replacing long test-only ranges).
- Raised the hard minimum `rate` floor to `0.01` (scheduler + UI inputs) to ensure audible progression at minimum speed.
- Increased adaptive `rate` ramp range by `+40ms` to `160ms`–`280ms` for slightly more perceptible rate fades while keeping volume ramp unchanged.
- `launch_on_debian.sh` now supports `BAUKLANK_CHROMIUM_WINDOW_MODE` to choose Chromium startup mode per machine:
  - `kiosk` (existing behavior)
  - `app` / `fullscreen-app` (fullscreen app window)
  - `window` / `normal` (regular browser window)
- Updated `README.md` with a dedicated Debian **Kiosk Update (Pull Latest Main)** copy/paste command block to standardize kiosk syncs that discard unintended local edits before fast-forward pulling `origin/main`.
- Debian kiosk audio hardening:
  - `launch_on_debian.sh` now enforces sink port (`analog-output-headphones` by default), unmute, and volume at startup.
  - `deploy/debian/provision_debian_kiosk.sh` now disables HDA power save and Pulse `module-suspend-on-idle`, and updates the audio defaults helper to force headphone sink port.
- Debian display hardening for installations:
  - `launch_on_debian.sh` now runs a display keepalive (`xset s off -dpms s noblank`) at startup and periodically.
  - `deploy/debian/provision_debian_kiosk.sh` now writes `/etc/X11/xorg.conf.d/10-bauklank-no-dpms.conf` to force no blanking/DPMS at Xorg level.
- Removed outdated `npx http-server` launch references from `README.md` and aligned examples on `python3 -m http.server`.

### Removed
- Deleted legacy/backup files that are no longer part of the active runtime flow:
  - `_OLD__kiosk_and_click.sh`
  - `server-multi-for-2-controllers_OLD.py`
  - `server-multi_v2.14.1.py`
  - `server-multi_v2.15.0.py`
  - `server-multi_v2.15.1.py`
  - `server-multi_v2.15.2.py`
  - `mac_cliclick.sh`
- Removed obsolete Raspberry Pi–specific runtime/docs references:
  - deleted `launch_on_pi.sh`
  - deleted `README-pi-file-system.md`
  - deleted `README-pi-file-system-brief.md`
  - replaced `README.md` content with current Debian kiosk + macOS dev workflows
  - updated `README-signalsmith.md` wording to generic kiosk hardware terminology
- Removed bundled `PT Sans` font-face usage from `app/multi/dist.css` and switched those selectors to system sans fallbacks to eliminate repeated `fonts/pt-sans...` 404 requests.

### Versioning
- Bumped frontend version in `version.json` to `2.15.14`.

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
