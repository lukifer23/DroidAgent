# Operations

## Local development

```bash
pnpm dev
pnpm run doctor
```

## Production-style local build

```bash
pnpm install
pnpm build
node apps/server/dist/index.js
pnpm stop
pnpm restart
```

`pnpm bootstrap` is the simpler host path now. It reuses a healthy local server when one already exists, prefers the LaunchAgent-managed host when installed, waits on an active managed maintenance cycle instead of launching a duplicate host, and only falls back to a background direct server start when the LaunchAgent has not been installed yet.

Use `pnpm stop` when you need a clean local reset. It stops managed DroidAgent host processes, clears stale maintenance markers, and reaps orphaned repo-local OpenClaw workers instead of leaving stale background sessions around. `pnpm restart` runs that cleanup and then bootstraps the host again.

## Logs

- DroidAgent logs: `~/.droidagent/logs`
- Maintenance log: `~/.droidagent/logs/maintenance.log`
- Job logs: `~/.droidagent/logs/jobs`
- Rescue terminal logs: `~/.droidagent/logs/terminal`
- OpenClaw gateway log: `~/.droidagent/logs/openclaw.log`
- llama.cpp log: `~/.droidagent/logs/llama-cpp.log`
- Signal daemon log: `~/.droidagent/logs/signal-daemon.log`
- Tailscale userspace log: `~/.droidagent/logs/tailscaled.log`
- LaunchAgent stdout: `~/.droidagent/logs/launch-agent.stdout.log`
- LaunchAgent stderr: `~/.droidagent/logs/launch-agent.stderr.log`

## Service paths

- DroidAgent data: `~/.droidagent`
- OpenClaw profile: `~/.openclaw-droidagent`
- LaunchAgent plist: `~/Library/LaunchAgents/com.droidagent.server.plist`
- Signal config dir: `~/.droidagent/signal-cli`
- Maintenance state mirror: `~/.droidagent/state/maintenance-status.json`

## Useful checks

```bash
pnpm verify
pnpm verify:full
pnpm hygiene:check
pnpm perf:server
pnpm perf:e2e
pnpm perf:live
pnpm perf:model-compare
pnpm perf:report
pnpm perf:baseline
pnpm perf:check
```

## LaunchAgent

- Install, start, stop, and uninstall are exposed in the Settings route and server API.
- The LaunchAgent runs `node apps/server/dist/index.js` with production-style log paths under `~/.droidagent/logs`.
- If you are currently running the server in a foreground terminal, stop that process after enabling the LaunchAgent so launchd can own port `4318`.
- `pnpm bootstrap` now avoids starting a duplicate foreground server when the LaunchAgent path already owns the host.

## Maintenance

- Settings owns the explicit maintenance controls for `app`, `runtime`, and `remote` scope restarts plus `drain-only`.
- Maintenance state is stored in SQLite and mirrored to `~/.droidagent/state/maintenance-status.json` so local scripts can avoid fighting an in-flight restart.
- While maintenance is active, new chat sends, new jobs, and new terminal sessions are blocked.
- Existing jobs are cancelled, the rescue terminal is closed with a visible reason, and active chat runs reconnect through the usual websocket resync path after recovery.
- Remote-scope maintenance is localhost-only because it can sever the canonical Tailscale path.

## Remote access

- Keep DroidAgent on loopback.
- Use Tailscale Serve when you want private tailnet-only phone access.
- If the normal macOS Tailscale daemon is unavailable, DroidAgent can start a userspace `tailscaled` process under `~/.droidagent/tailscale` and operate against its socket instead.
- After owner sign-in, Setup is only the first-run wizard: it prepares the default local runtime path and creates the Tailscale phone URL automatically when Tailscale is already authenticated.
- Once the operator path is ready, daily use should happen from `Chat`; Setup moves out of the primary bottom-nav flow.
- The Host drawer and Settings are the maintenance entry points. The rescue terminal stays outside the primary bottom nav so the operator flow stays focused on Chat, Files, Jobs, Models, and Settings.
- The same quickstart path also seeds `MEMORY.md`, `PREFERENCES.md`, `HEARTBEAT.md`, daily notes under `memory/`, and the workspace `skills/` directory.
- First-class workspace memory files are scaffold-repaired on demand, so `memory.status`, `memory.prepare`, `memory.today-note`, and opening `MEMORY.md` or `PREFERENCES.md` do not leak raw missing-file errors on a real host.
- `memory.prepare` is now async and single-flight. The API call returns quickly, the actual reindex continues in the background, and Settings shows queued/running/completed/failed state, progress label, error, and last duration.
- Durable memory capture is owner-reviewed. Chat messages and file selections create drafts first, then Settings edits the draft while the shared decision inbox stays authoritative for apply or dismiss.
- Suggested shell blocks from assistant replies can become `Run in Chat` or `Open in Terminal`. In-chat runs stay inside the workspace job jail; terminal suggestions are inserted but never auto-executed.
- The default local chat model is `qwen3.5:4b` with a `65k` context budget and thinking disabled.
- `gemma4:e4b` on Ollama at the same `65k` context budget is the current staged comparison candidate and should stay in the benchmark lane until the live compare artifacts justify a default swap.
- The maintained Gemma 4 candidate requires Ollama `0.20.0+`; `ollama show gemma4:e4b` now reports `vision`, `audio`, `tools`, and `thinking` on that backend.
- When Ollama reports `vision` for the selected primary model, DroidAgent reuses that same model for image and PDF analysis inside the chat composer.
- `qwen2.5vl:3b` only stays as the fallback multimodal model when the selected primary model is text-only.
- Vision-capable llama.cpp repos now also keep image/PDF analysis on the same local primary model instead of forcing everything back through the Ollama fallback path.
- Semantic memory defaults to local Ollama embeddings with `embeddinggemma:300m-qat-q8_0`; DroidAgent keeps fallback disabled so memory stays on-device instead of silently drifting to a cloud provider.
- Keep durable personalization in `PREFERENCES.md`; DroidAgent includes it in semantic recall so smaller local models can stay more useful and more operator-specific over time.
- Use the canonical remote URL for daily access when the same passkey provider already syncs to the phone.
- Generate a new bootstrap link only after the canonical remote URL is healthy and only when you need to enroll a new device-specific passkey.
- Use localhost only for maintenance and recovery tasks after canonical setup.

## Diagnostics

- Server timings are exposed at `GET /api/diagnostics/performance` for the signed-in owner.
- The Settings route shows the full client/server diagnostics card.
- The Settings route also shows semantic-memory readiness, embedding/index status, and the current `65k` local context budget.
- The Settings route now also exposes memory-prepare state and timings so semantic-memory regressions are visible in the same diagnostics surface as chat, files, and jobs.
- The Settings route also exposes editable pending memory drafts, the shared decision-backed memory review queue, current maintenance state, recent maintenance history, and timing sample age/count plus `ok`/`warn`/`error` sample totals so stale or degraded telemetry is obvious.
- Chat timing is split into accept, first-delta wait, first-delta forward, and full relay duration so model latency and DroidAgent overhead are not conflated.
- Diagnostics now also include websocket patch flush latency, chat history resync latency, and session-switch latency so live-path churn is visible.
- Perf artifacts now also track the first authenticated cold dashboard request, browser cold dashboard fetch, route switch, visible first token, memory prepare accepted/completion, and shared bundle chunks. Use `pnpm perf:baseline` to refresh the checked-in local baseline and `pnpm perf:check` to enforce the budgets.
- `pnpm perf:live` is the opt-in live OpenClaw/local-runtime validation lane, now runs against a seeded real runtime, and writes to `artifacts/perf/live/current/` instead of overwriting the deterministic artifacts.
- `pnpm perf:model-compare` runs the maintained live model comparison set, currently `qwen3.5:4b` vs `gemma4:e4b` at `65k` on Ollama, and writes the side-by-side summary to `artifacts/perf/model-compare/compare-summary.json`.
- The optional llama.cpp Gemma lane remains available as `gemma4_e4b_hf_65k` when you want a provider/runtime comparison instead of the maintained Ollama-vs-Ollama candidate test.
- The Settings route also shows the running build/version identity so the live host, screenshots, logs, and repo all stay on the same release line.
- The chat route now accepts local images, PDFs, Markdown, JSON, logs, and common code/text files. DroidAgent stores them under `~/.droidagent/uploads` and passes them through the real OpenClaw tool path instead of a parallel mock transcript.
- The chat route is the operator console: it surfaces live run state, OpenClaw approval cards, session-scoped decision context, tool summaries, attachments, code blocks, and client-side per-run timings.
- The rescue terminal is owner-only and PTY-backed. It defaults to a workspace shell and requires explicit confirmation before opening a full host shell.
- Use Jobs for replayable workspace commands. Use the rescue terminal only for interactive recovery work that needs a real shell.
- Performance artifacts are written under `artifacts/perf/`.
- Access, dashboard, runtime, provider, and startup-status reads use short-lived in-memory caches with explicit invalidation on mutations so the mobile shell stays responsive without serving long-lived stale state.
- Request-path warmup now waits for startup restore, then primes the main dashboard/access/runtime/provider caches before readiness completes, which keeps the first signed-in dashboard path off the coldest setup work.
- The global decision inbox is the main owner queue. Chat, Settings, and Channels are filtered views over the same decision ids instead of separate approval systems.
- `pnpm hygiene:check` is part of the expected local verify path now. It enforces canonical helper ownership, script reachability, the surface inventory docs, and size guardrails for new production files.
- OpenClaw runs with default thinking disabled unless you explicitly re-enable it in-session, while smart context management still controls compaction, pruning, and memory flush policy.
