# Surface Inventory

This file is the canonical inventory for public surfaces and major internal data paths. Use it when adding or changing routes, websocket events, scripts, or cross-layer flows.

## Ownership Labels

- `OpenClaw-owned truth`
  - the Gateway or CLI owns the underlying state machine and semantics
- `DroidAgent wrapper`
  - DroidAgent authenticates, audits, caches, filters, or reshapes an OpenClaw-owned surface
- `DroidAgent-only value`
  - owner/mobile/workspace/safety behavior that does not exist upstream in OpenClaw

## REST Surfaces

| Surface                                                               | Canonical internal owner                                          | Ownership             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------- |
| `/api/dashboard`                                                      | `dashboardService` slice caches                                   | DroidAgent-only value |
| `/api/access`, `/api/bootstrap/*`                                     | `accessService`                                                   | DroidAgent-only value |
| `/api/auth/*`, `/api/passkeys/*`                                      | `authService`                                                     | DroidAgent-only value |
| `/api/sessions/*`, `/api/chat/*`, `/api/approvals/*`                  | `harnessService` + `decisionService`                              | DroidAgent wrapper    |
| `/api/decisions`, `/api/decisions/:decisionId/resolve`                | `decisionService`                                                 | DroidAgent-only value |
| `/api/memory/*`, `/api/memory/drafts/*`                               | `memoryPrepareService` + `memoryDraftService` + `decisionService` | DroidAgent-only value |
| `/api/channels/*`, `/api/channels/signal/pairing/resolve`             | `signalService` + `decisionService` + `openclawService`           | DroidAgent wrapper    |
| `/api/files/*`, `/api/jobs/*`, `/api/terminal/*`                      | `fileService`, `jobService`, `terminalService`                    | DroidAgent-only value |
| `/api/runtime/*`, `/api/providers/*`, `/api/models/*`, `/api/setup/*` | `runtimeService`, `quickstartService`, `keychainService`          | DroidAgent-only value |
| `/api/maintenance/*`, `/api/launch-agent/*`                           | `maintenanceService`, `launchAgentService`                        | DroidAgent-only value |
| `/api/diagnostics/performance`                                        | `performanceService`                                              | DroidAgent-only value |

## WebSocket Events

| Event family                                                   | Canonical publisher                                          | Notes                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| `decision.updated`, `decisions.updated`                        | `decisionService` resolution path + `publishDecisionEffects` | authoritative owner-action stream                       |
| `approval.updated`, `approvals.updated`                        | compatibility alias over exec-approval decisions             | keep public compatibility intact                        |
| `memory.updated`, `memoryDrafts.updated`                       | memory services + decision side-effects                      | draft review still resolves through the decision ledger |
| `channel.updated`                                              | channel/pairing updates                                      | pairing truth stays OpenClaw-owned                      |
| `chat.*`, `session.*`                                          | `websocketHub` + harness relay                               | wrapper over OpenClaw session/chat truth                |
| `jobs.*`, `terminal.*`, `maintenance.*`, `performance.updated` | DroidAgent services                                          | DroidAgent-native surfaces                              |

## Canonical Internal Modules

| Concern                                        | Canonical location                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| owner decision ledger + compatibility routing  | `apps/server/src/services/decision-service.ts`                                   |
| post-resolution decision fanout                | `apps/server/src/lib/decision-updates.ts`                                        |
| chat relay timing                              | `apps/server/src/lib/chat-relay-metrics.ts`                                      |
| canonical chat send/abort orchestration        | `apps/server/src/services/chat-run-coordinator.ts`                               |
| shared output flush batching for jobs/terminal | `apps/server/src/lib/buffered-output-pipeline.ts`                                |
| OpenClaw status cache ownership                | `apps/server/src/services/openclaw-service-caches.ts`                            |
| OpenClaw config helpers                        | `apps/server/src/services/openclaw-config.ts`                                    |
| OpenClaw workspace/bootstrap constants         | `apps/server/src/services/openclaw-workspace.ts`                                 |
| OpenClaw attachment/message parsing            | `apps/server/src/services/openclaw-message-parts.ts`                             |
| dashboard/decision selectors                   | `apps/web/src/lib/dashboard-selectors.ts`                                        |
| shared display formatting                      | `apps/web/src/lib/formatters.ts`                                                 |
| owner decision mutations                       | `apps/web/src/hooks/use-decision-actions.ts`                                     |
| session-scoped chat state assembly             | `apps/web/src/hooks/use-chat-session-state.ts`                                   |
| shared chat session actions                    | `apps/web/src/lib/chat-session-actions.ts`                                       |
| script-side host/process helpers               | `scripts/lib/common.mjs`                                                         |
| maintained live model benchmark profiles       | `scripts/perf-model-profiles.mjs`                                                |
| shared decision contracts                      | `packages/shared/src/decisions.ts` re-exported by `packages/shared/src/index.ts` |

## Compatibility Aliases Kept Public

- `/api/approvals` and `/api/approvals/:approvalId`
  - public compatibility for OpenClaw exec approval actions
  - internally routes through the shared decision ledger
- `/api/memory/drafts/*`
  - editable draft workflow remains public
  - apply and dismiss resolve the same decision record used by the inbox
- `/api/channels/signal/pairing/resolve`
  - public compatibility for Signal pairing
  - resolution still flows through the shared decision ledger before forwarding to OpenClaw
- `/api/channels/signal/pairing/approve`
  - compatibility alias for older clients
  - internally normalized to approved resolution through the same decision ledger
- `approval.*`, `memoryDrafts.updated`, and `channel.updated`
  - retained during migration
  - `decision.*` is the authoritative owner-action stream

## Durable Data Paths

| Data                                                 | Source of truth                                                 | Ownership             |
| ---------------------------------------------------- | --------------------------------------------------------------- | --------------------- |
| owner users, passkeys, auth sessions                 | SQLite under `~/.droidagent`                                    | DroidAgent-only value |
| decision audit records                               | `decision_records` SQLite table                                 | DroidAgent-only value |
| memory drafts                                        | `memory_drafts` SQLite table                                    | DroidAgent-only value |
| maintenance operations                               | `maintenance_operations` SQLite table plus JSON mirror          | DroidAgent-only value |
| workspace durable memory files                       | workspace `MEMORY.md`, `PREFERENCES.md`, `memory/YYYY-MM-DD.md` | DroidAgent-only value |
| semantic-memory engine status and pairing truth      | OpenClaw Gateway/CLI                                            | OpenClaw-owned truth  |
| session/chat routing and exec approval semantics     | OpenClaw Gateway                                                | OpenClaw-owned truth  |
| job logs, terminal transcripts, uploaded attachments | `~/.droidagent/logs` and `~/.droidagent/uploads`                | DroidAgent-only value |

## Guardrails

- Do not add a second approval, pairing, or session state machine in DroidAgent.
- If a route mutates an owner-gated action, the canonical internal path is `decisionService`.
- If a screen needs dashboard or decision derivations, use shared selectors before adding route-local filtering logic.
- If a UI surface needs duration/bytes/time/role formatting, use `apps/web/src/lib/formatters.ts`.
- If a script needs repo-root, maintenance, or healthcheck helpers, use `scripts/lib/common.mjs`.
- Update this file whenever a new public route, websocket event family, or script entrypoint is introduced.
