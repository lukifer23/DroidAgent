import { useQuery } from "@tanstack/react-query";
import type { BootstrapState, DashboardState, PasskeySummary, PerformanceSnapshot } from "@droidagent/shared";

import { api } from "./lib/api";

export interface AuthState {
  user: { id: string; username: string; displayName: string } | null;
  hasUser: boolean;
}

export function useAuthQuery() {
  return useQuery({
    queryKey: ["auth"],
    queryFn: () => api<AuthState>("/api/auth/me")
  });
}

export function useAccessQuery() {
  return useQuery({
    queryKey: ["access"],
    queryFn: () => api<BootstrapState>("/api/access")
  });
}

export function useDashboardQuery(enabled: boolean) {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<DashboardState>("/api/dashboard"),
    enabled
  });
}

export function usePasskeysQuery(enabled: boolean) {
  return useQuery({
    queryKey: ["passkeys"],
    queryFn: () => api<PasskeySummary[]>("/api/auth/passkeys"),
    enabled
  });
}

export function usePerformanceQuery(enabled: boolean) {
  return useQuery({
    queryKey: ["performance"],
    queryFn: () => api<PerformanceSnapshot>("/api/diagnostics/performance"),
    enabled,
    refetchInterval: 5000
  });
}
