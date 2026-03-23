# Security

## Boundaries

- passkey auth is required for browser access
- default bind is loopback-only
- OpenClaw runs under a dedicated profile with token auth
- first-party file and job operations are limited to the configured workspace root
- first-party jobs reject `sudo`
- Signal is optional and does not bypass local approval policy

## Approval model

- DroidAgent surfaces pending OpenClaw exec approvals
- approval resolution is proxied through `exec.approval.resolve`
- Signal pairing uses OpenClaw’s pairing flow and stays owner-approved

## Secrets

The current implementation keeps non-secret state in SQLite. Provider secret storage is intentionally separated from repo state and should be expanded to Keychain-backed storage for cloud providers before wider deployment.

