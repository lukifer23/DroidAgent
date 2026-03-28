# Operations

## Local development

```bash
pnpm dev
pnpm doctor
```

## Production-style local build

```bash
pnpm install
pnpm build
node apps/server/dist/index.js
```

## Logs

- DroidAgent logs: `~/.droidagent/logs`
- Job logs: `~/.droidagent/logs/jobs`
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

## Useful checks

```bash
pnpm verify
pnpm verify:full
pnpm perf:server
pnpm perf:e2e
pnpm perf:report
```

## LaunchAgent

- Install, start, stop, and uninstall are exposed in the Settings route and server API.
- The LaunchAgent runs `node apps/server/dist/index.js` with production-style log paths under `~/.droidagent/logs`.
- If you are currently running the server in a foreground terminal, stop that process after enabling the LaunchAgent so launchd can own port `4318`.

## Remote access

- Keep DroidAgent on loopback.
- Use Tailscale Serve when you want private tailnet-only phone access.
- If the normal macOS Tailscale daemon is unavailable, DroidAgent can start a userspace `tailscaled` process under `~/.droidagent/tailscale` and operate against its socket instead.
- After owner sign-in, the Setup route is the fast path: it prepares the default local runtime path and creates the Tailscale phone URL automatically when Tailscale is already authenticated.
- The same quickstart path also seeds `MEMORY.md`, `PREFERENCES.md`, `HEARTBEAT.md`, daily notes under `memory/`, and the workspace `skills/` directory.
- Semantic memory defaults to local Ollama embeddings with `embeddinggemma:300m-qat-q8_0`; DroidAgent keeps fallback disabled so memory stays on-device instead of silently drifting to a cloud provider.
- Keep durable personalization in `PREFERENCES.md`; DroidAgent includes it in semantic recall so smaller local models can stay more useful and more operator-specific over time.
- Use the canonical remote URL for daily access when the same passkey provider already syncs to the phone.
- Generate a new bootstrap link only after the canonical remote URL is healthy and only when you need to enroll a new device-specific passkey.
- Use localhost only for maintenance and recovery tasks after canonical setup.

## Diagnostics

- Server timings are exposed at `GET /api/diagnostics/performance` for the signed-in owner.
- The Settings route shows a compact client/server diagnostics card.
- The Settings route also shows semantic-memory readiness, embedding/index status, and the current `65k` local context budget.
- The Settings route now also exposes memory-prep timings so semantic-memory regressions are visible in the same diagnostics surface as chat, files, and jobs.
- Performance artifacts are written under `artifacts/perf/`.
- Access, dashboard, runtime, provider, and startup-status reads use short-lived in-memory caches with explicit invalidation on mutations so the mobile shell stays responsive without serving long-lived stale state.
- OpenClaw runs with default thinking disabled unless you explicitly re-enable it in-session, while smart context management still controls compaction, pruning, and memory flush policy.
