#!/usr/bin/env bash
# Pluck for a container host (Codespaces, Fly.io, Railway, Koyeb, Docker Compose).
# Assumes the image is Debian/Ubuntu with Node 22+, ffmpeg and Chrome already installed —
# see deploy/Dockerfile for that half.
set -euo pipefail
cd "$(dirname "$0")/.."

export PLUCK_PASSWORD="${PLUCK_PASSWORD:?set PLUCK_PASSWORD before exposing Pluck}"
export PLUCK_NO_SANDBOX="${PLUCK_NO_SANDBOX:-1}"
export PLUCK_HEADFUL="${PLUCK_HEADFUL:-0}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-7777}"

echo "Pluck: http://${HOST}:${PORT} (sessions=${PLUCK_MAX_SESSIONS:-3})"
exec node server/index.js
