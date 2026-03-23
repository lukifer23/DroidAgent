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

## LaunchAgent

- Install, start, stop, and uninstall are exposed through the DroidAgent UI and server API.
- The LaunchAgent runs `node apps/server/dist/index.js` with a production-style environment and log paths under `~/.droidagent/logs`.
- If you are currently running the server manually in a terminal, stop that foreground process after enabling the LaunchAgent so launchd can own port `4318`.
