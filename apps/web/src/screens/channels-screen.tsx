import { useEffect, useState } from "react";
import QRCode from "qrcode";

import type { ChannelStatus } from "@droidagent/shared";

import { useDashboardQuery } from "../app-data";
import { useDroidAgentApp } from "../app-context";
import { useDecisionActions } from "../hooks/use-decision-actions";
import { postJson } from "../lib/api";
import { getPendingPairingDecisions } from "../lib/dashboard-selectors";

export function ChannelsScreen() {
  const { runAction, setNotice } = useDroidAgentApp();
  const dashboardQuery = useDashboardQuery(true);
  const dashboard = dashboardQuery.data;
  const [signalPhone, setSignalPhone] = useState("");
  const [signalCaptcha, setSignalCaptcha] = useState("");
  const [signalVerificationCode, setSignalVerificationCode] = useState("");
  const [signalVerificationPin, setSignalVerificationPin] = useState("");
  const [signalDeviceName, setSignalDeviceName] = useState("DroidAgent");
  const [testTarget, setTestTarget] = useState("");
  const [testMessage, setTestMessage] = useState("DroidAgent Signal path is healthy.");
  const [linkQr, setLinkQr] = useState<string | null>(null);
  const canStartRegistration = signalPhone.trim().length > 0;
  const canVerifyRegistration = signalVerificationCode.trim().length > 0;
  const canStartLink = signalDeviceName.trim().length > 0;
  const canSendTestMessage = testTarget.trim().length > 0 && testMessage.trim().length > 0;

  const signal = dashboard?.channelConfig?.signal;
  const pairingDecisions = getPendingPairingDecisions(dashboard);
  const { resolveDecision } = useDecisionActions(dashboard?.decisions ?? []);

  useEffect(() => {
    if (!signal?.linkUri) {
      setLinkQr(null);
      return;
    }

    void QRCode.toDataURL(signal.linkUri, {
      margin: 1,
      width: 320
    }).then(setLinkQr);
  }, [signal?.linkUri]);

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
        <p>Signal stays secondary to the web shell, but this route now owns the full install, link, daemon, and pairing flow.</p>
        <div className="button-row">
          <button
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/install", {});
              }, "signal-cli installed or repaired.")
            }
          >
            Install or Repair
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/daemon/start", {});
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
              }, "Signal daemon stopped.")
            }
          >
            Stop Daemon
          </button>
        </div>
        <div className="stack-list">
          {(signal?.healthChecks ?? []).map((check) => (
            <article key={check.id} className="panel-card compact">
              <strong>{check.label}</strong>
              <small>{check.message}</small>
            </article>
          ))}
        </div>
        {signal?.compatibilityWarning ? <small>{signal.compatibilityWarning}</small> : null}
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
            disabled={!canStartRegistration}
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/register/start", {
                  phoneNumber: signalPhone,
                  captcha: signalCaptcha || undefined,
                  autoInstall: true
                });
              }, "Signal registration started.")
            }
          >
            Register via SMS
          </button>
          <button
            className="secondary"
            disabled={!canStartRegistration}
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/register/start", {
                  phoneNumber: signalPhone,
                  useVoice: true,
                  captcha: signalCaptcha || undefined,
                  autoInstall: true
                });
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
            disabled={!canVerifyRegistration}
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/register/verify", {
                  verificationCode: signalVerificationCode,
                  pin: signalVerificationPin || undefined
                });
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
            disabled={!canStartLink}
            onClick={() =>
              void runAction(async () => {
                const response = await postJson<{ linkUri: string }>("/api/channels/signal/link/start", {
                  deviceName: signalDeviceName
                });
                setNotice(`Scan the QR in Signal or use the deep link: ${response.linkUri}`);
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
              }, "Signal link flow cancelled.")
            }
          >
            Cancel Link
          </button>
        </div>
        {linkQr ? <img className="signal-qr" src={linkQr} alt="Signal device link QR code" /> : null}
        {signal?.linkUri ? <small>{signal.linkUri}</small> : null}
      </article>

      <article className="panel-card">
        <h3>Pending Signal Decisions</h3>
        <p>New Signal senders stay in pairing mode until you explicitly allow them.</p>
        <div className="stack-list">
          {pairingDecisions.length > 0 ? (
            pairingDecisions.map((decision) => (
              <article key={decision.id} className="panel-card compact">
                <strong>{decision.title}</strong>
                <small>{decision.summary}</small>
                <small>Code: {decision.sourceRef}</small>
                {decision.requestedAt ? <small>Requested {new Date(decision.requestedAt).toLocaleString()}</small> : null}
                <div className="button-row">
                  <button
                    onClick={() =>
                      void runAction(async () => {
                        await resolveDecision(decision, "approved", null);
                      }, "Signal pairing approved.")
                    }
                  >
                    Approve
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await resolveDecision(decision, "denied", null);
                      }, "Signal pairing denied.")
                    }
                  >
                    Deny
                  </button>
                </div>
              </article>
            ))
          ) : (
            <small>No pending Signal pairing requests.</small>
          )}
        </div>
      </article>

      <article className="panel-card">
        <h3>Send Test Message</h3>
        <p>Send a direct host-level Signal message to verify the linked account and local daemon path.</p>
        <label>
          Target
          <input value={testTarget} onChange={(event) => setTestTarget(event.target.value)} placeholder="+15555550123" />
        </label>
        <label>
          Message
          <input value={testMessage} onChange={(event) => setTestMessage(event.target.value)} />
        </label>
        <div className="button-row">
          <button
            disabled={!canSendTestMessage}
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/test-message", {
                  target: testTarget,
                  text: testMessage
                });
              }, "Signal test message sent.")
            }
          >
            Send Test Message
          </button>
          <button
            className="secondary"
            onClick={() =>
              void runAction(async () => {
                await postJson("/api/channels/signal/disconnect", {
                  unregister: false,
                  clearLocalData: true
                });
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
