#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js (>= 22) is required on Ubuntu." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  npm ci
fi

npm run build
exec npm start
