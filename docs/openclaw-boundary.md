# OpenClaw Boundary

This repo treats OpenClaw as the system of record for agent execution and channel semantics. DroidAgent is the single-owner control layer above it.

The concrete route, websocket, script, and data-path inventory that applies this boundary lives in [Surface Inventory](./surface-inventory.md).

## OpenClaw-owned truth

- session lifecycle and chat routing
- exec approval semantics and execution host behavior
- channel state and Signal pairing truth
- semantic-memory engine behavior and index health
- provider/tool behavior exposed through the Gateway

## DroidAgent wrapper responsibilities

- owner-authenticated browser and PWA access
- canonical-origin enforcement and remote-access policy
- safe browser-facing REST and websocket boundary
- unified owner decision inbox over OpenClaw approvals, memory review, and pairing
- workspace file browser/editor, workspace job runner, and rescue terminal
- Setup, diagnostics, and mobile-first operator UX

## DroidAgent-only value

- passkey bootstrap and single-owner device enrollment
- workspace jail and local file conflict handling
- durable-memory draft workflow before writes hit workspace memory files
- decision audit records with owner, auth session, and device attribution
- local maintenance orchestration and LaunchAgent integration

## Guardrails

- Do not add a second session, approval, or pairing state machine in DroidAgent.
- Do not add a second browser-side chat session lifecycle store. The canonical DroidAgent client cache may annotate OpenClaw-owned sessions for UX, but it must not invent alternate session truth.
- If OpenClaw already owns the underlying truth, DroidAgent should surface, filter, or audit it instead of recreating it.
- Server consumers that only need OpenClaw memory/context/gateway status should depend on focused internal facets rather than the full `openclawService` orchestration surface.
- Direct `openclawService` imports outside the harness adapter and facet module should be treated as boundary exceptions and reduced again when touched.
- New DroidAgent-native flows are justified only when they add owner control, mobile usability, workspace safety, or auditability that OpenClaw does not already provide.
- Internal refactors that consolidate transport orchestration, status-cache ownership, or diagnostics are valid only when they preserve this boundary and do not migrate OpenClaw-owned semantics into DroidAgent.

## Change Checklist

For any PR that touches sessions, approvals, pairing, websocket semantics, maintenance lifecycle, or remote/origin enforcement:

- Does this introduce a second source of truth for session lifecycle?
- Does this recreate OpenClaw approval semantics instead of routing through `decisionService`?
- Does this recreate Signal pairing state instead of resolving through the decision ledger?
- Does this expose raw OpenClaw control semantics directly to browser clients?
- Could this be implemented as DroidAgent-side filtering, attribution, or auditability instead?
