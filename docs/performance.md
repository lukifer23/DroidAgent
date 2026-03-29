# Performance Guide

## Goal

This pass treats performance as an advisory baseline, not a release gate. DroidAgent now captures both server timings and client-observed UX timings so regressions are visible before they become product issues.

The benchmark commands use isolated seeded ports so `perf:server`, `perf:e2e`, and the main E2E suite do not fight over the same local harness server.

## Commands

```bash
pnpm perf:server
pnpm perf:e2e
pnpm perf:report
```

- `pnpm perf:server`
  - measures server HTTP timings
  - writes `artifacts/perf/server-latest.json`
- `pnpm perf:e2e`
  - runs Playwright UX timing scenarios
  - writes one artifact per Playwright project under `artifacts/perf/`
- `pnpm perf:report`
  - prints the latest server and E2E summaries

## Metrics Captured

Server-side:

- `http.get./api/access`
- `http.get./api/dashboard`
- `dashboard.snapshot`
- `chat.send.submitToAccepted`
- `chat.stream.acceptedToFirstDelta`
- `chat.stream.firstDeltaForward`
- `chat.stream.acceptedToCompleteRelay`
- `file.read`
- `file.write`
- `job.start`
- `job.firstOutput`
- `memory.prepare`
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
- `client.file.open`
- `client.file.save`
- `client.memory.prepare`
- `client.job.start_to_first_output`

Notable implementation guardrails in this pass:

- streaming chat rendering fast-paths plain deltas before markdown parsing to reduce avoidable parse churn
- client chat timing now records first-token latency once per run instead of over-counting multi-delta replies
- terminal transcript trimming tracks byte budget incrementally and avoids full-history re-encoding on each output chunk
- jobs output rendering tails large logs in-browser to avoid large full-text DOM updates
- websocket-driven dashboard patches are reconciled with debounced full snapshot pulls after high-impact runtime/provider/channel/context/memory mutations

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

## Advisory Budgets

- `GET /api/access` local p95 <= `250 ms`
- `GET /api/dashboard` local p95 <= `250 ms`
- warm route switch p95 <= `200 ms`
- websocket reconnect to resync p95 <= `2000 ms`
- file open and save for <= `256 KB` text files p95 <= `500 ms`
- DroidAgent relay overhead from accepted chat submit to first forwarded token p95 <= `150 ms`

Model generation time is recorded separately from DroidAgent relay overhead. Reindex and memory-draft timings are also tracked independently so semantic-memory maintenance work does not get folded into chat latency.

OpenClaw is configured with `agents.defaults.thinkingDefault = "off"` by default in DroidAgent to reduce avoidable latency on models that expose a reasoning or thinking mode.

The default local baseline also assumes `qwen3.5:4b` on Ollama with a `65k` context budget, the same primary model handling local image/PDF analysis whenever Ollama reports `vision`, `qwen2.5vl:3b` only as the fallback attachment model for text-only primaries, `embeddinggemma:300m-qat-q8_0` for local semantic memory, smart context management enabled, and workspace memory search enabled.

## Baseline Procedure

1. Run `pnpm build`.
2. Run `pnpm perf:server`.
3. Run `pnpm perf:e2e`.
4. Run `pnpm perf:report`.
5. Compare the generated artifact summaries against the advisory budgets and the previous local baseline.

Warm-path p95 is the main review target for `access` and `dashboard`. Cold-start startup diagnostics still show up in the raw artifact averages and max values, so review both the summary and the underlying samples before making a release call.

## Current Baseline Table

This table is the manual reference point for this pass. Update it when you intentionally refresh the baseline after a meaningful product change.

| Metric | Target |
|--------|--------|
| `GET /api/access` p95 | `<= 250 ms` |
| `GET /api/dashboard` p95 | `<= 250 ms` |
| Route switch p95 | `<= 200 ms` |
| Chat first token relay p95 | `<= 150 ms` |
| Reconnect to resync p95 | `<= 2000 ms` |
| File save p95 | `<= 500 ms` |
