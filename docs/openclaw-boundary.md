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
- If OpenClaw already owns the underlying truth, DroidAgent should surface, filter, or audit it instead of recreating it.
- New DroidAgent-native flows are justified only when they add owner control, mobile usability, workspace safety, or auditability that OpenClaw does not already provide.
