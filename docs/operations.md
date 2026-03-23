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

## Service paths

- DroidAgent data: `~/.droidagent`
- OpenClaw profile: `~/.openclaw-droidagent`
- Planned launch agent path: `~/Library/LaunchAgents/com.droidagent.server.plist`

