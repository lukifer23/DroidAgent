# Operations

## Local development

```bash
pnpm dev
```

## Production-style local build

```bash
pnpm install
pnpm --filter @droidagent/shared build
pnpm build
node apps/server/dist/index.js
```

## Logs

- DroidAgent logs: `~/.droidagent/logs`
- Job logs: `~/.droidagent/logs/jobs`
- OpenClaw gateway log: `~/.droidagent/logs/openclaw.log`
- llama.cpp log: `~/.droidagent/logs/llama-cpp.log`
- Signal daemon log: `~/.droidagent/logs/signal-daemon.log`
- LaunchAgent stdout: `~/.droidagent/logs/launch-agent.stdout.log`
- LaunchAgent stderr: `~/.droidagent/logs/launch-agent.stderr.log`

## Service paths

- DroidAgent data: `~/.droidagent`
- OpenClaw profile: `~/.openclaw-droidagent`
- LaunchAgent plist: `~/Library/LaunchAgents/com.droidagent.server.plist`
- Signal config dir: `~/.droidagent/signal-cli`

## Useful checks

```bash
pnpm test
pnpm typecheck
pnpm build
```

## LaunchAgent

- Install, start, stop, and uninstall are exposed in the Settings route and server API.
- The LaunchAgent runs `node apps/server/dist/index.js` with production-style log paths under `~/.droidagent/logs`.
- If you are currently running the server in a foreground terminal, stop that process after enabling the LaunchAgent so launchd can own port `4318`.

## Remote access

- Keep DroidAgent on loopback.
- Use Tailscale Serve from the PWA when you need remote phone access.
- Use the canonical Tailscale URL for daily access after phone bootstrap.
