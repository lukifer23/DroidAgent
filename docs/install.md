# Install Guide

## Prerequisites

- macOS on Apple Silicon
- Homebrew
- Node.js 22+
- pnpm 10+

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
6. Optionally install/configure `signal-cli`.

## Homebrew runtime commands

```bash
brew install ollama
brew services start ollama

brew install llama.cpp

brew install signal-cli
```

