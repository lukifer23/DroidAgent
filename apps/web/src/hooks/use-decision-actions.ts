import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { DecisionRecord } from "@droidagent/shared";

import { useDroidAgentApp } from "../app-context";
import { ApiError, postJson } from "../lib/api";
import { getDecisionByApprovalId } from "../lib/dashboard-selectors";

export function useDecisionActions(decisions: DecisionRecord[]) {
  const queryClient = useQueryClient();
  const { wsStatus } = useDroidAgentApp();

  const syncDashboardFallback = useCallback(async () => {
    if (wsStatus !== "connected") {
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
  }, [queryClient, wsStatus]);

  const resolveDecision = useCallback(
    async (
      decision: DecisionRecord,
      resolution: "approved" | "denied",
      expectedUpdatedAt:
        | string
        | null = decision.kind === "memoryDraftReview"
        ? decision.sourceUpdatedAt
        : null,
    ) => {
      try {
        return await postJson<DecisionRecord>(
          `/api/decisions/${encodeURIComponent(decision.id)}/resolve`,
          {
            resolution,
            expectedUpdatedAt,
          },
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        }
        throw error;
      } finally {
        await syncDashboardFallback();
      }
    },
    [queryClient, syncDashboardFallback],
  );

  const resolveApproval = useCallback(
    async (approvalId: string, resolution: "approved" | "denied") => {
      const decision = getDecisionByApprovalId(decisions, approvalId);
      if (decision) {
        await resolveDecision(decision, resolution);
        return;
      }

      try {
        await postJson(`/api/approvals/${encodeURIComponent(approvalId)}`, {
          resolution,
        });
      } finally {
        await syncDashboardFallback();
      }
    },
    [decisions, resolveDecision, syncDashboardFallback],
  );

  return {
    resolveDecision,
    resolveApproval,
    syncDashboardFallback,
  };
}
