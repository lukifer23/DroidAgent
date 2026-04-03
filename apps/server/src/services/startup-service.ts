import {
  StartupDiagnosticSchema,
  type CloudProviderSummary,
  type RuntimeStatus,
  type StartupDiagnostic
} from "@droidagent/shared";

const STARTUP_DIAGNOSTICS_TTL_MS = 15_000;

import { accessService } from "./access-service.js";
import { appStateService } from "./app-state-service.js";
import { cloudflareRemoteAccessProvider } from "./remote-access-service.js";
import { keychainService } from "./keychain-service.js";
import { openclawRuntimeFacet } from "./openclaw-service-facets.js";
import { runtimeService } from "./runtime-service.js";
import { signalService } from "./signal-service.js";

export class StartupService {
  private restorePromise: Promise<StartupDiagnostic[]> | null = null;
  private diagnosticsPromise: Promise<StartupDiagnostic[]> | null = null;
  private diagnostics: StartupDiagnostic[] = [];
  private diagnosticsRefreshedAt = 0;

  invalidate(): void {
    this.diagnostics = [];
    this.diagnosticsRefreshedAt = 0;
  }

  peekDiagnostics(): StartupDiagnostic[] {
    return this.diagnostics;
  }

  async restore(): Promise<StartupDiagnostic[]> {
    if (this.restorePromise) {
      return await this.restorePromise;
    }

    this.restorePromise = this.runRestore();
    try {
      this.diagnostics = await this.restorePromise;
      this.diagnosticsRefreshedAt = Date.now();
      return this.diagnostics;
    } finally {
      this.restorePromise = null;
    }
  }

  async getDiagnostics(): Promise<StartupDiagnostic[]> {
    if (
      this.diagnostics.length > 0 &&
      Date.now() - this.diagnosticsRefreshedAt < STARTUP_DIAGNOSTICS_TTL_MS
    ) {
      return this.diagnostics;
    }
    if (this.restorePromise) {
      return await this.restorePromise;
    }
    if (this.diagnosticsPromise) {
      return await this.diagnosticsPromise;
    }

    this.diagnosticsPromise = this.runRestore(false)
      .then((diagnostics) => {
        this.diagnostics = diagnostics;
        this.diagnosticsRefreshedAt = Date.now();
        return diagnostics;
      })
      .finally(() => {
        this.diagnosticsPromise = null;
      });

    return await this.diagnosticsPromise;
  }

  private async runRestore(applyChanges = true): Promise<StartupDiagnostic[]> {
    const diagnostics: StartupDiagnostic[] = [];
    const [runtimeSettings, accessSettings, tailscale, runtimes, cloudProviders] = await Promise.all([
      appStateService.getRuntimeSettings(),
      appStateService.getAccessSettings(),
      accessService.getTailscaleStatus(),
      runtimeService.getRuntimeStatuses(),
      keychainService.listProviderSummaries()
    ]);

    diagnostics.push(
      StartupDiagnosticSchema.parse({
        id: "tailscale",
        health: tailscale.httpsEnabled ? "ok" : tailscale.authenticated ? "warn" : "warn",
        blocking: false,
        action: tailscale.httpsEnabled ? null : "Enable Tailscale Serve from localhost bootstrap.",
        message: tailscale.healthMessage
      })
    );

    if (!accessSettings.cloudflareHostname) {
      diagnostics.push(
        StartupDiagnosticSchema.parse({
          id: "cloudflare",
          health: "warn",
          blocking: false,
          action:
            "Configure a named Cloudflare tunnel only if you want a public remote path in addition to Tailscale.",
          message: "Cloudflare tunnel is optional and not configured on this host."
        })
      );
    } else {
      try {
        const cloudflare = await accessService.getCloudflareStatus();
        if (applyChanges && cloudflare.tokenStored) {
          await cloudflareRemoteAccessProvider.start();
        }
        const refreshedCloudflare = applyChanges
          ? await accessService.getCloudflareStatus()
          : cloudflare;
        diagnostics.push(
          StartupDiagnosticSchema.parse({
            id: "cloudflare",
            health: refreshedCloudflare.running ? "ok" : refreshedCloudflare.configured ? "warn" : "warn",
            blocking: false,
            action: refreshedCloudflare.configured ? null : "Configure a named Cloudflare tunnel only if you want a public remote path in addition to Tailscale.",
            message: refreshedCloudflare.healthMessage
          })
        );
      } catch (error) {
        diagnostics.push(
          StartupDiagnosticSchema.parse({
            id: "cloudflare",
            health: "error",
            blocking: false,
            action: "Repair the Cloudflare tunnel token or hostname from Settings.",
            message: error instanceof Error ? error.message : "Cloudflare tunnel restore failed."
          })
        );
      }
    }

    try {
      await openclawRuntimeFacet.ensureConfigured();
      if (applyChanges) {
        await openclawRuntimeFacet.startGateway();
      }
      diagnostics.push(
        StartupDiagnosticSchema.parse({
          id: "openclaw",
          health: "ok",
          blocking: false,
          action: null,
          message: "OpenClaw configuration is present and the gateway restore path is ready."
        })
      );
    } catch (error) {
      diagnostics.push(
        StartupDiagnosticSchema.parse({
          id: "openclaw",
          health: "error",
          blocking: true,
          action: "Repair the OpenClaw install and gateway profile.",
          message: error instanceof Error ? error.message : "OpenClaw restore failed."
        })
      );
    }

    const ollama = runtimes.find((runtime: RuntimeStatus) => runtime.id === "ollama");
    diagnostics.push(
      StartupDiagnosticSchema.parse({
        id: "ollama",
        health: ollama?.health ?? "warn",
        blocking: false,
        action:
          ollama?.state === "stopped"
            ? "Start Ollama with `brew services start ollama` or from the Models tab."
            : ollama?.installed
              ? null
              : "Install Ollama via Homebrew or from the Models tab.",
        message: ollama?.healthMessage ?? "Ollama status is unavailable."
      })
    );

    const llamaCpp = runtimes.find((runtime: RuntimeStatus) => runtime.id === "llamaCpp");
    try {
      if (applyChanges && runtimeSettings.selectedRuntime === "llamaCpp" && runtimeSettings.llamaCppModel) {
        await runtimeService.startRuntime("llamaCpp");
      }
      diagnostics.push(
        StartupDiagnosticSchema.parse({
          id: "llamaCpp",
          health:
            runtimeSettings.selectedRuntime === "llamaCpp"
              ? llamaCpp?.installed
                ? "ok"
                : "warn"
              : llamaCpp?.health ?? "warn",
          blocking: false,
          action:
            runtimeSettings.selectedRuntime === "llamaCpp" && !llamaCpp?.installed
              ? "Install llama.cpp before selecting it as the active runtime."
              : null,
          message:
            runtimeSettings.selectedRuntime === "llamaCpp"
              ? "llama.cpp is the selected runtime and will be restored when available."
              : llamaCpp?.healthMessage ?? "llama.cpp is idle."
        })
      );
    } catch (error) {
      diagnostics.push(
        StartupDiagnosticSchema.parse({
          id: "llamaCpp",
          health: "error",
          blocking: runtimeSettings.selectedRuntime === "llamaCpp",
          action: "Check the selected GGUF preset and the local llama.cpp install.",
          message: error instanceof Error ? error.message : "llama.cpp restore failed."
        })
      );
    }

    if (
      runtimeSettings.signalRegistrationState === "registered" ||
      runtimeSettings.signalRegistrationMode !== "none" ||
      runtimeSettings.signalDaemonState !== "stopped"
    ) {
      try {
        await signalService.refreshState();
        const refreshedRuntimeSettings = await appStateService.getRuntimeSettings();
        if (applyChanges && refreshedRuntimeSettings.signalRegistrationState === "registered") {
          await signalService.startDaemon();
        }
        diagnostics.push(
          StartupDiagnosticSchema.parse({
            id: "signal",
            health: refreshedRuntimeSettings.signalRegistrationState === "registered" ? "ok" : "warn",
            blocking: false,
            action:
              refreshedRuntimeSettings.signalRegistrationState === "registered"
                ? null
                : "Configure Signal only if you need the secondary owner ingress.",
            message:
              refreshedRuntimeSettings.signalRegistrationState === "registered"
                ? "Signal account is registered and eligible for daemon restore."
                : "Signal is optional and not fully configured on this host."
          })
        );
      } catch (error) {
        diagnostics.push(
          StartupDiagnosticSchema.parse({
            id: "signal",
            health: "error",
            blocking: false,
            action: "Re-validate the Signal account and daemon from the Channels tab.",
            message: error instanceof Error ? error.message : "Signal restore failed."
          })
        );
      }
    } else {
      diagnostics.push(
        StartupDiagnosticSchema.parse({
          id: "signal",
          health: "warn",
          blocking: false,
          action: "Configure Signal only if you need the secondary owner ingress.",
          message: "Signal is optional and not configured on this host."
        })
      );
    }

    const activeCloud = cloudProviders.find(
      (provider: CloudProviderSummary) => provider.id === runtimeSettings.activeProviderId
    );
    diagnostics.push(
      StartupDiagnosticSchema.parse({
        id: "cloudProviders",
        health: activeCloud ? (activeCloud.stored ? "ok" : "error") : "warn",
        blocking: Boolean(activeCloud && !activeCloud.stored),
        action:
          activeCloud && !activeCloud.stored
            ? `Restore the ${activeCloud.label} API key in the macOS Keychain from Settings.`
            : activeCloud
              ? null
              : "Cloud providers are optional; local runtimes remain the primary path.",
        message: activeCloud
          ? activeCloud.stored
            ? `${activeCloud.label} credentials are available in the macOS Keychain.`
            : `${activeCloud.label} is selected but its API key is missing.`
          : "No cloud provider is active."
      })
    );

    this.diagnostics = diagnostics;
    return diagnostics;
  }
}

export const startupService = new StartupService();
