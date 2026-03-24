# AGENTS.md

## BAUKLANK Audio Stretch - Working Notes for Agents

This repo now has a reproducible Debian kiosk flow for Dell OptiPlex class machines.
Use these conventions when assisting.

### Canonical Debian flow
- Provision script: `/home/pi/Public/BAUKLANK-audio-stretch/deploy/debian/provision_debian_kiosk.sh`
- Kiosk runtime launcher: `/home/pi/Public/BAUKLANK-audio-stretch/launch_on_debian.sh`
- Kiosk user service template: `deploy/debian/systemd-user/bauklank-kiosk.service`
- Audio test launcher: `/home/pi/Public/BAUKLANK-audio-stretch/tests/audio-test.sh`

### Defaults we validated
- User: `pi`
- Repo path: `/home/pi/Public/BAUKLANK-audio-stretch`
- Hostnames: `bauklank-kiosk-01`, `bauklank-kiosk-02`
- Service mode: `systemd --user` (not system-wide X service)
- Engine default: `2`
- App URL default: `http://127.0.0.1:8080/index.html?engines=2`

### Important operational lessons
- Use absolute paths in operator commands.
- First bootstrap on a fresh machine is:
  1) install `git` (`sudo apt update && sudo apt install -y git`)
  2) clone repo into `/home/pi/Public`
  3) run provision script once with sudo password
- Script now enables passwordless sudo for `pi` to make reruns/maintenance easy.
- Avahi (`.local`) works when `avahi-daemon` is active; host key collisions can still happen after switching from IP to `.local`.
- Locale warnings from SSH were fixed by generating `en_US.UTF-8` and restricting SSH `AcceptEnv` to `LANG`.
- XFCE screen blanking/locking is disabled by the provision script.
- `tests/audio-test.sh` is SSH-friendly (`DISPLAY=:0`, `XAUTHORITY=/home/pi/.Xauthority`) and stops kiosk service before launching test audio.

### Validation commands
- Service status:
  - `systemctl --user status bauklank-kiosk.service --no-pager`
- Service logs:
  - `journalctl --user -u bauklank-kiosk.service -n 100 --no-pager`
- Local app check:
  - `curl -I 'http://127.0.0.1:8080/index.html?engines=2'`
- Audio device check:
  - `aplay -l`
  - `pactl info | grep 'Default Sink'`

### Security note
Do not document or recommend weak/default passwords. Use strong unique credentials per machine.
