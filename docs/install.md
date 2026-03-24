# Install Guide

## Prerequisites

- macOS on Apple Silicon
- Homebrew
- Node.js 22+
- pnpm 10+
- `openjdk` only when you want Signal support

## One-command bootstrap

```bash
pnpm bootstrap
```

The bootstrap script:

1. runs preflight checks for Node, pnpm, and Homebrew
2. installs workspace dependencies
3. builds shared, server, and web
4. ensures `~/.droidagent` app directories exist
5. optionally starts Ollama if already installed
6. starts the DroidAgent server
7. waits for health readiness
8. opens `http://127.0.0.1:4318`

Bootstrap is idempotent and safe to re-run.

## First-run flow

1. Create the owner passkey on localhost.
2. Set the workspace root.
3. Install/start Ollama or llama.cpp.
4. Pull/select the default model.
5. Let DroidAgent seed the dedicated `openclaw --profile droidagent` configuration.
6. Optionally enable Tailscale Serve and generate a phone bootstrap link.
7. Optionally enroll additional passkeys from Settings.
8. Optionally store cloud-provider keys in Keychain.
9. Optionally install and start the LaunchAgent.
10. Optionally configure Signal from the Channels route.

## Remote phone bootstrap

1. Open DroidAgent on localhost on the Mac.
2. Enable Tailscale Serve from Setup or Settings.
3. Generate the one-time phone bootstrap link.
4. Open that link on the phone and complete owner-passkey enrollment.
5. Use the canonical Tailscale URL for daily phone access.

## Manual setup

```bash
pnpm install
pnpm --filter @droidagent/shared build
pnpm build
node apps/server/dist/index.js
```

Then open `http://127.0.0.1:4318`.

## Recovery

| Error | Recovery |
|-------|----------|
| Node.js not installed | `brew install node` |
| Node.js < 22 | `brew upgrade node` |
| pnpm not found | `npm install -g pnpm` |
| Homebrew not found | Install from https://brew.sh |
| Build failed | Run `pnpm build` manually |
| Tailscale URL unavailable | Install/sign in to Tailscale and enable Serve from the PWA |
| Server did not become ready | Check `~/.droidagent/logs` |
