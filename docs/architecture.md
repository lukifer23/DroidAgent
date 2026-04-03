# Architecture

## Overview

- `apps/server`
  - authenticates the owner with passkeys
  - stores state in SQLite under `~/.droidagent`
  - persists maintenance operations, memory drafts, and owner decision audit records in SQLite
  - stores cloud-provider API keys in the macOS login Keychain
  - manages runtimes and OpenClaw through CLI/process supervision
  - exposes the running build/version identity to the shell and diagnostics
  - exposes the browser REST API and owner-authenticated WebSocket update stream
  - owns the only browser-facing integration boundary; the browser never receives an OpenClaw token
- `apps/web`
  - mobile-first routed PWA
  - Setup, Chat, Files, Jobs, Models, Settings, plus an owner-only rescue terminal route
  - reconnect-safe streaming, install prompt, Fold-friendly layout
- `packages/shared`
  - common schemas for dashboard state, files, jobs, passkeys, owner decisions, access/bootstrap payloads, diagnostics telemetry, and WebSocket events

The canonical public route, websocket, script, and data-path inventory lives in [Surface Inventory](./surface-inventory.md). Update that file before adding a new cross-layer surface.

## Harness boundary

- DroidAgent now treats OpenClaw through an internal harness adapter boundary.
- v1 only ships the OpenClaw implementation, but generic consumers depend on the harness surface for:
  - session listing and history
  - message send/abort
  - approvals
  - channel status
  - runtime-model configuration
  - harness health
- DroidAgent adds one owner-facing decision layer above that harness surface. It does not replace OpenClaw approval, pairing, or session semantics.

## OpenClaw integration

- Lifecycle, config/bootstrap, chat relay/session handling, memory state, approvals, channels, and pairing continue through the OpenClaw CLI/Gateway behind the harness surface.
- Live chat now uses a server-side relay path into the OpenClaw Chat Completions endpoint on the local gateway.
- DroidAgent re-emits sanitized stream events to the browser over its own WebSocket.
- OpenClaw remains loopback-only with token auth.
- The explicit boundary map lives in [OpenClaw Boundary](./openclaw-boundary.md).
- Public compatibility aliases remain intact, but the internal owner-action path is now centralized through `decisionService`.

## Maintenance lifecycle

- The server owns maintenance intent and persistence, but restart work runs in a detached maintenance runner so DroidAgent can survive restarting itself.
- Maintenance operations move through `queued -> draining -> stopping -> starting -> verifying -> completed|failed`.
- A derived maintenance status mirror is written under `~/.droidagent/state/maintenance-status.json` so local bootstrap/start/stop scripts can stay maintenance-aware without bypassing browser auth.
- `remote` scope extends `runtime` scope with the DroidAgent-managed userspace Tailscale path and is intentionally localhost-only.

## Local runtimes

- `Ollama`
  - default onboarding path
  - managed by Homebrew services
- `llama.cpp`
  - advanced path
  - started as a supervised `llama-server` process
  - registered into OpenClaw as an OpenAI-compatible provider

## Remote access

- local daily control starts on loopback
- Tailscale Serve is the primary guided remote phone path
- a Cloudflare named tunnel remains an advanced backend path but is intentionally hidden from the main operator flow
- DroidAgent tracks canonical origin, bootstrap token issuance, and phone-side owner enrollment state
- after canonical setup, the selected remote URL becomes the primary daily-use origin

## Context management

- DroidAgent writes OpenClaw compaction policy into the dedicated `droidagent` profile
- Smart Context Management enables safeguard compaction, pre-compaction memory flush, and provider-aware context pruning
- Anthropic and OpenRouter Anthropic models use `cache-ttl` pruning
- local runtimes keep pruning off while still using compaction and memory flush

## Durable memory model

- Durable memory remains file-backed in the workspace: `MEMORY.md`, `PREFERENCES.md`, and `memory/YYYY-MM-DD.md`.
- Recall order is biased for smaller local models: `PREFERENCES.md` first, then `MEMORY.md`, then dated notes under `memory/`, then session memory.
- Chat messages and file selections create `pending` memory drafts first; the operator can edit target/title/content before applying them.
- Pending memory drafts are also projected into the shared decision ledger so the owner sees one queue across exec approvals, durable-memory review, and Signal pairing.
- Applying a draft appends to the selected file atomically, invalidates memory status, and runs incremental reindex with force fallback if needed.
- Explicit semantic-memory prepare now runs as a persisted background operation. The REST trigger is single-flight, returns immediately, and progress/result state is stored in SQLite and surfaced through additive `MemoryStatus` fields plus websocket updates.
- Explicit memory prepare fingerprints the durable-memory source set and skips the expensive reindex path when the index is already current and the source files have not changed.
- First-class memory file access repairs the workspace scaffold lazily so missing `MEMORY.md` or `PREFERENCES.md` does not surface raw `ENOENT` failures in normal operator flows.

## Decision model

- DroidAgent normalizes owner-gated work into one decision ledger and inbox.
- Current decision kinds are:
  - OpenClaw exec approvals
  - memory draft review
  - Signal pairing
- Decision records carry source system, source ref, requested/resolved timestamps, source session context, and owner-plus-device attribution when the owner resolves an action through DroidAgent.
- Existing `/api/approvals`, `/api/memory/drafts/*`, and Signal pairing routes remain as compatibility paths, but they now stamp the same underlying decision model.

## File and job model

- files are addressed by workspace-relative path, never absolute host path
- text files can be loaded and saved through the PWA with conflict checks and atomic writes
- jobs are owner-submitted shell commands inside the configured workspace jail
- stdout/stderr are streamed live, short-window batched, and persisted under `~/.droidagent/logs/jobs`
- the rescue terminal is a separate PTY-backed owner shell with its own transcript and audit log path under `~/.droidagent/logs/terminal`
- both server and browser terminal transcripts now use byte-bounded UTF-8-safe tail buffers instead of repeated full-history concat/trim loops
- jobs and rescue terminal output now use a shared buffered pipeline pattern so append ordering and websocket batching behavior stay consistent

## Diagnostics and performance

- the server records rolling in-memory timing samples for HTTP requests, dashboard snapshots, chat relay timing, file operations, and job execution
- memory draft apply timing and memory reindex timing are recorded server-side; timing summaries now also surface last-sample age plus `ok`/`warn`/`error` sample counts
- the client records route, chat, reconnect, file, and job timings locally
- websocket patch flush latency, chat history resync latency, and session-switch latency are now captured as additive diagnostics
- the Settings route surfaces a compact diagnostics card
- the benchmark scripts write JSON artifacts under `artifacts/perf/`
- the dashboard snapshot is composed from independently cached slices for setup, access, runtimes, providers, channels, harness, memory, host pressure, memory drafts, context management, maintenance, launch-agent state, sessions, jobs, decisions, and approvals
- server perf artifacts now record the first real authenticated `/api/dashboard` request separately from the internal `dashboard.snapshot.compose` timing so cold-path reporting reflects user-visible wait instead of warmed cache math
- request-path warmup now waits for startup restore, then primes the main dashboard/access/runtime/provider caches before readiness completes so the first real dashboard request does not pay hidden restore work
- realtime dashboard mutation fanout now converges through a shared slice-aware mutation queue so invalidation, startup refresh, and websocket event bursts are coalesced once per flush instead of emitted by disconnected one-off publishers
- client chat/session state now converges through one canonical per-session store for loaded history, optimistic sends, active run state, streaming text, feedback timing, and switch/resync state; websocket transport and routed surfaces subscribe to selectors over that state instead of maintaining parallel run/stream/feedback paths
- websocket reconnect now reconnects transport first and then resyncs dashboard/access in the background, which keeps the offline banner tied to actual socket availability instead of waiting through a generic backoff-plus-fetch loop
- decision-related mutations invalidate and publish through one path so approvals, memory-draft review, and pairing do not fan out as disconnected subsystems
- HTTP and websocket chat send/abort now converge through one coordinator lifecycle path for transport parity
- browser terminal websocket events are applied through one transport consumer path, removing the old double-application risk between websocket plumbing and app context

## UI shell and layout stability

- the routed PWA shell keeps a shared topbar and bottom-nav chrome while route content remains mounted across navigation to avoid avoidable subtree remount jitter
- viewport CSS vars (`--app-topbar-h`, `--app-bottom-nav-h`, `--app-viewport-h`) are measured through a shared hook and updated via `ResizeObserver` plus `visualViewport` listeners, with rAF scheduling to avoid resize thrash
- Chat and Terminal shells now share unified viewport-height formulas so sticky composers, PTY surfaces, and status stacks stay aligned on Fold-sized and phone-sized viewports
- the `Files` route is kept hot in the shell, while `Settings`, `Jobs`, `Models`, `Channels`, and `Terminal` warm during idle after auth so route switches stay responsive without inflating the first unauthenticated bootstrap path
- hot route surfaces trim expensive blur/animation work, and markdown rendering is lazy-loaded only when a message actually needs rich markdown semantics
- transcript scroll anchoring stays rAF-batched and viewport measurement now stays armed regardless of initial ref timing, which removes a fragile mount-order dependency in the shared shell chrome measurement path
- build budgets now track shared shell/vendor chunks as first-class perf gates instead of only the main entry and terminal route leaf chunks
- style concerns are layered: base palette/components in `styles.css`, cross-screen shell primitives in `styles/system.css`, and motion/accessibility handling in `styles/motion.css`

## Optional Signal path

- `signal-cli` stays isolated under `~/.droidagent/signal-cli`
- the PWA remains the primary control surface
- Signal stays available as an advanced secondary owner ingress, not a required onboarding step
- advanced Signal management stays secondary to the main Setup/Chat/Files/Jobs/Models/Settings flow
