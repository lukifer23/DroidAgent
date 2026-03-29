# Architecture

## Overview

- `apps/server`
  - authenticates the owner with passkeys
  - stores state in SQLite under `~/.droidagent`
  - stores cloud-provider API keys in the macOS login Keychain
  - manages runtimes and OpenClaw through CLI/process supervision
  - exposes the running build/version identity to the shell and diagnostics
  - exposes the browser REST API and owner-authenticated WebSocket update stream
  - owns the only browser-facing integration boundary; the browser never receives an OpenClaw token
- `apps/web`
  - mobile-first routed PWA
  - Setup, Chat, Files, Jobs, Models, Settings
  - reconnect-safe streaming, install prompt, Fold-friendly layout
- `packages/shared`
  - common schemas for dashboard state, files, jobs, passkeys, access/bootstrap payloads, diagnostics telemetry, and WebSocket events

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
- Tailscale Serve is the primary guided remote phone path
- a Cloudflare named tunnel remains an advanced backend path but is intentionally hidden from the main operator flow
- DroidAgent tracks canonical origin, bootstrap token issuance, and phone-side owner enrollment state
- after canonical setup, the selected remote URL becomes the primary daily-use origin

## Context management

- DroidAgent writes OpenClaw compaction policy into the dedicated `droidagent` profile
- Smart Context Management enables safeguard compaction, pre-compaction memory flush, and provider-aware context pruning
- Anthropic and OpenRouter Anthropic models use `cache-ttl` pruning
- local runtimes keep pruning off while still using compaction and memory flush

## File and job model

- files are addressed by workspace-relative path, never absolute host path
- text files can be loaded and saved through the PWA with conflict checks and atomic writes
- jobs are owner-submitted shell commands inside the configured workspace jail
- stdout/stderr are streamed live and persisted under `~/.droidagent/logs/jobs`

## Diagnostics and performance

- the server records rolling in-memory timing samples for HTTP requests, dashboard snapshots, chat relay timing, file operations, and job execution
- the client records route, chat, reconnect, file, and job timings locally
- the Settings route surfaces a compact diagnostics card
- the benchmark scripts write JSON artifacts under `artifacts/perf/`

## Optional Signal path

- `signal-cli` stays isolated under `~/.droidagent/signal-cli`
- the PWA remains the primary control surface
- Signal stays available as an advanced secondary owner ingress, not a required onboarding step
- advanced Signal management stays secondary to the main Setup/Chat/Files/Jobs/Models/Settings flow
