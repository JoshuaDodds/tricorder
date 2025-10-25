#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "[seeed-voicecard] This installer must be run as root." >&2
  exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ARCH=$(uname -m)
if [[ "$ARCH" != "aarch64" && "$ARCH" != "arm64" ]]; then
  echo "[seeed-voicecard] Non-ARM architecture ($ARCH) detected; skipping hardware install." >&2
  exit 0
fi

say() {
  echo "[seeed-voicecard] $*"
}

TARGET_KERNEL="6.8.0-1040-raspi"
KERNEL_DIR="$SCRIPT_DIR/kernel-6.8.0-1040"
KERNEL_IMAGE="$KERNEL_DIR/linux-image-6.8.0-1040-raspi_6.8.0-1040.44_arm64.deb"
KERNEL_HEADERS="$KERNEL_DIR/linux-headers-6.8.0-1040-raspi_6.8.0-1040.44_arm64.deb"
KERNEL_MODULES="$KERNEL_DIR/linux-modules-6.8.0-1040-raspi_6.8.0-1040.44_arm64.deb"
MODULE_ARCHIVE="$SCRIPT_DIR/snd-soc-tlv320aic3x-i2c.ko.tar.gz"
OVERLAY_SRC="$SCRIPT_DIR/respeaker-2mic-v2_0-overlay.dtbo"
ASOUND_STATE="$SCRIPT_DIR/asound.state"

require_files() {
  local missing=0
  for f in "$KERNEL_IMAGE" "$KERNEL_HEADERS" "$KERNEL_MODULES" "$MODULE_ARCHIVE" "$OVERLAY_SRC" "$ASOUND_STATE"; do
    if [[ ! -f "$f" ]]; then
      echo "[seeed-voicecard] Missing required asset: $f" >&2
      missing=1
    fi
  done
  if ((missing)); then
    echo "[seeed-voicecard] Cannot continue without bundled assets. Populate drivers/seeed-voicecard/ with production binaries before running." >&2
    exit 1
  fi
}

ensure_packages() {
  local packages=(i2c-tools libasound2-plugins alsa-utils dkms build-essential)
  local missing=()
  for pkg in "${packages[@]}"; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
      missing+=("$pkg")
    fi
  done
  if ((${#missing[@]})); then
    say "Installing APT dependencies: ${missing[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  else
    say "APT dependencies already satisfied"
  fi
}

ensure_kernel() {
  local to_install=()
  if ! dpkg -s "linux-modules-$TARGET_KERNEL" >/dev/null 2>&1; then
    to_install+=("$KERNEL_MODULES")
  fi
  if ! dpkg -s "linux-image-$TARGET_KERNEL" >/dev/null 2>&1; then
    to_install+=("$KERNEL_IMAGE")
  fi
  if ! dpkg -s "linux-headers-$TARGET_KERNEL" >/dev/null 2>&1; then
    to_install+=("$KERNEL_HEADERS")
  fi
  if ((${#to_install[@]})); then
    say "Installing kernel packages from bundle"
    dpkg -i "${to_install[@]}"
  else
    say "Target kernel packages already installed"
  fi
  local running_kernel
  running_kernel=$(uname -r)
  if [[ "$running_kernel" != "$TARGET_KERNEL" ]]; then
    say "Active kernel ($running_kernel) differs from target ($TARGET_KERNEL). A reboot will be required."
  else
    say "Target kernel already active"
  fi
}

deploy_module() {
  local module_dir="/lib/modules/$TARGET_KERNEL/updates/seeed-voicecard"
  mkdir -p "$module_dir"
  tar -xzf "$MODULE_ARCHIVE" -C "$module_dir"
  depmod "$TARGET_KERNEL"
  say "Deployed tlv320aic3x I2C codec module"
}

install_overlay() {
  local overlay_dir="/boot/firmware/overlays"
  mkdir -p "$overlay_dir"
  install -m 0644 "$OVERLAY_SRC" "$overlay_dir/respeaker-2mic-v2_0-overlay.dtbo"
  local config="/boot/firmware/config.txt"
  touch "$config"
  if ! grep -q '^dtoverlay=respeaker-2mic-v2_0-overlay' "$config"; then
    {
      echo ""
      echo "# Added by Tricorder ReSpeaker installer"
      echo "dtoverlay=respeaker-2mic-v2_0-overlay"
    } >> "$config"
    say "Appended overlay entry to $config"
  else
    say "Overlay entry already present in $config"
  fi
}

restore_alsa() {
  install -d -m 0755 /var/lib/alsa
  install -m 0644 "$ASOUND_STATE" /var/lib/alsa/asound.state
  if command -v alsactl >/dev/null 2>&1; then
    say "Restoring ALSA mixer baseline"
    alsactl --file "$ASOUND_STATE" restore
    alsactl store
  else
    say "alsactl not found; skipping restore"
  fi
}

require_files
ensure_packages
ensure_kernel
deploy_module
install_overlay
restore_alsa

say "Hardware install complete. Reboot required for kernel/overlay changes to take effect."
