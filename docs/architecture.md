# Architecture

## Overview

- `apps/server`
  - authenticates the operator with passkeys
  - stores state in SQLite under `~/.droidagent`
  - stores cloud provider API keys in the macOS login Keychain
  - manages runtimes and OpenClaw through CLI/process supervision
  - manages the local LaunchAgent lifecycle through `launchctl`
  - manages `signal-cli` registration/linking and a local HTTP daemon
  - exposes the browser API and WebSocket update stream
- `apps/web`
  - mobile-first PWA
  - session/chat shell
  - workspace browser
  - job launcher and status surfaces
  - runtime/channel settings
- `packages/shared`
  - common schemas and event contracts

## OpenClaw integration

DroidAgent treats OpenClaw as an external engine, not an internal library API. The server uses:

- `openclaw config set`
- `openclaw gateway run`
- `openclaw gateway call`
- `openclaw approvals get`
- `openclaw channels status`
- `openclaw channels add/remove`
- `openclaw pairing ...`
- `openclaw models set`

The profile is isolated as `openclaw --profile droidagent`.

## Local runtimes

- `Ollama`
  - default onboarding path
  - managed by Homebrew services
- `llama.cpp`
  - advanced path
  - started as a supervised `llama-server` process
  - registered into OpenClaw as an OpenAI-compatible provider

## Signal path

- `signal-cli` is isolated under `~/.droidagent/signal-cli`
- DroidAgent prefers the brewed OpenJDK runtime for Signal compatibility
- registration state, link URI, daemon PID, and daemon URL are tracked in app state
- OpenClaw is configured against the local Signal HTTP daemon instead of relying on ad hoc shell invocations
