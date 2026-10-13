#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required. Install Node.js and run this script again." >&2
  exit 1
fi

exec node "$ROOT_DIR/scripts/start-local.mjs" "$@"
