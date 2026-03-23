# Architecture

## Overview

- `apps/server`
  - authenticates the operator with passkeys
  - stores state in SQLite under `~/.droidagent`
  - manages runtimes and OpenClaw through CLI/process supervision
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
- `openclaw pairing ...`

The profile is isolated as `openclaw --profile droidagent`.

## Local runtimes

- `Ollama`
  - default onboarding path
  - managed by Homebrew services
- `llama.cpp`
  - advanced path
  - started as a supervised `llama-server` process
  - registered into OpenClaw as an OpenAI-compatible provider

