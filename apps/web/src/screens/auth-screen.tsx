import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON as BrowserRegistrationOptions,
  type PublicKeyCredentialRequestOptionsJSON as BrowserAuthenticationOptions
} from "@simplewebauthn/browser";
import { useQueryClient } from "@tanstack/react-query";

import { useDroidAgentApp } from "../app-context";
import { postJson } from "../lib/api";

function bootstrapSuffix(): string {
  const token = new URLSearchParams(window.location.search).get("bootstrap");
  return token ? `?bootstrap=${encodeURIComponent(token)}` : "";
}

export function AuthScreen() {
  const queryClient = useQueryClient();
  const { authQuery, access, errorMessage, setErrorMessage } = useDroidAgentApp();

  async function handleRegister() {
    setErrorMessage(null);
    const suffix = bootstrapSuffix();
    const options = await postJson<PublicKeyCredentialCreationOptionsJSON>(`/api/auth/register/options${suffix}`, {});
    const response = await startRegistration({ optionsJSON: options as BrowserRegistrationOptions });
    await postJson(`/api/auth/register/verify${suffix}`, response);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["auth"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["access"] })
    ]);
  }

  async function handleLogin() {
    setErrorMessage(null);
    const options = await postJson<PublicKeyCredentialRequestOptionsJSON>("/api/auth/login/options", {});
    const response = await startAuthentication({ optionsJSON: options as BrowserAuthenticationOptions });
    await postJson("/api/auth/login/verify", response);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["auth"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["passkeys"] })
    ]);
  }

  const bootstrapToken = new URLSearchParams(window.location.search).get("bootstrap");

  return (
    <main className="auth-screen">
      <section className="hero-card">
        <div className="hero-kicker">DroidAgent</div>
        <h1>Mobile-first control for OpenClaw on your own Mac.</h1>
        <p>
          Passkey login, local-first runtimes, Tailscale-first phone access, workspace-scoped execution, and a PWA
          shell sized for a foldable device.
        </p>
        {access ? (
          <section className="status-block">
            <strong>Host access</strong>
            <p>{access.localhostOnlyMessage}</p>
            {access.canonicalOrigin ? <small>Canonical URL: {access.canonicalOrigin.origin}</small> : null}
            {bootstrapToken ? <small>Phone enrollment link detected. Complete owner passkey setup on this device.</small> : null}
          </section>
        ) : null}
        {errorMessage ? <p className="status-banner error">{errorMessage}</p> : null}
        <div className="hero-actions">
          {authQuery.data?.hasUser ? (
            <button onClick={() => void handleLogin()}>Sign in with Passkey</button>
          ) : (
            <button onClick={() => void handleRegister()}>
              {bootstrapToken ? "Complete Phone Enrollment" : "Create Owner Passkey"}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
