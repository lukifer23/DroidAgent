# Security

## Boundaries

- passkey auth is required for browser access
- default bind is loopback-only
- OpenClaw runs under a dedicated profile with token auth
- first-party file and job operations are limited to the configured workspace root
- first-party jobs reject `sudo`
- Signal is optional and does not bypass local approval policy
- LaunchAgent control is local-only and still gated behind passkey auth

## Approval model

- DroidAgent surfaces pending OpenClaw exec approvals
- approval resolution is proxied through `exec.approval.resolve`
- Signal pairing uses OpenClaw’s pairing flow and stays owner-approved

## Secrets

- non-secret state lives in SQLite under `~/.droidagent`
- cloud provider API keys are stored as generic passwords in the macOS login Keychain
- provider secrets are injected into OpenClaw child-process environments at runtime and are not written into repo files or SQLite
- the OpenClaw profile `.env` only carries the local non-secret Ollama token placeholder used for loopback configuration
