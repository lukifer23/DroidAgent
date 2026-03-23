# DroidAgent

DroidAgent is a macOS-first, single-user, self-hosted mobile PWA for running OpenClaw on your own machine with a first-party web shell for chat, files, jobs, runtime control, Keychain-backed cloud providers, LaunchAgent management, and optional Signal ingress.

## What is implemented

- `apps/server`: Hono-based control plane with passkey auth, SQLite state, OpenClaw orchestration, runtime management for Ollama and `llama.cpp`, workspace-scoped file browsing, job execution, macOS LaunchAgent control, Keychain-backed provider secrets, Signal registration/daemon management, and WebSocket dashboard updates.
- `apps/web`: installable React/Vite PWA with a Fold-friendly mobile layout and tabs for Chat, Files, Jobs, Models, Channels, and Settings.
- `packages/shared`: shared Zod contracts for dashboard state, runtime status, channels, sessions, jobs, approvals, and WebSocket envelopes.
- `scripts/bootstrap.sh`: one-command bootstrap that installs dependencies, builds the monorepo, starts the server, and opens the local UI.

## Quick start

```bash
pnpm bootstrap
```

If you prefer to step through it manually:

```bash
pnpm install
pnpm --filter @droidagent/shared build
pnpm build
node apps/server/dist/index.js
```

Then open `http://127.0.0.1:4318`.

If your local `pnpm` policy skips native build scripts, the bootstrap script also compiles `better-sqlite3` explicitly inside `apps/server`.

## Runtime model paths

- Default local path: `Ollama`
  - Install/start handled through the UI or `brew install ollama && brew services start ollama`
  - Default model entry in the onboarding flow is `gpt-oss:20b`
- Advanced local path: `llama.cpp`
  - Install via `brew install llama.cpp`
  - DroidAgent starts `llama-server` locally and registers an OpenAI-compatible provider entry for OpenClaw
- Optional Signal channel:
  - Install or repair through the UI or `brew install openjdk signal-cli`
  - Supports both dedicated-number registration (`register` + `verify`) and linked-device mode (`link`)
  - Runs `signal-cli daemon --http` locally and wires OpenClaw to the daemon-backed Signal channel

## Cloud providers

- API keys are stored in the macOS login Keychain, not in SQLite or the repo.
- Supported provider secret slots:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `OPENROUTER_API_KEY`
  - `GEMINI_API_KEY`
  - `GROQ_API_KEY`
  - `TOGETHER_API_KEY`
  - `XAI_API_KEY`
- Cloud provider model selection is exposed in the PWA and pushed into the active OpenClaw default model.

## Commands

```bash
pnpm dev         # builds shared package once, then runs server + web dev processes
pnpm build       # builds shared, server, and web
pnpm test        # vitest across workspace
pnpm typecheck   # TS typecheck across workspace
pnpm bootstrap   # one-command local bootstrap
```

## Key paths

- App state: `~/.droidagent`
- OpenClaw profile: `~/.openclaw-droidagent`
- Server URL: `http://127.0.0.1:4318`
- OpenClaw Gateway URL: `ws://127.0.0.1:18789`
- llama.cpp URL: `http://127.0.0.1:8012/v1`
- Signal daemon URL: `http://127.0.0.1:8091`
- LaunchAgent plist: `~/Library/LaunchAgents/com.droidagent.server.plist`

## Notes

- WebAuthn/passkeys are the primary login method.
- The browser never talks directly to OpenClaw; it goes through the DroidAgent server.
- File and job operations are constrained to the configured workspace root.
- `sudo` is blocked for first-party job execution.
- Signal is optional and treated as lower-trust ingress than the local web session.
- LaunchAgent install/start/stop/uninstall is managed from the PWA and backed by `launchctl`.

Further details:

- [Install Guide](./docs/install.md)
- [Architecture](./docs/architecture.md)
- [Security](./docs/security.md)
- [Operations](./docs/operations.md)
