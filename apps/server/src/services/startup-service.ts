import { StartupDiagnosticSchema, type StartupDiagnostic } from "@droidagent/shared";

import { accessService } from "./access-service.js";
import { appStateService } from "./app-state-service.js";
import { keychainService } from "./keychain-service.js";
import { openclawService } from "./openclaw-service.js";
import { runtimeService } from "./runtime-service.js";
import { signalService } from "./signal-service.js";

export class StartupService {
  private restorePromise: Promise<StartupDiagnostic[]> | null = null;
  private diagnostics: StartupDiagnostic[] = [];

  async restore(): Promise<StartupDiagnostic[]> {
    if (this.restorePromise) {
      return await this.restorePromise;
    }

    this.restorePromise = this.runRestore();
    try {
      this.diagnostics = await this.restorePromise;
      return this.diagnostics;
    } finally {
      this.restorePromise = null;
    }
  }

  async getDiagnostics(): Promise<StartupDiagnostic[]> {
    if (this.diagnostics.length > 0) {
      return this.diagnostics;
    }
    return await this.runRestore(false);
  }

  private async runRestore(applyChanges = true): Promise<StartupDiagnostic[]> {
    const diagnostics: StartupDiagnostic[] = [];
    const [runtimeSettings, tailscale, runtimes, cloudProviders] = await Promise.all([
      appStateService.getRuntimeSettings(),
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

    try {
      await openclawService.ensureConfigured();
      if (applyChanges) {
        await openclawService.startGateway();
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

    const ollama = runtimes.find((runtime) => runtime.id === "ollama");
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

    const llamaCpp = runtimes.find((runtime) => runtime.id === "llamaCpp");
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

    try {
      await signalService.refreshState();
      if (applyChanges && runtimeSettings.signalRegistrationState === "registered") {
        await signalService.startDaemon();
      }
      diagnostics.push(
        StartupDiagnosticSchema.parse({
          id: "signal",
          health: runtimeSettings.signalRegistrationState === "registered" ? "ok" : "warn",
          blocking: false,
          action: runtimeSettings.signalRegistrationState === "registered" ? null : "Configure Signal only if you need the secondary owner ingress.",
          message:
            runtimeSettings.signalRegistrationState === "registered"
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

    const activeCloud = cloudProviders.find((provider) => provider.id === runtimeSettings.activeProviderId);
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
