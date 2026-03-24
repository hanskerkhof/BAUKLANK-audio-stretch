# BAUKLANK Debian Kiosk Setup

This is the canonical setup for BAUKLANK on Debian 13 XFCE kiosk machines.

Validated target profile:
- Dell OptiPlex 7070 Micro
- Debian 13 (UEFI)
- user: `pi`
- repo path: `/home/pi/Public/BAUKLANK-audio-stretch`

## 1) Installer choices

In Debian installer:
- Hostname: `bauklank-kiosk-01` (or `bauklank-kiosk-02`)
- Domain: leave empty
- User: `pi`
- Partitioning: Guided, entire disk, all files in one partition
- Software selection: `XFCE`, `SSH server`, `standard system utilities`

## 2) First machine bootstrap

On the Debian machine:

```bash
mkdir -p /home/pi/Public
cd /home/pi/Public
git clone git@github.com:hanskerkhof/BAUKLANK-audio-stretch.git
sudo /home/pi/Public/BAUKLANK-audio-stretch/deploy/debian/provision_debian_kiosk.sh
```

Then reboot:

```bash
sudo reboot
```

## 3) What the provision script configures

Script:
- `deploy/debian/provision_debian_kiosk.sh`

It configures:
- Required packages (`chromium`, `curl`, Python deps, tools)
- `pi` groups: `sudo,audio,video,input,dialout`
- Locale fix (`en_US.UTF-8`) and SSH locale warning mitigation
- Passwordless sudo for `pi`
- XFCE screen blanking/locking disabled
- LightDM autologin for `pi`
- BAUKLANK user service install + enable (`bauklank-kiosk.service`)

## 4) Service defaults

User service file:
- `deploy/debian/systemd-user/bauklank-kiosk.service`

Default startup:
- `BAUKLANK_ENGINE_COUNT=2`
- `BAUKLANK_APP_URL=http://127.0.0.1:8080/index.html?engines=2`

## 5) Validation commands

```bash
systemctl --user status bauklank-kiosk.service --no-pager
journalctl --user -u bauklank-kiosk.service -n 100 --no-pager
curl -I 'http://127.0.0.1:8080/index.html?engines=2'
```

Audio checks:

```bash
aplay -l
pactl info | grep 'Default Sink'
```

## 6) Audio test page (no controller required)

Run:

```bash
/home/pi/Public/BAUKLANK-audio-stretch/tests/audio-test.sh
```

This script:
- stops kiosk service
- launches Chromium in kiosk mode
- opens `tests/audio-test.html`
- plays `tests/00001 - you-should-be-hearing-this.mp3`

## 7) Avahi / domain name

If Avahi is active, host should be reachable as:
- `bauklank-kiosk-01.local`
- `bauklank-kiosk-02.local`

Check:

```bash
systemctl is-active avahi-daemon
```

From macOS, if SSH host-key warning appears after switching from IP to `.local`:

```bash
ssh-keygen -R bauklank-kiosk-01.local
ssh-keygen -R 192.168.68.58
```

## 8) Operational commands

Stop/start kiosk service:

```bash
systemctl --user stop bauklank-kiosk.service
systemctl --user start bauklank-kiosk.service
systemctl --user restart bauklank-kiosk.service
```

## 9) Notes

- Use full absolute paths in operator instructions.
- Do not use weak/default passwords in documentation or deployment.
