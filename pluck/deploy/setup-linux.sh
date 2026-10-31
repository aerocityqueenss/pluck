#!/usr/bin/env bash
# Pluck bootstrap for a fresh Ubuntu/Debian box: a Codespace, a VPS, or WSL.
# Installs what Pluck cannot bundle (Chrome, ffmpeg), then runs it with a password.
#
#   bash deploy/setup-linux.sh              # generate a password, print it, run
#   PLUCK_PASSWORD=hunter2 bash deploy/setup-linux.sh
#   PORT=8080 bash deploy/setup-linux.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Pluck setup: $(node -v 2>/dev/null || echo 'node missing')"

if ! command -v node >/dev/null 2>&1; then
  echo "Node is not installed. Install Node 22+ first (https://nodejs.org), then re-run." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node 22+ required, found $(node -v)." >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Installing ffmpeg..."
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq ffmpeg
fi

if [ -z "${PLUCK_CHROME:-}" ] && ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
  echo "Installing Google Chrome..."
  tmp_deb="$(mktemp -d)/chrome.deb"
  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$tmp_deb"
  $SUDO apt-get install -y -qq "$tmp_deb"
  rm -f "$tmp_deb"
fi

if [ -z "${PLUCK_PASSWORD:-}" ]; then
  PLUCK_PASSWORD="$(node -e 'process.stdout.write(require("crypto").randomBytes(12).toString("base64url"))')"
  echo
  echo "  Password generated for this run: $PLUCK_PASSWORD"
  echo "  Set PLUCK_PASSWORD yourself to keep it between restarts."
  echo
fi
export PLUCK_PASSWORD

# Chrome usually cannot sandbox itself inside a container or under root; on a normal VPS
# with an unprivileged user this stays off.
if [ "$(id -u)" -eq 0 ] && [ -z "${PLUCK_NO_SANDBOX:-}" ]; then
  export PLUCK_NO_SANDBOX=1
  echo "Running as root: Chrome will start with --no-sandbox."
fi

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-7777}"

echo "Starting Pluck on http://${HOST}:${PORT}"
exec node server/index.js
