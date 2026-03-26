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
2. From Setup or Settings, enable Tailscale Serve.
3. Set the Tailscale URL as canonical.
4. Generate the one-time phone bootstrap link.
5. Open that link on the phone and enroll the passkey.

## Cloudflare flow

1. Create a named Cloudflare Tunnel and a stable public hostname in your Cloudflare account.
2. Copy the tunnel token for that named tunnel.
3. In Setup or Settings, enter the public hostname and tunnel token.
4. Enable the Cloudflare tunnel.
5. After the public URL is healthy, set Cloudflare as canonical.
6. Generate the one-time phone bootstrap link and enroll the phone passkey.

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
