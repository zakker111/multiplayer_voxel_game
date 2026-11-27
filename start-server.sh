#!/usr/bin/env sh
# One-click local server for Linux/macOS:  ./start-server.sh [port] [--rebuild]
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 18 or newer from https://nodejs.org, then run this again."
  exit 1
fi

exec node scripts/start-local.mjs "$@"
