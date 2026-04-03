# Performance Guide

## Goal

This pass treats performance as a tracked engineering budget. DroidAgent captures both server timings and client-observed UX timings, writes artifacts under `artifacts/perf/`, and can enforce `perf-budgets.json` plus baseline regression thresholds through `pnpm perf:check`.

The benchmark commands use isolated seeded ports so `perf:server`, `perf:e2e`, and the main E2E suite do not fight over the same local harness server.

## Commands

```bash
pnpm perf:server
pnpm perf:e2e
pnpm perf:live
pnpm perf:report
pnpm perf:baseline
pnpm perf:check
pnpm hygiene:check
```

- `pnpm perf:server`
  - measures the first cold `/api/access` and authenticated `/api/dashboard` requests plus the warm request path p95
  - writes `artifacts/perf/server-latest.json`
- `pnpm perf:e2e`
  - runs Playwright UX timing scenarios
  - route-switch timing starts at in-browser route activation and ends when the destination control is visible
  - writes one artifact per Playwright project under `artifacts/perf/`
- `pnpm perf:live`
  - runs the same server + E2E perf probes with `DROIDAGENT_PERF_LIVE=1`
  - intended for opt-in OpenClaw/Ollama validation; not used as the deterministic CI regression gate
  - additive reporting lane; keep deterministic budgets as the required gate
- `pnpm perf:report`
  - prints the latest server and E2E summaries
- `pnpm perf:baseline`
  - snapshots current perf artifacts into `artifacts/perf/baseline.json`
- `pnpm perf:check`
  - enforces `perf-budgets.json` and baseline regression threshold
  - supports `skipRegression: true` on intentionally noisy/optional metrics
- `pnpm hygiene:check`
  - blocks duplicate canonical helpers, oversized new production files, orphaned scripts, and missing architecture-boundary inventory docs before bloat slips into the hot path

## Metrics Captured

Server-side:

- `http.get./api/access`
- `http.get./api/dashboard`
- `dashboard.snapshot`
- `dashboard.snapshot.compose`
- `chat.send.submitToAccepted`
- `chat.stream.acceptedToFirstDelta`
- `chat.stream.firstDeltaForward`
- `chat.stream.acceptedToCompleteRelay`
- `ws.patch.flush`
- `chat.history.resync`
- `file.read`
- `file.write`
- `job.start`
- `job.firstOutput`
- `memory.prepare`
- `memory.prepare.complete`
- `memory.reindex`
- `memory.draft.apply`
- `memory.todayNote`

Client-side:

- `client.app_shell.ready`
- `client.auth.ready`
- `client.dashboard.ready`
- `client.route.switch`
- `client.chat.submit_to_first_token`
- `client.chat.submit_to_done`
- `client.ws.reconnect_to_socket`
- `client.ws.reconnect_to_resync`
- `client.ws.patch_flush`
- `client.chat.history_resync`
- `client.chat.session_switch`
- `client.file.open`
- `client.file.save`
- `client.memory.prepare`
- `client.job.start_to_first_output`

E2E artifact metrics:

- `cold_dashboard_ms`
- `route_switch_ms`
- `memory_prepare_accepted_ms`
- `memory_prepare_completion_ms`
- `chat_first_token_visible_ms`
- `chat_done_ms`
- `reconnect_resync_ms`
- bundle bytes from the Vite manifest for the main entry, shared shell/vendor chunks, markdown chunk, terminal route chunk, and xterm chunk

Notable implementation guardrails in this pass:

- streaming chat rendering fast-paths plain deltas before markdown parsing to reduce avoidable parse churn
- client chat timing now records first-token latency once per run instead of over-counting multi-delta replies
- terminal transcript trimming tracks byte budget incrementally and avoids full-history re-encoding on each output chunk
- jobs output rendering tails large logs in-browser to avoid large full-text DOM updates
- decision updates now invalidate and publish through one path so owner-gated actions do not create parallel approval, draft, and pairing refresh storms
- websocket-driven dashboard patches are reconciled with debounced full snapshot pulls after high-impact runtime/provider/channel/context/memory mutations
- server-side mutation fanout now coalesces dashboard slice invalidation and websocket emits through one shared queue, which reduces repeated slice loads and keeps mutation bursts ordered
- request-path warmup now waits for startup restore before priming dashboard/access/runtime/provider caches, and dashboard memory status uses the quick cached path on the hot request path
- perf artifacts now record the first real authenticated `/api/dashboard` request separately from `dashboard.snapshot.compose`, which keeps cold-path reporting tied to operator-visible wait instead of warmed slice-compose samples
- the memory prepare endpoint is now a fast single-flight background trigger; completion latency is measured separately from accepted latency
- explicit memory prepare fingerprints the durable-memory source set and skips the heavy reindex path when the index is already current
- `memory.prepare` and `memory.prepare.complete` samples now stamp `source` context (`operator`, `resume`, `prewarm`), and an operator request that joins an in-flight prepare emits its own joined completion sample so perf artifacts do not accidentally report stale bootstrap timings as interactive latency
- browser chat/session timing is now sourced from one canonical per-session store, which keeps first-token and completion timings aligned with the same run/stream lifecycle the UI renders
- websocket reconnect now opens transport immediately when the browser comes back online and resyncs dashboard/access state in the background so reconnect-visible downtime is bounded by socket availability instead of a backoff-plus-fetch loop
- the `Files` route stays hot in the shell while the other secondary operator routes warm during idle, which trims route-switch churn without forcing every screen into the unauthenticated bootstrap path
- deterministic `route_switch_ms` now starts inside the browser at route activation instead of before Playwright actionability checks, which keeps the gate tied to app route work
- shared bundle budgets now gate app-shell, React vendor, markdown, and xterm chunks instead of only the main entry and terminal leaf route

The Settings diagnostics view now shows p95, last sample, sample count, `ok`/`warn`/`error` counts, and sample age so old or unhealthy latency numbers are easier to spot before they mislead an operator.

## Chat Timing Split

Server chat relay timing is intentionally broken into separate slices:

- `chat.send.submitToAccepted`
  - browser submit to DroidAgent accepting the run
- `chat.stream.acceptedToFirstDelta`
  - DroidAgent accepted the run and waited for the first upstream delta
- `chat.stream.firstDeltaForward`
  - DroidAgent overhead to forward the first received delta to the browser
- `chat.stream.acceptedToCompleteRelay`
  - DroidAgent relay duration from accept to end-of-stream

This keeps model time, relay overhead, and browser-observed latency from being mixed into a single misleading number.

## Tracked Budgets

- `GET /api/access` local p95 <= `250 ms`
- `GET /api/dashboard` local p95 <= `250 ms`
- first authenticated `GET /api/dashboard` request <= `750 ms`
- cold dashboard browser fetch p95 <= `1200 ms`
- warm route switch p95 <= `180 ms`
- websocket reconnect to resync p95 <= `2000 ms`
- file open and save for <= `256 KB` text files p95 <= `500 ms`
- memory prepare accepted p95 <= `250 ms`
- memory prepare completion p95 <= `35000 ms`
- chat first token visible p95 <= `200 ms`
- main entry JS <= `350 kB`
- shared app-shell JS <= `260 kB`
- shared React vendor JS <= `190 kB`
- shared router vendor JS <= `20 kB`
- shared markdown JS <= `130 kB`
- terminal route JS <= `300 kB`
- xterm JS <= `360 kB`

Model generation time is recorded separately from DroidAgent relay overhead. Reindex and memory-draft timings are also tracked independently so semantic-memory maintenance work does not get folded into chat latency.

OpenClaw is configured with `agents.defaults.thinkingDefault = "off"` by default in DroidAgent to reduce avoidable latency on models that expose a reasoning or thinking mode.

The default local baseline also assumes `qwen3.5:4b` on Ollama with a `65k` context budget, the same primary model handling local image/PDF analysis whenever Ollama reports `vision`, `qwen2.5vl:3b` only as the fallback attachment model for text-only primaries, `embeddinggemma:300m-qat-q8_0` for local semantic memory, smart context management enabled, and workspace memory search enabled.

## Baseline Procedure

1. Run `pnpm build`.
2. Run `pnpm perf:server`.
3. Run `pnpm perf:e2e`.
4. Run `pnpm perf:report`.
5. Run `pnpm perf:baseline`.
6. Run `pnpm perf:check`.

Warm-path p95 is still the main review target for `access` and `dashboard`, but the budget set now also tracks the first real dashboard request, visible first-token latency, reconnect-visible downtime, background memory prepare behavior, and bundle-size drift across shared chunks.

## Current Targets

This table is the maintained target set for the perf workflow.

| Metric | Target |
|--------|--------|
| `GET /api/access` p95 | `<= 250 ms` |
| `GET /api/dashboard` p95 | `<= 250 ms` |
| First authenticated `GET /api/dashboard` | `<= 750 ms` |
| Cold dashboard browser fetch p95 | `<= 1200 ms` |
| Route switch p95 | `<= 180 ms` |
| Chat first token visible p95 | `<= 200 ms` |
| Reconnect to resync p95 | `<= 2000 ms` |
| Memory prepare accepted p95 | `<= 250 ms` |
| Memory prepare completion p95 | `<= 35000 ms` |
| File save p95 | `<= 500 ms` |
| Main entry JS | `<= 350 kB` |
| Shared app-shell JS | `<= 260 kB` |
| Shared React vendor JS | `<= 190 kB` |
| Shared router vendor JS | `<= 20 kB` |
| Shared markdown JS | `<= 130 kB` |
| Terminal route JS | `<= 300 kB` |
| xterm JS | `<= 360 kB` |

## Latest Validated Local Run

Validated on `2026-04-03`:

- server `GET /api/access` p95: `2.39 ms`
- server `GET /api/dashboard` p95: `2.37 ms`
- server first authenticated `GET /api/dashboard`: `3.70 ms`
- E2E cold dashboard p95: `8.81 ms`
- E2E route switch p95: `8.10 ms`
- E2E reconnect to resync p95: `23.15 ms`
- E2E chat first token visible p95: `110.67 ms`
- E2E memory prepare accepted p95: `6.10 ms`
- E2E memory prepare completion p95: `16.07 ms`
- main entry JS: `16.61 kB`
- shared app-shell JS: `248.54 kB`
- shared React vendor JS: `178.32 kB`
- shared router vendor JS: `12.98 kB`
- shared markdown JS: `111.67 kB`
- terminal route JS: `9.69 kB`
- xterm JS: `340.36 kB`

This validated run clears the stricter `180 ms` route-switch budget along with the other checked-in deterministic perf gates.
