import { performanceService } from "../services/performance-service.js";

export interface ChatRelayState {
  stage:
    | "accepted"
    | "streaming"
    | "tool_call"
    | "tool_result"
    | "approval_required"
    | "completed"
    | "failed";
  label: string;
  detail?: string | null;
  toolName?: string | null;
  approvalId?: string | null;
  active?: boolean;
}

export interface ChatRelayCallbacks {
  onDelta(delta: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  onError(message: string): void | Promise<void>;
  onFirstDelta?(delta: string): void | Promise<void>;
  onState?(state: ChatRelayState): void | Promise<void>;
}

export function createMeasuredStreamRelay(
  transport: "http" | "ws",
  sessionId: string,
  relay: ChatRelayCallbacks,
) {
  const submitToAcceptedMetric = performanceService.start(
    "server",
    "chat.send.submitToAccepted",
    {
      transport,
      sessionId,
    },
  );
  let acceptedToFirstDeltaMetric:
    | ReturnType<typeof performanceService.start>
    | null = null;
  let acceptedToCompleteMetric:
    | ReturnType<typeof performanceService.start>
    | null = null;
  let firstDeltaRecorded = false;
  let finished = false;

  return {
    markAccepted() {
      submitToAcceptedMetric.finish({
        outcome: "ok",
      });
      acceptedToFirstDeltaMetric = performanceService.start(
        "server",
        "chat.stream.acceptedToFirstDelta",
        {
          transport,
          sessionId,
        },
      );
      acceptedToCompleteMetric = performanceService.start(
        "server",
        "chat.stream.acceptedToCompleteRelay",
        {
          transport,
          sessionId,
        },
      );
    },
    relay: {
      onDelta: async (delta: string) => {
        const isFirstDelta = !firstDeltaRecorded;
        if (!firstDeltaRecorded) {
          firstDeltaRecorded = true;
          acceptedToFirstDeltaMetric?.finish({
            outcome: "ok",
          });
          await relay.onFirstDelta?.(delta);
        }
        const forwardMetric = isFirstDelta
          ? performanceService.start("server", "chat.stream.firstDeltaForward", {
              transport,
              sessionId,
            })
          : null;
        await relay.onDelta(delta);
        forwardMetric?.finish({
          outcome: "ok",
          chars: delta.length,
        });
      },
      onDone: async () => {
        if (!firstDeltaRecorded) {
          firstDeltaRecorded = true;
          acceptedToFirstDeltaMetric?.finish({
            outcome: "no-delta",
          });
        }
        if (!finished) {
          finished = true;
          acceptedToCompleteMetric?.finish({
            outcome: "done",
          });
        }
        await relay.onDone();
      },
      onError: async (message: string) => {
        if (!firstDeltaRecorded) {
          firstDeltaRecorded = true;
          acceptedToFirstDeltaMetric?.finish({
            outcome: "error",
          });
        }
        if (!finished) {
          finished = true;
          acceptedToCompleteMetric?.finish({
            outcome: "error",
          });
        }
        await relay.onError(message);
      },
      ...(relay.onState
        ? {
            onState: async (state: ChatRelayState) => {
              await relay.onState?.(state);
            },
          }
        : {}),
    },
  };
}
