#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

RED="\033[0;31m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
NC="\033[0m"

log_ok() { echo "${GREEN}[OK]${NC} $*"; }
log_warn() { echo "${YELLOW}[WARN]${NC} $*"; }
log_err() { echo "${RED}[ERR]${NC} $*" >&2; }
log_step() { echo "\n${GREEN}==>${NC} $*"; }

die() {
  log_err "$1"
  echo ""
  echo "Recovery: $2"
  exit 1
}

log_step "DroidAgent bootstrap"
echo ""

log_step "Preflight checks"
echo ""

if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed." "Install Node 22+ via Homebrew: brew install node"
fi

NODE_MAJOR=$(node -e "console.log(parseInt(process.versions.node.split('.')[0], 10))")
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  die "Node.js 22+ required (found v$(node -v))." "Upgrade: brew upgrade node"
fi
log_ok "Node.js $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  die "pnpm is not installed." "Install: npm install -g pnpm"
fi
log_ok "pnpm $(pnpm -v)"

if ! command -v brew >/dev/null 2>&1; then
  die "Homebrew is required for the macOS runtime path." "Install: https://brew.sh"
fi
log_ok "Homebrew"

log_step "Installing dependencies"
echo ""

pnpm install || die "pnpm install failed." "Check network and run: pnpm install"

if [[ -d apps/server/node_modules/better-sqlite3 ]]; then
  (cd apps/server && npm explore better-sqlite3 -- npm run build-release 2>/dev/null) || {
    log_warn "better-sqlite3 native build had issues; continuing."
  }
fi
log_ok "Dependencies installed"

log_step "Building workspace"
echo ""

pnpm --filter @droidagent/shared build || die "Shared package build failed." "Run: pnpm --filter @droidagent/shared build"
pnpm build || die "Build failed." "Run: pnpm build"
log_ok "Build complete"

log_step "Preparing app directories"
echo ""

APP_DIR="${HOME}/.droidagent"
for d in "$APP_DIR" "$APP_DIR/logs" "$APP_DIR/logs/jobs" "$APP_DIR/tmp" "$APP_DIR/state" "$APP_DIR/uploads"; do
  mkdir -p "$d"
done
log_ok "App directories ready"

log_step "Runtime (optional)"
echo ""

if command -v ollama >/dev/null 2>&1; then
  brew services start ollama 2>/dev/null || true
  log_ok "Ollama service started (or already running)"
else
  log_warn "Ollama not installed. To add: brew install ollama && brew services start ollama"
fi

log_step "Starting DroidAgent"
echo ""

if [[ ! -f apps/server/dist/index.js ]]; then
  die "Server build artifact missing." "Run: pnpm build"
fi

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

node apps/server/dist/index.js &
SERVER_PID=$!

for i in {1..10}; do
  if curl -sf "http://localhost:4318/api/health" >/dev/null 2>&1; then
    log_ok "Server ready at http://localhost:4318"
    break
  fi
  if [[ $i -eq 10 ]]; then
    die "Server did not become ready." "Check ~/.droidagent/logs for errors"
  fi
  sleep 1
done

echo ""
echo "${GREEN}DroidAgent is running.${NC} Open http://localhost:4318 in your browser."
echo ""
open "http://localhost:4318" 2>/dev/null || echo "Open manually: http://localhost:4318"
echo ""

wait "$SERVER_PID" 2>/dev/null || true
