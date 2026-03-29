# Install Guide

## Prerequisites

- macOS on Apple Silicon
- Homebrew
- Node.js 22+
- pnpm 10+
- Tailscale only when you want private remote access
- `openjdk` only when you want Signal support

## One-command bootstrap

```bash
pnpm bootstrap
pnpm run doctor
```

The bootstrap script:

1. runs preflight checks for Node, pnpm, and Homebrew
2. installs workspace dependencies
3. builds shared, server, and web
4. ensures `~/.droidagent` app directories exist
5. optionally starts Ollama if already installed
6. reuses an already healthy local server when one is present
7. otherwise restarts the LaunchAgent-backed host when that path is installed
8. otherwise starts a background local server and writes its output to `~/.droidagent/logs/bootstrap-server.log`
9. waits for health readiness
10. opens `http://localhost:4318`

Bootstrap is idempotent and safe to re-run.

Run `pnpm run doctor` after bootstrap when you want a non-mutating environment check.

## First-run flow

1. Create the owner passkey on localhost.
2. Open `Setup`.
3. Use the quickstart action to let DroidAgent prepare the workspace, Ollama, OpenClaw, the default local chat model, the default local multimodal model, and the default local embedding model automatically.
4. The same quickstart pass also seeds the workspace memory, preferences, and skills scaffold automatically, then builds the local semantic-memory index.
5. If Tailscale is already authenticated on the Mac, quickstart also creates the phone URL automatically.
6. After those checks are ready, DroidAgent routes daily use into `Chat`, not back into Setup.
7. Use Manual Controls only when you want a different workspace, a different local model, or llama.cpp.
8. Optionally enroll additional passkeys from Settings.
9. Optionally store cloud-provider keys in Keychain.
10. Optionally install and start the LaunchAgent if you want launchd to own the host process permanently.
11. Optionally configure Signal from Settings.

The v1 live acceptance target for this repo is `web/PWA + owner passkey + Tailscale remote + Ollama local runtime`.

## Remote phone bootstrap

1. Open DroidAgent on localhost on the Mac.
2. Let the Setup quickstart create the canonical phone URL automatically when Tailscale is already authenticated.
3. If the standard Tailscale daemon is not available on macOS, DroidAgent can fall back to a userspace `tailscaled` process under `~/.droidagent/tailscale`.
4. Authenticate Tailscale on the Mac before expecting DroidAgent to publish the phone URL.
5. If the same passkey provider already syncs to the phone, open the canonical remote URL directly and sign in.
6. Use a one-time bootstrap link only when you need to enroll a new device-specific passkey after the canonical URL is healthy.
7. Use the canonical remote URL for daily phone access after enrollment; bootstrap links are only for adding a device.
8. The default local model path is `qwen3.5:4b` at `65k` context with thinking disabled, smart context management enabled, `qwen2.5vl:3b` handling image/PDF chat attachments locally, and `embeddinggemma:300m-qat-q8_0` handling semantic memory locally.
9. The running host reports its own build/version line in Settings and diagnostics so screenshots, docs, and support notes stay aligned.

## Manual setup

```bash
pnpm install
pnpm build
node apps/server/dist/index.js
```

Then open `http://localhost:4318`.

## Recovery

| Error                       | Recovery                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Node.js not installed       | `brew install node`                                                                                        |
| Node.js < 22                | `brew upgrade node`                                                                                        |
| pnpm not found              | `npm install -g pnpm`                                                                                      |
| Homebrew not found          | Install from https://brew.sh                                                                               |
| Build failed                | Run `pnpm build` manually                                                                                  |
| Docs or command drift       | Run `pnpm docs:check`                                                                                      |
| Tailscale URL unavailable   | Install/sign in to Tailscale, or let DroidAgent start the userspace daemon, then enable Serve from the PWA |
| Server did not become ready | Check `~/.droidagent/logs`                                                                                 |
