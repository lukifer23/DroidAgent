import { useEffect, useMemo, useState } from "react";
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON as BrowserRegistrationOptions,
  type PublicKeyCredentialRequestOptionsJSON as BrowserAuthenticationOptions,
} from "@simplewebauthn/browser";
import { useQueryClient } from "@tanstack/react-query";

import { useAccessQuery, useAuthQuery } from "../app-data";
import { useDroidAgentApp } from "../app-context";
import { postJson } from "../lib/api";

function bootstrapSuffix(): string {
  const token = new URLSearchParams(window.location.search).get("bootstrap");
  return token ? `?bootstrap=${encodeURIComponent(token)}` : "";
}

interface PasskeySupportState {
  checked: boolean;
  secureContext: boolean;
  hasWebAuthn: boolean;
  platformAuthenticatorAvailable: boolean | null;
}

function normalizePasskeyError(
  error: unknown,
  action: "registration" | "login",
): string {
  const name =
    typeof error === "object" && error && "name" in error
      ? String(error.name)
      : "";
  const message =
    error instanceof Error ? error.message : "Passkey action failed.";

  if (
    /secure context/i.test(message) ||
    (!window.isSecureContext && /webauthn|publickeycredential/i.test(message))
  ) {
    return "Passkeys need a secure browser context. Use DroidAgent from localhost on the Mac or over the configured HTTPS remote URL.";
  }

  if (
    name === "NotAllowedError" ||
    /timed out|abort|cancel|not allowed/i.test(message)
  ) {
    return action === "registration"
      ? "Passkey enrollment was canceled or blocked. If no browser prompt appeared, try Safari or Chrome on the Mac and confirm Touch ID or your passkey prompt is available."
      : "Passkey sign-in was canceled or blocked. If no browser prompt appeared, try Safari or Chrome on the Mac and confirm your passkey prompt is available.";
  }

  if (
    name === "NotSupportedError" ||
    /webauthn is not supported|publickeycredential/i.test(message)
  ) {
    return "This browser context does not expose the WebAuthn APIs DroidAgent needs for passkeys. Open the app in a current Safari, Chrome, or Edge session.";
  }

  if (name === "InvalidStateError") {
    return action === "registration"
      ? "This browser reported that the passkey is already registered. Try signing in instead."
      : "This browser rejected the passkey state. Refresh the page and try again.";
  }

  return message;
}

export function AuthScreen() {
  const queryClient = useQueryClient();
  const { errorMessage, setErrorMessage } = useDroidAgentApp();
  const authQuery = useAuthQuery();
  const accessQuery = useAccessQuery();
  const access = accessQuery.data;
  const [passkeySupport, setPasskeySupport] = useState<PasskeySupportState>({
    checked: false,
    secureContext:
      typeof window !== "undefined" ? window.isSecureContext : false,
    hasWebAuthn:
      typeof window !== "undefined"
        ? typeof window.PublicKeyCredential !== "undefined"
        : false,
    platformAuthenticatorAvailable: null,
  });
  const [pendingAction, setPendingAction] = useState<
    "register" | "login" | null
  >(null);

  useEffect(() => {
    const loopbackIpHosts = new Set(["127.0.0.1", "::1", "[::1]"]);
    if (!loopbackIpHosts.has(window.location.hostname)) {
      return;
    }

    const redirected = new URL(window.location.href);
    redirected.hostname = "localhost";
    window.location.replace(redirected.toString());
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function probePasskeySupport() {
      const secureContext = window.isSecureContext;
      const hasWebAuthn = typeof window.PublicKeyCredential !== "undefined";
      let platformAuthenticatorAvailable: boolean | null = null;

      if (
        hasWebAuthn &&
        typeof window.PublicKeyCredential
          .isUserVerifyingPlatformAuthenticatorAvailable === "function"
      ) {
        try {
          platformAuthenticatorAvailable =
            await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        } catch {
          platformAuthenticatorAvailable = null;
        }
      }

      if (cancelled) {
        return;
      }

      setPasskeySupport({
        checked: true,
        secureContext,
        hasWebAuthn,
        platformAuthenticatorAvailable,
      });
    }

    void probePasskeySupport();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleRegister() {
    setErrorMessage(null);
    setPendingAction("register");
    try {
      const suffix = bootstrapSuffix();
      const options = await postJson<PublicKeyCredentialCreationOptionsJSON>(
        `/api/auth/register/options${suffix}`,
        {},
      );
      const response = await startRegistration({
        optionsJSON: options as BrowserRegistrationOptions,
      });
      await postJson(`/api/auth/register/verify${suffix}`, response);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["auth"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["access"] }),
      ]);
    } catch (error) {
      setErrorMessage(normalizePasskeyError(error, "registration"));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleLogin() {
    setErrorMessage(null);
    setPendingAction("login");
    try {
      const options = await postJson<PublicKeyCredentialRequestOptionsJSON>(
        "/api/auth/login/options",
        {},
      );
      const response = await startAuthentication({
        optionsJSON: options as BrowserAuthenticationOptions,
      });
      await postJson("/api/auth/login/verify", response);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["auth"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["passkeys"] }),
      ]);
    } catch (error) {
      setErrorMessage(normalizePasskeyError(error, "login"));
    } finally {
      setPendingAction(null);
    }
  }

  const bootstrapToken = new URLSearchParams(window.location.search).get(
    "bootstrap",
  );
  const passkeyActionSupported =
    passkeySupport.secureContext && passkeySupport.hasWebAuthn;
  const authHeading = authQuery.data?.hasUser
    ? "Sign in to DroidAgent."
    : "Set up owner access.";
  const authDescription = authQuery.data?.hasUser
    ? "Use the passkey already enrolled for this DroidAgent instance."
    : "Create the owner passkey once. DroidAgent can prepare the Mac and phone access after you are in.";
  const passkeyStatus = useMemo(() => {
    if (!passkeySupport.checked) {
      return "Checking passkey support on this browser.";
    }
    if (!passkeySupport.secureContext) {
      return "This page is not in a secure browser context. Use localhost on the Mac or the configured HTTPS remote URL.";
    }
    if (!passkeySupport.hasWebAuthn) {
      return "This browser does not expose the WebAuthn APIs DroidAgent needs for passkeys.";
    }
    if (passkeySupport.platformAuthenticatorAvailable === false) {
      return "No built-in authenticator was reported. Touch ID, Face ID, Windows Hello, or a security key may still be required.";
    }
    return "Passkey APIs are available in this browser session.";
  }, [passkeySupport]);

  return (
    <main className="auth-screen">
      <section className="hero-card">
        <div className="hero-kicker">DroidAgent</div>
        <h1>{authHeading}</h1>
        <p>{authDescription}</p>
        {access ? (
          <section className="status-block">
            <strong>Host access</strong>
            <p>{access.localhostOnlyMessage}</p>
            {access.canonicalOrigin ? (
              <small>Canonical URL: {access.canonicalOrigin.origin}</small>
            ) : null}
            {bootstrapToken ? (
              <small>
                Phone enrollment link detected. Complete owner passkey setup on
                this device.
              </small>
            ) : null}
          </section>
        ) : null}
        <section className="status-block auth-capability-block">
          <strong>Passkey Readiness</strong>
          <p>{passkeyStatus}</p>
          <small>
            Use a current Safari, Chrome, or Edge session. `localhost` and the
            configured HTTPS remote URL both count as secure contexts.
          </small>
        </section>
        {errorMessage ? (
          <p className="status-banner error">{errorMessage}</p>
        ) : null}
        <div className="hero-actions">
          {authQuery.data?.hasUser ? (
            <button
              type="button"
              disabled={pendingAction === "login" || !passkeyActionSupported}
              onClick={() => void handleLogin()}
            >
              {pendingAction === "login"
                ? "Starting Passkey Sign-In..."
                : "Sign in with Passkey"}
            </button>
          ) : (
            <button
              type="button"
              disabled={pendingAction === "register" || !passkeyActionSupported}
              onClick={() => void handleRegister()}
            >
              {pendingAction === "register"
                ? "Starting Passkey Enrollment..."
                : bootstrapToken
                  ? "Complete Phone Enrollment"
                  : "Create Owner Passkey"}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
