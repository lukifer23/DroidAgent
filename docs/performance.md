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
- `chat.send.enqueue`
- `chat.stream.firstDeltaRelay`
- `chat.stream.completeRelay`
- `file.read`
- `file.write`
- `job.start`
- `job.firstOutput`

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
- `client.job.start_to_first_output`

## Advisory Budgets

- `GET /api/access` local p95 <= `250 ms`
- `GET /api/dashboard` local p95 <= `250 ms`
- warm route switch p95 <= `200 ms`
- websocket reconnect to resync p95 <= `2000 ms`
- file open and save for <= `256 KB` text files p95 <= `500 ms`
- DroidAgent relay overhead from accepted chat submit to first forwarded token p95 <= `150 ms`

Model generation time is recorded separately from DroidAgent overhead.

OpenClaw is configured with `agents.defaults.thinkingDefault = "off"` by default in DroidAgent to reduce avoidable latency on models that expose a reasoning or thinking mode.

The default local baseline also assumes `qwen3.5:4b` on Ollama with a `65k` context budget, smart context management enabled, and workspace memory search enabled.

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
