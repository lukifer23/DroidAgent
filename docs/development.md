# Development Guide

## Workspace Layout

- `apps/server`
  - control plane, auth, runtime orchestration, files, jobs, remote access, Signal, telemetry
- `apps/web`
  - mobile-first PWA shell
- `packages/shared`
  - shared Zod contracts and event payloads

The default local path is `Ollama + qwen3.5:4b + 65k context + embeddinggemma:300m-qat-q8_0 + smart context management + workspace memory scaffold`.

## Daily Commands

```bash
pnpm dev
pnpm doctor
pnpm verify
pnpm verify:full
```

- `pnpm dev`
  - starts the web dev server and the server dev process
- `pnpm doctor`
  - checks local binaries, app directories, and server health without mutating repo-tracked files
- `pnpm verify`
  - lint, typecheck, unit tests, build, docs validation, and `pnpm audit --prod`
- `pnpm verify:full`
  - `pnpm verify` plus the real server-backed Playwright acceptance suite

## Browser Test Layers

- `pnpm test:e2e`
  - builds the workspace and runs Playwright against the real built DroidAgent server
  - Playwright starts a temp HOME, temp SQLite DB, temp workspace, and a seeded owner session
  - tests do not intercept `/api/**` and do not replace `window.WebSocket`
  - acceptance is chat-first now: the signed-in operator shell, live chat state, attachments, files, jobs, reconnect, and layout stability on Fold-sized viewports
- `pnpm perf:e2e`
  - runs advisory Playwright perf scenarios and writes artifacts under `artifacts/perf/`

## Perf And Diagnostics

- Server diagnostics live at `GET /api/diagnostics/performance`
- Client timings are captured in-browser and surfaced in the Settings diagnostics card
- `pnpm perf:server`
  - measures `/api/access` and `/api/dashboard`
- `pnpm perf:report`
  - prints the latest server and E2E perf artifacts

## Release Workflow

1. Run `pnpm verify:full`.
2. Run `pnpm perf:server` and `pnpm perf:e2e` when you are updating the baseline or checking a perf-sensitive change.
3. Review `artifacts/perf/` and the Settings diagnostics card for regressions.
4. Update docs when commands, routes, or supported operational flows change.
