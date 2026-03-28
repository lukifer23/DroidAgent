# Remote Access

## Supported paths

- `Tailscale Serve`
  - private-first default
  - best fit when the phone can join the same tailnet

## Unsupported paths in v1

- raw router port forwarding
- Tailscale Funnel
- Cloudflare Quick Tunnels
- ngrok and similar ad-hoc public tunnel tools
- direct browser access to OpenClaw HTTP or WebSocket endpoints

## Tailscale flow

1. Install and sign in to Tailscale on the Mac.
2. If the normal Tailscale daemon is unavailable on macOS, let DroidAgent start its userspace fallback daemon.
3. Open `Setup` and let the quickstart pass create the Tailscale phone URL automatically, or enable Tailscale Serve from Settings when you want manual control.
4. DroidAgent sets the Tailscale URL as canonical as part of that quickstart/manual enable path.
5. If the same passkey provider already syncs to the phone, open the canonical URL directly and sign in.
6. Use a one-time bootstrap link only when you need to enroll a new device-specific passkey after the canonical URL is healthy.

Notes:

- DroidAgent keeps the app itself on loopback and only exposes the canonical remote URL through Tailscale Serve.
- The userspace fallback stores its state under `~/.droidagent/tailscale` and writes logs to `~/.droidagent/logs/tailscaled.log`.
- If the userspace daemon starts but is not authenticated yet, run the Tailscale login flow before expecting a canonical URL.

## Canonical origin rules

- DroidAgent tracks one canonical daily-use origin at a time.
- State-changing requests must originate from that canonical URL.
- Localhost remains allowed only for explicit bootstrap and maintenance flows.
- Phone bootstrap links are only issued when the current canonical URL is reachable.
- Switching the canonical source clears any previously issued bootstrap link.

## Notes

- The streamlined v1 operator flow assumes Tailscale as the only guided remote path.
- The phone should either use a synced passkey provider or be enrolled once through a one-time device link from the Mac.
- DroidAgent keeps the app itself on loopback and only exposes the canonical remote URL through Tailscale Serve.
- The workspace and OpenClaw bootstrap remain local on the Mac; the phone is only the control surface.

Further reading:

- [Install Guide](./install.md)
- [Operations Guide](./operations.md)
