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
