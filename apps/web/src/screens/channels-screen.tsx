import { useState } from "react";

import type { ChannelStatus } from "@droidagent/shared";

import { useDroidAgentApp } from "../app-context";
import { postJson } from "../lib/api";

export function ChannelsScreen() {
  const { dashboard, runAction, refreshDashboard, setNotice } = useDroidAgentApp();
  const [signalPhone, setSignalPhone] = useState("");
  const [signalCaptcha, setSignalCaptcha] = useState("");
  const [signalVerificationCode, setSignalVerificationCode] = useState("");
  const [signalVerificationPin, setSignalVerificationPin] = useState("");
  const [signalDeviceName, setSignalDeviceName] = useState("DroidAgent");
  const [pairingCode, setPairingCode] = useState("");

  const signal = dashboard?.channelConfig.signal;

  return (
    <section className="stack-list">
      {(dashboard?.channels ?? []).map((channel: ChannelStatus) => (
        <article key={channel.id} className="panel-card">
          <h3>{channel.label}</h3>
          <p>{channel.healthMessage}</p>
        </article>
      ))}

      <article className="panel-card">
        <h3>Signal Runtime</h3>
        <p>Signal is optional. The web app stays primary, and Signal remains an advanced owner ingress.</p>
        <div className="button-row">
          <button
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/install", {});
                await refreshDashboard();
              }, "signal-cli installed or repaired.")
            }
          >
            Install or Repair signal-cli
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/daemon/start", {});
                await refreshDashboard();
              }, "Signal daemon started.")
            }
          >
            Start Daemon
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/daemon/stop", {});
                await refreshDashboard();
              }, "Signal daemon stopped.")
            }
          >
            Stop Daemon
          </button>
        </div>
        <pre>{JSON.stringify(signal ?? {}, null, 2)}</pre>
      </article>

      <article className="panel-card">
        <h3>Register Dedicated Number</h3>
        <label>
          Phone number
          <input value={signalPhone} onChange={(event) => setSignalPhone(event.target.value)} placeholder="+15555550123" />
        </label>
        <label>
          Captcha token
          <input
            value={signalCaptcha}
            onChange={(event) => setSignalCaptcha(event.target.value)}
            placeholder="Optional, only when Signal requests one"
          />
        </label>
        <div className="button-row">
          <button
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/register/start", {
                  phoneNumber: signalPhone,
                  captcha: signalCaptcha || undefined,
                  autoInstall: true
                });
                await refreshDashboard();
              }, "Signal registration started.")
            }
          >
            Register via SMS
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/register/start", {
                  phoneNumber: signalPhone,
                  useVoice: true,
                  captcha: signalCaptcha || undefined,
                  autoInstall: true
                });
                await refreshDashboard();
              }, "Voice verification requested.")
            }
          >
            Use Voice Call
          </button>
        </div>
        <div className="field-stack">
          <label>
            Verification code
            <input value={signalVerificationCode} onChange={(event) => setSignalVerificationCode(event.target.value)} placeholder="123-456" />
          </label>
          <label>
            Registration lock PIN
            <input value={signalVerificationPin} onChange={(event) => setSignalVerificationPin(event.target.value)} placeholder="Optional" />
          </label>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/register/verify", {
                  verificationCode: signalVerificationCode,
                  pin: signalVerificationPin || undefined
                });
                await refreshDashboard();
              }, "Signal account verified.")
            }
          >
            Verify Registration
          </button>
        </div>
      </article>

      <article className="panel-card">
        <h3>Link Existing Signal App</h3>
        <label>
          Device name
          <input value={signalDeviceName} onChange={(event) => setSignalDeviceName(event.target.value)} />
        </label>
        <div className="button-row">
          <button
            onClick={() =>
              void runAction(async () => {
                const response = await postJson<{ linkUri: string }>("/api/channels/signal/link/start", {
                  deviceName: signalDeviceName
                });
                setNotice(`Scan the QR in Signal. Link URI: ${response.linkUri}`);
                await refreshDashboard();
              })
            }
          >
            Start Link Flow
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/link/cancel", {});
                await refreshDashboard();
              }, "Signal link flow cancelled.")
            }
          >
            Cancel Link
          </button>
        </div>
        {signal?.linkUri ? <pre>{signal.linkUri}</pre> : null}
      </article>

      <article className="panel-card">
        <h3>OpenClaw Pairing</h3>
        <p>Inbound Signal DMs stay on pairing mode by default. Approve the pairing code after the first contact.</p>
        <input value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} placeholder="Pairing code" />
        <div className="button-row">
          <button
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/pairing/approve", {
                  code: pairingCode
                });
                await refreshDashboard();
              }, "Signal pairing approved.")
            }
          >
            Approve Pairing
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/disconnect", {
                  unregister: false,
                  clearLocalData: true
                });
                await refreshDashboard();
              }, "Signal channel disconnected.")
            }
          >
            Disconnect Signal
          </button>
        </div>
      </article>
    </section>
  );
}
