# Architecture

## Overview

- `apps/server`
  - authenticates the owner with passkeys
  - stores state in SQLite under `~/.droidagent`
  - stores cloud-provider API keys in the macOS login Keychain
  - manages runtimes and OpenClaw through CLI/process supervision
  - exposes the browser REST API and owner-authenticated WebSocket update stream
  - owns the only browser-facing integration boundary; the browser never receives an OpenClaw token
- `apps/web`
  - mobile-first routed PWA
  - Setup, Chat, Files, Jobs, Models, Channels, Settings
  - reconnect-safe streaming, install prompt, Fold-friendly layout
- `packages/shared`
  - common schemas for dashboard state, files, jobs, passkeys, access/bootstrap payloads, and WebSocket events

## Harness boundary

- DroidAgent now treats OpenClaw through an internal harness adapter boundary.
- v1 only ships the OpenClaw implementation, but generic consumers depend on the harness surface for:
  - session listing and history
  - message send/abort
  - approvals
  - channel status
  - runtime-model configuration
  - harness health

## OpenClaw integration

- Lifecycle, config, model registration, approvals, channels, and pairing continue through the OpenClaw CLI/Gateway.
- Live chat now uses a server-side relay path into the OpenClaw Chat Completions endpoint on the local gateway.
- DroidAgent re-emits sanitized stream events to the browser over its own WebSocket.
- OpenClaw remains loopback-only with token auth.

## Local runtimes

- `Ollama`
  - default onboarding path
  - managed by Homebrew services
- `llama.cpp`
  - advanced path
  - started as a supervised `llama-server` process
  - registered into OpenClaw as an OpenAI-compatible provider

## Remote access

- local daily control starts on loopback
- Tailscale Serve is the supported remote phone path
- DroidAgent tracks canonical origin, bootstrap token issuance, and phone-side owner enrollment state
- after canonical setup, the Tailscale URL is the primary daily-use origin

## File and job model

- files are addressed by workspace-relative path, never absolute host path
- text files can be loaded and saved through the PWA with conflict checks and atomic writes
- jobs are owner-submitted shell commands inside the configured workspace jail
- stdout/stderr are streamed live and persisted under `~/.droidagent/logs/jobs`

## Optional Signal path

- `signal-cli` stays isolated under `~/.droidagent/signal-cli`
- the PWA remains the primary control surface
- Signal stays available as an advanced secondary owner ingress, not a required onboarding step
