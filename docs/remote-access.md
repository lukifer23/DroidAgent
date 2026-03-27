# Remote Access

## Supported paths

- `Tailscale Serve`
  - private-first default
  - best fit when the phone can join the same tailnet
- `Cloudflare named tunnel`
  - supported public path for v1
  - requires a stable hostname and tunnel token
  - DroidAgent still stays loopback-only on the Mac; `cloudflared` proxies to `http://127.0.0.1:4318`

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

## Cloudflare flow

1. Create a named Cloudflare Tunnel and a stable public hostname in your Cloudflare account.
2. Copy the tunnel token for that named tunnel.
3. In Setup Advanced or Settings, enter the public hostname and tunnel token.
4. Enable the Cloudflare tunnel.
5. After the public URL is healthy, set Cloudflare as canonical.
6. Open the canonical Cloudflare URL directly when your passkey provider already syncs to the phone, or generate a one-time bootstrap link only when a new device-specific passkey is required.

Notes:

- DroidAgent normalizes the hostname server-side.
- After the first successful enable, you can reuse the stored Keychain token without pasting it again.
- If Cloudflare is the active canonical origin for an enrolled owner, DroidAgent refuses to stop that tunnel until you switch canonical access elsewhere.

## Canonical origin rules

- DroidAgent tracks one canonical daily-use origin at a time.
- State-changing requests must originate from that canonical URL.
- Localhost remains allowed only for explicit bootstrap and maintenance flows.
- Switching the canonical source between Tailscale and Cloudflare is supported from the PWA.
- Phone bootstrap links are only issued when the current canonical URL is reachable.
- Switching the canonical source clears any previously issued bootstrap link.

## Secrets and logs

- Cloudflare tunnel tokens are stored in the macOS login Keychain.
- Only non-secret Cloudflare metadata is stored in DroidAgent state.
- Cloudflare tunnel logs are written to `~/.droidagent/logs/cloudflared.log`.

Further reading:

- [Install Guide](./install.md)
- [Operations Guide](./operations.md)
