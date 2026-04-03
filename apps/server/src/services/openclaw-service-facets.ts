import {
  openclawService,
  type OpenClawService,
} from "./openclaw-service.js";

export type OpenClawDashboardFacet = {
  contextManagementStatus: () => ReturnType<
    OpenClawService["contextManagementStatus"]
  >;
  memoryStatusQuick: () => ReturnType<OpenClawService["memoryStatusQuick"]>;
};

export type OpenClawRealtimeFacet = {
  contextManagementStatus: () => ReturnType<
    OpenClawService["contextManagementStatus"]
  >;
  memoryStatus: () => ReturnType<OpenClawService["memoryStatus"]>;
};

export type OpenClawOperationsFacet = {
  ensureTodayMemoryNote: () => ReturnType<
    OpenClawService["ensureTodayMemoryNote"]
  >;
  memoryStatus: () => ReturnType<OpenClawService["memoryStatus"]>;
  prepareWorkspaceContext: () => ReturnType<
    OpenClawService["prepareWorkspaceContext"]
  >;
  setSmartContextManagement: (
    enabled: boolean,
  ) => ReturnType<OpenClawService["setSmartContextManagement"]>;
  startGateway: () => ReturnType<OpenClawService["startGateway"]>;
  status: () => ReturnType<OpenClawService["status"]>;
};

export type OpenClawWorkspaceFacet = {
  ensureTodayMemoryNote: () => ReturnType<
    OpenClawService["ensureTodayMemoryNote"]
  >;
  prepareWorkspaceContext: () => ReturnType<
    OpenClawService["prepareWorkspaceContext"]
  >;
  prepareWorkspaceScaffold: () => ReturnType<
    OpenClawService["prepareWorkspaceScaffold"]
  >;
  reindexMemory: (
    params: Parameters<OpenClawService["reindexMemory"]>[0],
  ) => ReturnType<OpenClawService["reindexMemory"]>;
};

export type OpenClawMemoryFacet = {
  invalidateMemoryStatusCache: () => void;
  memoryStatus: () => ReturnType<OpenClawService["memoryStatus"]>;
  memoryStatusQuick: () => ReturnType<OpenClawService["memoryStatusQuick"]>;
  prepareSemanticMemory: (
    params: Parameters<OpenClawService["prepareSemanticMemory"]>[0],
  ) => ReturnType<OpenClawService["prepareSemanticMemory"]>;
};

export type OpenClawRuntimeFacet = {
  ensureConfigured: () => ReturnType<OpenClawService["ensureConfigured"]>;
  startGateway: () => ReturnType<OpenClawService["startGateway"]>;
  status: () => ReturnType<OpenClawService["status"]>;
  stopGateway: () => ReturnType<OpenClawService["stopGateway"]>;
};

export type OpenClawChannelFacet = {
  configureSignal: (
    params: Parameters<OpenClawService["configureSignal"]>[0],
  ) => ReturnType<OpenClawService["configureSignal"]>;
  invalidateChannelStatusCache: () => void;
  removeSignalChannel: () => ReturnType<OpenClawService["removeSignalChannel"]>;
  resolveSignalPairing: (
    code: string,
    resolution: "approved" | "denied",
  ) => ReturnType<OpenClawService["resolveSignalPairing"]>;
};

export const openclawDashboardFacet: OpenClawDashboardFacet = {
  contextManagementStatus: () => openclawService.contextManagementStatus(),
  memoryStatusQuick: () => openclawService.memoryStatusQuick(),
};

export const openclawRealtimeFacet: OpenClawRealtimeFacet = {
  contextManagementStatus: () => openclawService.contextManagementStatus(),
  memoryStatus: () => openclawService.memoryStatus(),
};

export const openclawOperationsFacet: OpenClawOperationsFacet = {
  ensureTodayMemoryNote: () => openclawService.ensureTodayMemoryNote(),
  memoryStatus: () => openclawService.memoryStatus(),
  prepareWorkspaceContext: () => openclawService.prepareWorkspaceContext(),
  setSmartContextManagement: (enabled) =>
    openclawService.setSmartContextManagement(enabled),
  startGateway: () => openclawService.startGateway(),
  status: () => openclawService.status(),
};

export const openclawWorkspaceFacet: OpenClawWorkspaceFacet = {
  ensureTodayMemoryNote: () => openclawService.ensureTodayMemoryNote(),
  prepareWorkspaceContext: () => openclawService.prepareWorkspaceContext(),
  prepareWorkspaceScaffold: () => openclawService.prepareWorkspaceScaffold(),
  reindexMemory: (params) => openclawService.reindexMemory(params),
};

export const openclawMemoryFacet: OpenClawMemoryFacet = {
  invalidateMemoryStatusCache: () => openclawService.invalidateMemoryStatusCache(),
  memoryStatus: () => openclawService.memoryStatus(),
  memoryStatusQuick: () => openclawService.memoryStatusQuick(),
  prepareSemanticMemory: (params) => openclawService.prepareSemanticMemory(params),
};

export const openclawRuntimeFacet: OpenClawRuntimeFacet = {
  ensureConfigured: () => openclawService.ensureConfigured(),
  startGateway: () => openclawService.startGateway(),
  status: () => openclawService.status(),
  stopGateway: () => openclawService.stopGateway(),
};

export const openclawChannelFacet: OpenClawChannelFacet = {
  configureSignal: (params) => openclawService.configureSignal(params),
  invalidateChannelStatusCache: () => openclawService.invalidateChannelStatusCache(),
  removeSignalChannel: () => openclawService.removeSignalChannel(),
  resolveSignalPairing: (code, resolution) =>
    openclawService.resolveSignalPairing(code, resolution),
};
