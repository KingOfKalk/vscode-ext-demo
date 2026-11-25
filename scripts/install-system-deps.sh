#!/usr/bin/env bash
# Installs the system packages VS Code needs to run under Xvfb. Debian 13 (trixie) and Ubuntu 26.04,
# as root or with sudo. Does nothing if all packages are there.
# Usage: scripts/install-system-deps.sh [--live]
# --live adds what only the live session needs; CI goes without.
set -euo pipefail

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --live ]; }; then
  echo "usage: $0 [--live]" >&2
  exit 1
fi

packages=(
  ca-certificates
  xvfb
  # Libraries of VS Code (from `ldd`).
  libasound2t64
  libatk-bridge2.0-0t64
  libatk1.0-0t64
  libatspi2.0-0t64
  libcups2t64
  libdbus-1-3
  libgbm1
  libgtk-3-0t64
  libnspr4
  libnss3
  libxcomposite1
  libxdamage1
  libxfixes3
  libxkbcommon0
  libxkbfile1
  libxrandr2
)
if [ "${1:-}" = --live ]; then
  packages+=(
    openbox
    novnc
    websockify
    x11vnc
  )
fi

missing=()
for package in "${packages[@]}"; do
  status="$(dpkg-query --show --showformat='${db:Status-Status}' "$package" 2> /dev/null || true)"
  if [ "$status" != installed ]; then
    missing+=("$package")
  fi
done
if [ "${#missing[@]}" -eq 0 ]; then
  echo "All system packages are installed."
  exit 0
fi

as_root=()
if [ "$(id -u)" -ne 0 ]; then
  as_root=(sudo)
fi
echo "Installing: ${missing[*]}"
"${as_root[@]}" apt-get update
"${as_root[@]}" env DEBIAN_FRONTEND=noninteractive \
  apt-get install --yes --no-install-recommends "${missing[@]}"
