# DroidAgent

DroidAgent is a macOS-first, single-owner, self-hosted mobile PWA for running OpenClaw on your own machine with a first-party web shell for chat, files, jobs, runtime control, passkey management, Tailscale-backed phone access, Keychain-backed cloud providers, LaunchAgent management, and optional Signal ingress.

## What is implemented

- `apps/server`
  - Hono control plane with passkey auth, SQLite state, Tailscale bootstrap/origin enforcement, OpenClaw orchestration through a harness boundary, live chat relay, workspace-scoped file browsing and editing, job execution with persisted logs, Keychain-backed provider secrets, Signal registration/daemon management, and LaunchAgent control
- `apps/web`
  - installable React/Vite PWA with routed Setup, Chat, Files, Jobs, Models, Channels, and Settings surfaces
  - Fold-friendly mobile layout, install-to-home-screen support, reconnect-safe WebSocket streaming, live approvals, file editing, and job replay
- `packages/shared`
  - shared Zod contracts for dashboard state, file/job payloads, passkeys, bootstrap links, and WebSocket envelopes
- `scripts/bootstrap.sh`
  - one-command bootstrap with preflight checks, workspace build, app-directory setup, optional Ollama start, and server health wait

## Quick start

```bash
pnpm bootstrap
```

Manual path:

```bash
pnpm install
pnpm --filter @droidagent/shared build
pnpm build
node apps/server/dist/index.js
```

Then open `http://127.0.0.1:4318`.

## Product defaults

- OpenClaw-first harness architecture
- macOS-primary host integrations
- single owner with multiple passkeys
- loopback by default, Tailscale Serve for remote phone access
- Ollama default local runtime, llama.cpp advanced local runtime
- optional cloud providers stored in macOS Keychain
- optional Signal as a secondary owner ingress

## Main routes in the PWA

- `Setup`
  - workspace, runtime, model, Tailscale bootstrap
- `Chat`
  - streaming assistant turns, approvals, session history, abort
- `Files`
  - workspace-relative browser plus direct text-file editing with conflict checks
- `Jobs`
  - owner-submitted shell jobs, live stdout/stderr, replayable logs
- `Models`
  - runtime install/start/stop plus active provider view
- `Channels`
  - Signal runtime, registration, linking, pairing
- `Settings`
  - LaunchAgent, passkeys, cloud providers, remote access, PWA install

## Key paths

- App state: `~/.droidagent`
- Job logs: `~/.droidagent/logs/jobs`
- OpenClaw profile: `~/.openclaw-droidagent`
- Server URL: `http://127.0.0.1:4318`
- OpenClaw Gateway URL: `ws://127.0.0.1:18789`
- OpenClaw HTTP URL: `http://127.0.0.1:18789`
- llama.cpp URL: `http://127.0.0.1:8012/v1`
- Signal daemon URL: `http://127.0.0.1:8091`
- LaunchAgent plist: `~/Library/LaunchAgents/com.droidagent.server.plist`

## Commands

```bash
pnpm dev
pnpm build
pnpm test
pnpm typecheck
pnpm bootstrap
```

## Notes

- The browser never talks directly to OpenClaw. DroidAgent is the only frontend and relay.
- File and job operations are constrained to the configured workspace root. File APIs use workspace-relative paths.
- Owner-submitted jobs run directly inside DroidAgent policy. Agent-requested exec continues through OpenClaw approvals.
- Job execution enforces timeout and output ceilings. Replayable stdout/stderr logs live under `~/.droidagent/logs/jobs/`.
- Tailscale is the supported remote path. Cloudflare/public exposure is out of scope.
- If a feature is not production-ready, it is hidden instead of stubbed.

Further details:

- [Install Guide](./docs/install.md)
- [Architecture](./docs/architecture.md)
- [Security](./docs/security.md)
- [Operations](./docs/operations.md)
