# DroidAgent

Current repo/runtime line: `v0.2.0`

DroidAgent is a macOS-first, single-owner control plane for OpenClaw with a mobile-first PWA shell for chat, files, jobs, runtime control, passkeys, Tailscale phone access, optional Signal ingress, and local multimodal attachments.

## What Ships In V1

- `apps/server`
  - Hono API, passkey auth, SQLite app state, Keychain-backed cloud secrets, canonical-origin enforcement, workspace-scoped files and jobs, OpenClaw orchestration, build/version identity, and owner-authenticated websocket fanout
- `apps/web`
  - installable React/Vite PWA with a chat-first operator shell, first-run Setup, Files, Jobs, Models, and Settings
  - fold-friendly layout, reconnect-safe streaming, a dedicated OpenClaw operator console, an owner-only rescue terminal, light/dark themes, multimodal attachments, compact host-status surfaces, and subtle motion tuned for operator use
- `packages/shared`
  - shared Zod contracts for dashboard, auth, files, jobs, channels, access state, and diagnostics telemetry

## Canonical Commands

```bash
pnpm bootstrap
pnpm stop
pnpm restart
pnpm run doctor
pnpm verify
pnpm verify:full
pnpm perf:server
pnpm perf:e2e
pnpm perf:report
pnpm perf:baseline
pnpm perf:check
```

Quick local start:

```bash
pnpm bootstrap
```

`pnpm bootstrap` now reuses an already healthy local server, restarts the LaunchAgent-backed host when it is installed, and only falls back to a background direct server start when no LaunchAgent is present yet.
If a managed maintenance restart is already in progress, bootstrap now waits for the host to recover instead of launching a duplicate instance.

`pnpm stop` stops managed DroidAgent host processes, clears stale maintenance markers, and cleans up orphaned repo-local OpenClaw workers. `pnpm restart` runs that cleanup first, then starts the host again through the normal bootstrap path.

Manual local start:

```bash
pnpm install
pnpm build
node apps/server/dist/index.js
```

Then open `http://localhost:4318`.

After the owner passkey is enrolled, `Setup` owns only the first-run path: workspace, Ollama, OpenClaw, the default local models, semantic memory prep, and the phone URL when Tailscale is already authenticated on the Mac. Once that path is ready, DroidAgent opens into `Chat`, not a separate dashboard.

## Product Defaults

- OpenClaw stays loopback-only and token-protected
- browser traffic never talks directly to OpenClaw
- single owner, multiple passkeys
- Ollama is the default local runtime path
- the default local Ollama context budget is `65k`
- the default local semantic-memory embedding model is `embeddinggemma:300m-qat-q8_0` on Ollama
- `qwen3.5:4b` is the default local chat model at a `65k` working context budget, and DroidAgent now reuses that same model for image/PDF work when Ollama reports `vision` capability
- `qwen2.5vl:3b` remains the fallback local attachment model only when the selected primary model is text-only
- semantic memory stays local-first with fallback disabled, so embeddings do not silently drift to a cloud provider
- llama.cpp remains the advanced local runtime path
- Tailscale Serve is the primary and only remote path exposed in the main UI right now
- Tailscale may run through the system daemon or a DroidAgent-managed userspace daemon on macOS when the system daemon is unavailable
- Signal stays optional and secondary to the web shell
- Smart Context Management is on by default
- the workspace is seeded with `AGENTS.md`, `TOOLS.md`, `MEMORY.md`, `PREFERENCES.md`, `HEARTBEAT.md`, a `memory/` folder, and a `skills/` folder
- semantic recall is intentionally biased toward `PREFERENCES.md`, then `MEMORY.md`, then dated notes and session memory so smaller local models stay more personal and more useful
- durable memory writes stay approval-gated through editable memory drafts in Settings before they append to `MEMORY.md`, `PREFERENCES.md`, or `memory/YYYY-MM-DD.md`
- assistant shell blocks can be promoted into `Run in Chat` or `Open in Terminal`; suggested commands are never auto-executed on the host

## Docs

- [Install Guide](./docs/install.md)
- [Development Guide](./docs/development.md)
- [Performance Guide](./docs/performance.md)
- [Operations Guide](./docs/operations.md)
- [Remote Access Guide](./docs/remote-access.md)
- [Architecture](./docs/architecture.md)
- [Security](./docs/security.md)
- [Experimental Roadmap](./docs/experimental-roadmap.md)

## Important Paths

- App state: `~/.droidagent`
- Maintenance state mirror: `~/.droidagent/state/maintenance-status.json`
- Job logs: `~/.droidagent/logs/jobs`
- OpenClaw profile: `~/.openclaw-droidagent`
- LaunchAgent plist: `~/Library/LaunchAgents/com.droidagent.server.plist`
- Server URL: `http://localhost:4318`

## Notes

- UI/UX overhaul now uses a modular style layer (`styles.css` + `styles/system.css` + `styles/motion.css`) with unified viewport-height calculations for Chat and Terminal shells to reduce layout jumps on navigation and mobile browser chrome changes.
- Realtime dashboard synchronization now includes explicit harness updates, slice-aware cache invalidation, and debounced full-snapshot reconciliation to keep UI state truthful after runtime/provider/channel/context/memory mutations.
- First-class workspace memory files are scaffold-repaired on demand, and draft apply/dismiss mutations are revision-checked so fast mobile interactions do not silently race each other.
- Chat, Files, Jobs, Settings, and Terminal surfaces now include stronger loading/empty/error behavior and safer fallbacks when websocket transport is degraded.
- Maintenance state is persisted in SQLite, mirrored to `~/.droidagent/state/maintenance-status.json` for local scripts, and surfaced in Settings plus the live chat shell so restarts are explicit instead of silent.
- Browser-side heavy paths are hardened: streaming chat render path avoids unnecessary markdown parsing in simple deltas, chat subscribes to live perf snapshots without polling on the hot route, terminal transcript trimming avoids full-buffer re-encode loops, and large job logs are browser-tailed.
- `/api/memory/prepare` is now a fast background trigger instead of a blocking reindex request. Settings surfaces queued/running/completed/failed state, progress label, error, and last duration while websocket updates keep the shell current.
- Server request-path warmup now primes the main dashboard/access caches before the readiness path completes, and the dashboard hot path uses quick memory status instead of forcing a live OpenClaw memory probe on first load.
- Route chunk prefetch is intentionally narrow now: only `Files` and `Settings` are prefetched after auth, while Chat/Terminal hot surfaces trim heavy paint effects and markdown loads lazily only when needed.
- Server diagnostics now split chat accept, first-delta wait, first-delta forward, full relay, memory draft apply, and memory reindex timings so operator latency surfaces stay honest.
- Performance artifacts are now actively budgeted. `pnpm perf:baseline` refreshes the baseline snapshot and `pnpm perf:check` enforces `perf-budgets.json` against the latest artifacts and baseline thresholds.
- File APIs are workspace-relative and text-only.
- Chat attachments support local images, PDFs, Markdown, JSON, logs, and common code/text files through the real OpenClaw tool path.
- The chat route is the primary operator surface: live run state, approvals, tool summaries, attachments, markdown/code rendering, editable durable-memory capture actions, suggested command promotion, and per-run client timings are all surfaced there.
- Owner jobs run inside the configured workspace jail and persist replayable stdout and stderr logs.
- The rescue terminal is a real PTY surface, separate from Jobs. It defaults to a workspace-scoped shell and exposes a deliberate host-shell escalation path for recovery work.
- Browser acceptance now runs against a real server-backed Playwright harness; route interception and fake websocket replacement are no longer the primary test path.
- `verify:full` enforces correctness; the perf scripts produce artifacts under `artifacts/perf/`, and `pnpm perf:check` enforces the current perf budgets when you run the perf workflow.
- The current live acceptance target is `web/PWA + owner passkey + Tailscale remote + Ollama local runtime`.
- Version/build identity is surfaced by the running server so the Mac shell, the phone shell, diagnostics, and the repo all report the same release line.
