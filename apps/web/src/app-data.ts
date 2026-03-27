import { useQuery } from "@tanstack/react-query";
import type { BootstrapState, DashboardState, PasskeySummary, PerformanceSnapshot, StartupDiagnostic } from "@droidagent/shared";

import { api } from "./lib/api";

export interface AuthState {
  user: { id: string; username: string; displayName: string } | null;
  hasUser: boolean;
}

export function useAuthQuery() {
  return useQuery({
    queryKey: ["auth"],
    queryFn: () => api<AuthState>("/api/auth/me"),
    staleTime: 60_000,
    refetchOnWindowFocus: false
  });
}

export function useAccessQuery() {
  return useQuery({
    queryKey: ["access"],
    queryFn: () => api<BootstrapState>("/api/access"),
    staleTime: 15_000,
    refetchOnWindowFocus: false
  });
}

export function useDashboardQuery(enabled: boolean) {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<DashboardState>("/api/dashboard"),
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: false
  });
}

export function useStartupDiagnosticsQuery(enabled: boolean) {
  return useQuery({
    queryKey: ["startupDiagnostics"],
    queryFn: () => api<StartupDiagnostic[]>("/api/setup/diagnostics"),
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: false
  });
}

export function usePasskeysQuery(enabled: boolean) {
  return useQuery({
    queryKey: ["passkeys"],
    queryFn: () => api<PasskeySummary[]>("/api/auth/passkeys"),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false
  });
}

export function usePerformanceQuery(enabled: boolean) {
  return useQuery({
    queryKey: ["performance"],
    queryFn: () => api<PerformanceSnapshot>("/api/diagnostics/performance"),
    enabled,
    staleTime: 4_000,
    refetchInterval: 5000,
    refetchOnWindowFocus: false
  });
}
