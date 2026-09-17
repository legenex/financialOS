#!/usr/bin/env bash
# Installs project-scoped developer tools into .tools/ (ignored by Git).
# Nothing is installed system-wide.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
mkdir -p "$root/.tools/dl"
version="8.30.1"
arch="$(uname -m)"
case "$arch" in
  aarch64|arm64) asset="gitleaks_${version}_linux_arm64.tar.gz" ;;
  x86_64) asset="gitleaks_${version}_linux_x64.tar.gz" ;;
  *) echo "unsupported architecture $arch" >&2; exit 1 ;;
esac
cd "$root/.tools/dl"
curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${version}/${asset}"
curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_checksums.txt"
grep " ${asset}\$" "gitleaks_${version}_checksums.txt" | sha256sum -c -
tar -xzf "$asset" gitleaks
mv gitleaks "$root/.tools/gitleaks"
"$root/.tools/gitleaks" version
