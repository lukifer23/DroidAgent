# Development Guide

## Workspace Layout

- `apps/server`
  - control plane, auth, runtime orchestration, files, jobs, remote access, Signal, telemetry
- `apps/web`
  - mobile-first PWA shell
  - modularized UI shell styling layers (`styles.css`, `styles/system.css`, `styles/motion.css`) with unified viewport-measured layout primitives
- `packages/shared`
  - shared Zod contracts and event payloads
  - includes explicit realtime harness update events for dashboard coherence plus the maintenance and memory-draft contracts used by both server and web

The default local path is `Ollama + qwen3.5:4b + 65k context + embeddinggemma:300m-qat-q8_0 + smart context management + workspace memory scaffold`.

## Daily Commands

```bash
pnpm dev
pnpm run doctor
pnpm hygiene:check
pnpm verify
pnpm verify:full
```

- `pnpm dev`
  - starts the web dev server and the server dev process
- `pnpm run doctor`
  - checks local binaries, app directories, and server health without mutating repo-tracked files
- `pnpm hygiene:check`
  - enforces canonical helper ownership, script reachability, required inventory docs, and size guardrails for new production files
- `pnpm verify`
  - lint, hygiene checks, typecheck, unit tests, build, docs validation, and `pnpm audit --prod`
- `pnpm verify:full`
  - `pnpm verify` plus the real server-backed Playwright acceptance suite

## Current Internal Convergence Points

- server realtime mutation fanout should go through the shared slice-aware queue in `apps/server/src/lib/realtime-mutation-queue.ts`
- server callers that only need OpenClaw memory/context/gateway status should import the focused facets in `apps/server/src/services/openclaw-service-facets.ts`, not the full `openclawService`
- direct `openclawService` imports outside the harness layer should now be the exception; route/services should depend on focused facets unless they are implementing the harness boundary itself
- browser chat/session lifecycle state should go through `apps/web/src/lib/chat-session-store.ts`
- websocket transport should apply chat and terminal events in `apps/web/src/hooks/use-websocket.ts`, not in parallel consumers
- OpenClaw remains the source of truth for session lifecycle, approvals, pairing, and execution; DroidAgent caches and annotates that state for UX only

## Browser Test Layers

- `pnpm test:e2e`
  - builds the workspace and runs Playwright against the real built DroidAgent server
  - Playwright starts a temp HOME, temp SQLite DB, temp workspace, and a seeded owner session
  - tests do not intercept `/api/**` and do not replace `window.WebSocket`
  - acceptance is chat-first now: the signed-in operator shell, live chat state, durable-memory capture, suggested-command promotion, attachments, files, jobs, reconnect, and layout stability on Fold-sized viewports
- `pnpm perf:e2e`
  - runs advisory Playwright perf scenarios and writes artifacts under `artifacts/perf/`
- `pnpm perf:live`
  - runs the opt-in live OpenClaw/Ollama perf lane without changing deterministic CI gates
  - writes to `artifacts/perf/live/current/`
- `pnpm perf:model-compare`
  - benchmarks the maintained local live model profiles side by side
  - current maintained pair: `qwen3.5:4b` and `gemma4:e4b`, both at `65k`
  - writes lane artifacts under `artifacts/perf/model-compare/`

## Perf And Diagnostics

- Server diagnostics live at `GET /api/diagnostics/performance`
- Client timings are captured in-browser and surfaced in the Settings diagnostics card
- `pnpm perf:server`
  - measures the first cold `/api/access` and authenticated `/api/dashboard` requests, then the warm p95 request path for both routes
- `pnpm perf:baseline`
  - refreshes `artifacts/perf/baseline.json` from the latest artifacts
- `pnpm perf:check`
  - enforces `perf-budgets.json` and baseline regression thresholds, including shared shell/vendor chunks
- `pnpm perf:report`
  - prints the latest server and E2E perf artifacts
- the route-switch perf artifact is measured from in-browser route activation to first visible destination control, not from Playwright's outer click timing
- live perf and model-compare now run a seeded authenticated server without `DROIDAGENT_TEST_MODE`, then apply the requested Ollama profile through the same runtime-selection path used by the product before the perf lane is marked ready

## Release Workflow

1. Run `pnpm verify:full`.
2. Run `pnpm perf:server` and `pnpm perf:e2e` when you are updating the baseline or checking a perf-sensitive change.
3. Run `pnpm perf:report`, `pnpm perf:baseline`, and `pnpm perf:check`.
4. If you changed how a perf artifact is defined or added new tracked shared chunks, refresh the baseline in the same change instead of leaving the gate on stale semantics.
5. Run `pnpm perf:live` when validating real OpenClaw/Ollama behavior on the live path.
6. Run `pnpm perf:model-compare` when you are evaluating a local model candidate against the maintained baseline.
7. Review `artifacts/perf/`, `artifacts/perf/live/current/`, and `artifacts/perf/model-compare/` plus the Settings diagnostics card for regressions.
8. Update docs when commands, routes, supported operational flows, or perf budgets change.

## Boundary Review Checklist

For PRs touching sessions, approvals, pairing, websocket semantics, maintenance lifecycle, or origin/canonical access:

1. Confirm the change does not create a second state machine for session lifecycle, approvals, or pairing.
2. Confirm owner-gated mutations still route through `decisionService`.
3. Confirm browser clients still consume DroidAgent wrapper surfaces, not raw OpenClaw control semantics.
4. Confirm websocket + dashboard convergence still has one canonical refresh path.
5. Confirm browser chat state still has one canonical session store instead of parallel run/stream/feedback ownership.
6. Update `docs/surface-inventory.md` whenever a public route/event compatibility alias is added or changed.
