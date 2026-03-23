import {
  CloudProviderIdSchema,
  CloudProviderSummarySchema,
  nowIso,
  type CloudProviderId,
  type CloudProviderSummary
} from "@droidagent/shared";

import { CommandError, runCommand } from "../lib/process.js";
import { appStateService } from "./app-state-service.js";

interface CloudProviderDefinition {
  id: CloudProviderId;
  label: string;
  envVar: string;
}

const KEYCHAIN_ACCOUNT = "droidagent-owner";

export const CLOUD_PROVIDER_DEFINITIONS: CloudProviderDefinition[] = [
  { id: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY" },
  { id: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY" },
  { id: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
  { id: "gemini", label: "Gemini", envVar: "GEMINI_API_KEY" },
  { id: "groq", label: "Groq", envVar: "GROQ_API_KEY" },
  { id: "together", label: "Together", envVar: "TOGETHER_API_KEY" },
  { id: "xai", label: "xAI", envVar: "XAI_API_KEY" }
];

function serviceName(providerId: CloudProviderId): string {
  return `droidagent.provider.${providerId}`;
}

function definitionFor(providerId: CloudProviderId): CloudProviderDefinition {
  const match = CLOUD_PROVIDER_DEFINITIONS.find((entry) => entry.id === providerId);
  if (!match) {
    throw new Error(`Unknown cloud provider: ${providerId}`);
  }
  return match;
}

async function findGenericPassword(providerId: CloudProviderId): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await runCommand(
    "security",
    ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", serviceName(providerId), "-w"],
    { okExitCodes: [0, 44] }
  );
}

export class KeychainService {
  providerDefinitions(): readonly CloudProviderDefinition[] {
    return CLOUD_PROVIDER_DEFINITIONS;
  }

  async hasProviderSecret(providerId: CloudProviderId): Promise<boolean> {
    const result = await findGenericPassword(providerId);
    return result.exitCode === 0;
  }

  async getProviderSecret(providerId: CloudProviderId): Promise<string | null> {
    const result = await findGenericPassword(providerId);
    if (result.exitCode === 44) {
      return null;
    }
    return result.stdout.trimEnd() || null;
  }

  async setProviderSecret(providerId: CloudProviderId, secret: string): Promise<void> {
    if (!secret.trim()) {
      throw new Error("Provider secret cannot be empty.");
    }

    await runCommand("security", [
      "add-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      serviceName(providerId),
      "-w",
      secret,
      "-U"
    ]);

    await appStateService.updateCloudProviderPreference(providerId, {
      lastUpdatedAt: nowIso()
    });
  }

  async deleteProviderSecret(providerId: CloudProviderId): Promise<void> {
    await runCommand(
      "security",
      ["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", serviceName(providerId)],
      { okExitCodes: [0, 44] }
    );
  }

  async getProcessEnv(): Promise<NodeJS.ProcessEnv> {
    const entries = await Promise.all(
      CLOUD_PROVIDER_DEFINITIONS.map(async (provider) => {
        const secret = await this.getProviderSecret(provider.id);
        return secret ? [provider.envVar, secret] : null;
      })
    );

    return Object.fromEntries(entries.filter((entry): entry is [string, string] => Boolean(entry)));
  }

  async listProviderSummaries(): Promise<CloudProviderSummary[]> {
    const runtimeSettings = await appStateService.getRuntimeSettings();

    return await Promise.all(
      CLOUD_PROVIDER_DEFINITIONS.map(async (provider) => {
        const secret = await this.getProviderSecret(provider.id);
        const preference = runtimeSettings.cloudProviders[provider.id];

        return CloudProviderSummarySchema.parse({
          id: provider.id,
          label: provider.label,
          envVar: provider.envVar,
          stored: Boolean(secret),
          active: runtimeSettings.activeProviderId === provider.id,
          defaultModel: preference.defaultModel,
          health: secret ? "ok" : "warn",
          healthMessage: secret ? "Stored in the macOS login keychain." : "No API key stored in Keychain yet.",
          lastUpdatedAt: preference.lastUpdatedAt
        });
      })
    );
  }

  async updateProviderModel(providerId: CloudProviderId, defaultModel: string): Promise<void> {
    CloudProviderIdSchema.parse(providerId);
    if (!defaultModel.trim()) {
      throw new Error("A provider model is required.");
    }

    await appStateService.updateCloudProviderPreference(providerId, {
      defaultModel,
      lastUpdatedAt: nowIso()
    });
  }

  providerDefinition(providerId: CloudProviderId): CloudProviderDefinition {
    return definitionFor(providerId);
  }

  async assertConfigured(providerId: CloudProviderId): Promise<void> {
    if (!(await this.hasProviderSecret(providerId))) {
      const provider = definitionFor(providerId);
      throw new Error(`${provider.label} is not configured in Keychain yet.`);
    }
  }

  async deleteAllKnownSecrets(): Promise<void> {
    await Promise.all(
      CLOUD_PROVIDER_DEFINITIONS.map(async (provider) => {
        try {
          await this.deleteProviderSecret(provider.id);
        } catch (error) {
          if (!(error instanceof CommandError)) {
            throw error;
          }
        }
      })
    );
  }
}

export const keychainService = new KeychainService();
