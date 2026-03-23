# Install Guide

## Prerequisites

- macOS on Apple Silicon
- Homebrew
- Node.js 22+
- pnpm 10+
- `openjdk` is required when you want to use `signal-cli`

## Bootstrap

```bash
pnpm bootstrap
```

The bootstrap script:

1. installs workspace dependencies
2. builds the shared package
3. builds the server and web app
4. starts the local DroidAgent server
5. opens the local browser UI

## First-run flow

1. Create the owner passkey.
2. Set the workspace root.
3. Install/start `Ollama` or `llama.cpp`.
4. Pull/select a model.
5. Let DroidAgent seed the dedicated `openclaw --profile droidagent` configuration.
6. Optionally store cloud provider keys in Keychain and activate a cloud model.
7. Optionally install/configure `signal-cli`, then either:
   - register a dedicated number and verify the code
   - link an existing Signal account by scanning the generated QR code
8. Optionally install and start the LaunchAgent for background startup.

## Homebrew runtime commands

```bash
brew install ollama
brew services start ollama

brew install llama.cpp

brew install openjdk signal-cli
```
