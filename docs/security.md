# Security

## Boundaries

- Passkey auth is required for browser access after owner enrollment.
- OpenClaw stays loopback-only and token-protected.
- The browser never receives an OpenClaw token and never connects to OpenClaw directly.
- Default bind is loopback-only; Tailscale Serve is the supported remote path.
- File and job operations are limited to the configured workspace root.
- Public file APIs use workspace-relative paths instead of absolute host paths.
- Text-file saving uses path jail checks, conflict detection, and atomic writes.
- Signal is optional and remains a lower-trust ingress than the local web session.

## Origin and bootstrap guard

- State-changing requests enforce origin checks through `accessService.assertCanonicalMutation`.
- When a canonical Tailscale origin is configured, mutations must originate from that URL, except explicit localhost maintenance flows.
- Phone bootstrap uses a one-time token tied to the canonical origin.
- Bootstrap tokens are hashed, time-limited, and consumed on use.

## Exec and approval model

- Owner-submitted jobs run directly through DroidAgent inside the workspace jail and command policy.
- Agent-requested exec continues through OpenClaw approvals.
- Dangerous primitives remain blocked (`sudo`, `su`, destructive `rm`, etc.).
- Job execution enforces timeout and output ceilings.
- Replayable stdout/stderr logs live under `~/.droidagent/logs/jobs`.

## Secrets

- Non-secret state lives in SQLite under `~/.droidagent`.
- Cloud-provider API keys are stored as generic passwords in the macOS login Keychain.
- Provider secrets are injected into OpenClaw child-process environments at runtime and are not written into SQLite or repo files.
- The OpenClaw profile `.env` only carries the local non-secret Ollama token placeholder used for loopback configuration.

## Not in scope for v1

- public internet exposure outside Tailscale
- Cloudflare Tunnel support
- multi-user RBAC
- Windows host parity
- browser-direct access to OpenClaw HTTP or WebSocket control surfaces
