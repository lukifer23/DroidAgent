#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

APP_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('./package.json', 'utf8')).version")"
SERVER_URL="http://localhost:4318"
APP_DIR="${HOME}/.droidagent"
LAUNCH_AGENT_LABEL="com.droidagent.server"
LAUNCH_AGENT_PLIST="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
BOOTSTRAP_SERVER_LOG="${APP_DIR}/logs/bootstrap-server.log"

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

server_ready() {
  curl -sf "${SERVER_URL}/api/health" >/dev/null 2>&1
}

wait_for_server() {
  for i in {1..20}; do
    if server_ready; then
      return 0
    fi
    sleep 1
  done
  return 1
}

log_step "DroidAgent bootstrap v${APP_VERSION}"
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

for d in "$APP_DIR" "$APP_DIR/logs" "$APP_DIR/logs/jobs" "$APP_DIR/tmp" "$APP_DIR/state" "$APP_DIR/uploads" "$APP_DIR/tailscale"; do
  mkdir -p "$d"
done
log_ok "App directories ready"

log_step "Runtime (optional)"
echo ""

if command -v ollama >/dev/null 2>&1; then
  if brew services start ollama >/dev/null 2>&1; then
    log_ok "Ollama service started (or already running)"
  else
    log_warn "Could not start Ollama through brew services. DroidAgent can still launch, but the local runtime may stay unavailable until Ollama is started manually."
  fi
else
  log_warn "Ollama not installed. To add: brew install ollama && brew services start ollama"
fi

log_step "Starting DroidAgent"
echo ""

if [[ ! -f apps/server/dist/index.js ]]; then
  die "Server build artifact missing." "Run: pnpm build"
fi

if server_ready; then
  log_ok "DroidAgent is already running at ${SERVER_URL}"
elif [[ -f "$LAUNCH_AGENT_PLIST" ]] && command -v launchctl >/dev/null 2>&1; then
  DOMAIN="gui/$(id -u)"
  TARGET="${DOMAIN}/${LAUNCH_AGENT_LABEL}"
  if ! launchctl print "$TARGET" >/dev/null 2>&1; then
    launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENT_PLIST" >/dev/null 2>&1 || true
  fi
  launchctl kickstart -k "$TARGET" >/dev/null 2>&1 || die "LaunchAgent start failed." "Inspect ${APP_DIR}/logs/launch-agent.stderr.log"
  wait_for_server || die "LaunchAgent did not make DroidAgent ready in time." "Inspect ${APP_DIR}/logs/launch-agent.stderr.log"
  log_ok "LaunchAgent restarted DroidAgent at ${SERVER_URL}"
else
  nohup node apps/server/dist/index.js >"$BOOTSTRAP_SERVER_LOG" 2>&1 &
  wait_for_server || die "Server did not become ready." "Inspect ${BOOTSTRAP_SERVER_LOG}"
  log_ok "DroidAgent started in the background at ${SERVER_URL}"
fi

echo ""
echo "${GREEN}DroidAgent is running.${NC} Open ${SERVER_URL} in your browser."
echo ""
open "${SERVER_URL}" 2>/dev/null || echo "Open manually: ${SERVER_URL}"
echo "Next step: complete passkey sign-in, then run the Setup quickstart to prepare the workspace, Ollama, OpenClaw, memory, and the Tailscale phone URL."
echo "Diagnostics: pnpm doctor"
echo ""
