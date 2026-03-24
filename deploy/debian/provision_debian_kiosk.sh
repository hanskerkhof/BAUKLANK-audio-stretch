#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# BAUKLANK Debian Kiosk Provisioner
# File: deploy/debian/provision_debian_kiosk.sh
#
# Simple scope (no fancy options):
# 1) Install required packages
# 2) Add pi to required groups
# 3) Ensure repo exists at /home/pi/Public/BAUKLANK-audio-stretch
# 4) Configure LightDM autologin for pi
# 5) Install + enable BAUKLANK user service
#
# Run:
#   sudo ./deploy/debian/provision_debian_kiosk.sh
#
# Re-run for upgrades:
# - If repo exists, it does git pull --ff-only
# - Re-copies service file and restarts service
# ============================================================

PI_USER="pi"
PI_HOME="/home/pi"
REPO_URL="git@github.com:hanskerkhof/BAUKLANK-audio-stretch.git"
REPO_DIR="/home/pi/Public/BAUKLANK-audio-stretch"
SERVICE_NAME="bauklank-kiosk.service"
SERVICE_TEMPLATE_REL="deploy/debian/systemd-user/bauklank-kiosk.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

log() {
  printf '[%s] %s\n' "$(date +'%F %T')" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

require_root() {
  if [[ "$EUID" -ne 0 ]]; then
    fail "Run this script as root (use sudo)."
  fi
}

require_user_exists() {
  if ! id "$PI_USER" >/dev/null 2>&1; then
    fail "User '$PI_USER' does not exist. Create it first in Debian installer."
  fi
}

require_debian() {
  if [[ ! -f /etc/debian_version ]]; then
    fail "This script is for Debian systems."
  fi
}

apt_install_packages() {
  log "Step 1/6: Install required Debian packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y \
    chromium \
    curl \
    firmware-misc-nonfree \
    git \
    htop \
    iotop \
    python3 \
    python3-pip \
    python3-serial \
    python3-websockets \
    unclutter \
    xdotool
}

ensure_groups() {
  log "Step 2/6: Ensure '$PI_USER' is in required groups"
  usermod -aG sudo,audio,video,input,dialout "$PI_USER"
}

configure_passwordless_sudo() {
  log "Step 3/7: Configure passwordless sudo for '$PI_USER'"
  cat >/etc/sudoers.d/90-pi-nopasswd <<'EOF'
pi ALL=(ALL) NOPASSWD:ALL
EOF
  chmod 440 /etc/sudoers.d/90-pi-nopasswd
}

ensure_repo() {
  log "Step 4/7: Ensure BAUKLANK repo is present"
  install -d -m 0755 -o "$PI_USER" -g "$PI_USER" "$PI_HOME/Public"

  if [[ -d "$REPO_DIR/.git" ]]; then
    log "Repo exists: pulling latest"
    runuser -u "$PI_USER" -- git -C "$REPO_DIR" pull --ff-only
  elif [[ -d "$REPO_ROOT/.git" ]]; then
    log "Repo already local here: copying to target path"
    rm -rf "$REPO_DIR"
    cp -a "$REPO_ROOT" "$REPO_DIR"
    chown -R "$PI_USER:$PI_USER" "$REPO_DIR"
  elif [[ -d "$REPO_DIR" ]] && [[ -n "$(ls -A "$REPO_DIR" 2>/dev/null)" ]]; then
    log "Non-git directory already exists at target: bootstrapping repo in place"
    runuser -u "$PI_USER" -- git -C "$REPO_DIR" init
    if runuser -u "$PI_USER" -- git -C "$REPO_DIR" remote get-url origin >/dev/null 2>&1; then
      runuser -u "$PI_USER" -- git -C "$REPO_DIR" remote set-url origin "$REPO_URL"
    else
      runuser -u "$PI_USER" -- git -C "$REPO_DIR" remote add origin "$REPO_URL"
    fi
    runuser -u "$PI_USER" -- git -C "$REPO_DIR" fetch origin
    runuser -u "$PI_USER" -- git -C "$REPO_DIR" checkout -B main origin/main
    runuser -u "$PI_USER" -- git -C "$REPO_DIR" reset --hard origin/main
  else
    log "Cloning repo from GitHub"
    runuser -u "$PI_USER" -- git clone "$REPO_URL" "$REPO_DIR"
  fi
}

configure_lightdm_autologin() {
  log "Step 5/7: Configure LightDM autologin for '$PI_USER'"
  install -d -m 0755 /etc/lightdm/lightdm.conf.d
  cat >/etc/lightdm/lightdm.conf.d/50-bauklank-autologin.conf <<EOF
[Seat:*]
autologin-user=$PI_USER
autologin-user-timeout=0
greeter-hide-users=true
greeter-show-manual-login=false
EOF
}

install_user_service() {
  log "Step 6/7: Install BAUKLANK systemd user service"
  local pi_uid
  pi_uid="$(id -u "$PI_USER")"
  local user_service_dir="$PI_HOME/.config/systemd/user"
  local source_service="$REPO_DIR/$SERVICE_TEMPLATE_REL"
  local target_service="$user_service_dir/$SERVICE_NAME"

  [[ -f "$source_service" ]] || fail "Missing service template: $source_service"

  install -d -m 0755 -o "$PI_USER" -g "$PI_USER" "$user_service_dir"
  cp "$source_service" "$target_service"
  chown "$PI_USER:$PI_USER" "$target_service"
  chmod +x "$REPO_DIR/launch_on_debian.sh"
  chown "$PI_USER:$PI_USER" "$REPO_DIR/launch_on_debian.sh"

  log "Enable lingering for user services"
  loginctl enable-linger "$PI_USER"

  if runuser -u "$PI_USER" -- env XDG_RUNTIME_DIR="/run/user/$pi_uid" systemctl --user daemon-reload; then
    runuser -u "$PI_USER" -- env XDG_RUNTIME_DIR="/run/user/$pi_uid" systemctl --user enable --now "$SERVICE_NAME"
  else
    fail "Could not reach systemctl --user for '$PI_USER'. Log in once as pi and re-run this script."
  fi
}

print_summary() {
  log "Step 7/7: Done"
  cat <<EOF

Provisioning complete.

Configured:
- User: $PI_USER
- Repo: $REPO_DIR
- Service: $SERVICE_NAME (systemd user)
- LightDM autologin: enabled

Next:
1) Reboot: sudo reboot
2) Check service logs:
   journalctl --user -u $SERVICE_NAME -f
EOF
}

main() {
  require_root
  require_debian
  require_user_exists
  apt_install_packages
  ensure_groups
  configure_passwordless_sudo
  ensure_repo
  configure_lightdm_autologin
  install_user_service
  print_summary
}

main "$@"
