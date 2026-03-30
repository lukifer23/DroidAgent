import type { Dispatch, SetStateAction } from "react";

import type {
  BootstrapState,
  BootstrapLink,
  BuildInfo,
  CloudProviderSummary,
  DashboardState,
  DecisionRecord,
  HostPressureStatus,
  MemoryDraft,
  MemoryDraftTarget,
  PasskeySummary,
  PerformanceSnapshot,
} from "@droidagent/shared";

export type SettingsActionRunner = (
  work: () => Promise<void>,
  successMessage?: string,
) => Promise<void>;

export interface OverviewCard {
  key: string;
  label: string;
  value: string;
  detail: string;
  progress: number;
  tone: "good" | "warn" | "critical" | "muted";
}

export type DraftEditMap = Record<
  string,
  {
    target: MemoryDraftTarget;
    title: string;
    content: string;
  }
>;

export interface SettingsCorePanelsProps {
  overviewCards: readonly OverviewCard[];
  setup: DashboardState["setup"] | undefined;
  launchAgent: DashboardState["launchAgent"] | undefined;
  runtimeCount: number;
  hostPressure: HostPressureStatus | undefined;
  runAction: SettingsActionRunner;
  tailscaleReady: boolean;
  remoteReady: boolean;
  tailscaleStatus: BootstrapState["tailscaleStatus"] | undefined;
  access: BootstrapState | undefined;
  bootstrapLink: BootstrapLink | null;
  canGeneratePhoneLink: boolean;
  setBootstrapLink: Dispatch<SetStateAction<BootstrapLink | null>>;
  maintenance: DashboardState["maintenance"] | undefined;
  localhostMaintenance: boolean;
  handleRunMaintenance: (
    scope: "app" | "runtime" | "remote",
    action: "restart" | "drain-only",
  ) => Promise<void>;
  handleMaintenanceRecoveryAction: (
    action:
      | "retryVerify"
      | "refreshHarnessHealth"
      | "reconnectResync"
      | "clearStaleMaintenanceState"
      | "restartRuntime"
      | "restartAppShell",
  ) => Promise<void>;
  memory: DashboardState["memory"] | undefined;
  harness: DashboardState["harness"] | undefined;
  memoryPrepareRowClass: string;
  memoryPrepareChipClass: string;
  memoryPrepareChipLabel: string;
  memoryPrepareActivityLabel: string;
  memoryPrepareTimingBits: string[];
  memoryPrepareActive: boolean;
  memoryPrepareState: string;
  memoryReady: boolean;
  normalizedImageModel: string | null;
  normalizedActiveModel: string | null;
  handlePrepareMemory: () => Promise<void>;
  pendingMemoryDrafts: MemoryDraft[];
  memoryDraftDecisionById: Map<string, DecisionRecord>;
  draftEdits: DraftEditMap;
  beginDraftEdit: (draft: MemoryDraft) => void;
  cancelDraftEdit: (draftId: string) => void;
  updateDraftEdit: (
    draftId: string,
    patch: Partial<{
      target: MemoryDraftTarget;
      title: string;
      content: string;
    }>,
  ) => void;
  handleApplyDraft: (draft: MemoryDraft) => Promise<void>;
  handleUpdateDraft: (draft: MemoryDraft) => Promise<void>;
  handleDismissDraft: (draft: MemoryDraft) => Promise<void>;
}

export interface SettingsAdminPanelsProps {
  resolvedTheme: "dark" | "light";
  themePreference: "system" | "dark" | "light";
  setThemePreference: (value: "system" | "dark" | "light") => void;
  passkeys: PasskeySummary[];
  runAction: SettingsActionRunner;
  handleAddPasskey: () => Promise<void>;
  canInstallApp: boolean;
  installApp: () => Promise<void>;
  build: BuildInfo | undefined;
  cloudProviders: CloudProviderSummary[];
  providerApiKeys: Record<string, string>;
  setProviderApiKeys: Dispatch<SetStateAction<Record<string, string>>>;
  providerModels: Record<string, string>;
  setProviderModels: Dispatch<SetStateAction<Record<string, string>>>;
  contextManagement: DashboardState["contextManagement"] | undefined;
  memory: DashboardState["memory"] | undefined;
  clientPerformanceSnapshot: PerformanceSnapshot;
  performanceSnapshot: PerformanceSnapshot | undefined;
}
