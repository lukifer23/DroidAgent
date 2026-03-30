import { z } from "zod";

export const DecisionKindSchema = z.enum([
  "execApproval",
  "memoryDraftReview",
  "channelPairing",
  "ownerConfirmation",
]);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const DecisionStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "dismissed",
  "expired",
  "failed",
]);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const DecisionResolutionSchema = z.enum(["approved", "denied"]);
export type DecisionResolution = z.infer<typeof DecisionResolutionSchema>;

export const DecisionRecordSchema = z.object({
  id: z.string(),
  kind: DecisionKindSchema,
  sourceSystem: z.string(),
  sourceRef: z.string(),
  title: z.string(),
  summary: z.string(),
  details: z.string().nullable(),
  status: DecisionStatusSchema,
  requestedAt: z.string(),
  resolvedAt: z.string().nullable(),
  actorUserId: z.string().nullable(),
  actorLabel: z.string().nullable(),
  sessionId: z.string().nullable(),
  actorSessionId: z.string().nullable(),
  deviceLabel: z.string().nullable(),
  resolution: DecisionResolutionSchema.nullable(),
  sourceUpdatedAt: z.string().nullable(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const DecisionResolveRequestSchema = z.object({
  resolution: DecisionResolutionSchema,
  expectedUpdatedAt: z.string().nullable().default(null),
});
export type DecisionResolveRequest = z.infer<typeof DecisionResolveRequestSchema>;
