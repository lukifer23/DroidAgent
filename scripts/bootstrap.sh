#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required but was not found on PATH."
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required for the macOS runtime install path."
  exit 1
fi

pnpm install
pnpm --filter @droidagent/shared build
pnpm build

if command -v ollama >/dev/null 2>&1; then
  brew services start ollama >/dev/null 2>&1 || true
fi

echo "Starting DroidAgent on http://127.0.0.1:4318"
node apps/server/dist/index.js &
SERVER_PID=$!

sleep 2
open http://127.0.0.1:4318 || true
wait "$SERVER_PID"

