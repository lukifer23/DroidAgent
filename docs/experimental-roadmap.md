# Experimental Roadmap

This document is design-only for the current hardening pass. Nothing here ships as an autonomous background feature yet.

## Scope

- open-research loop for longer-running operator-requested research tasks
- per-user adaptation artifacts that stay local to the host
- future adapter or LoRA training and selection for local models

## Non-Goals For This Pass

- no background training jobs
- no silent model selection changes
- no autonomous command execution
- no durable memory writes without the existing approval-gated draft flow

## Proposed Storage Layout

- `~/.droidagent/research/jobs/<job-id>/`
  - research prompts, fetched artifacts, summaries, and status
- `~/.droidagent/adaptation/datasets/<dataset-id>/`
  - curated local training inputs and labels
- `~/.droidagent/adaptation/runs/<run-id>/`
  - training config, logs, metrics, and produced adapters
- `~/.droidagent/adaptation/registry.json`
  - adapter metadata, provenance, rollback target, and quota accounting

## Proposed Job Model

- Research loop:
  - operator-created, approval-gated job
  - bounded tools, bounded runtime, explicit output directory
  - produces citations, notes, and an optional memory draft suggestion
- Adaptation run:
  - operator-created, localhost-only
  - fixed base model, explicit dataset selection, explicit output name
  - can publish an adapter artifact but cannot switch the default model automatically

## Provenance Requirements

- every research job records prompt, tool calls, timestamps, and artifact hashes
- every adaptation run records base model, dataset ids, hyperparameters, operator identity, and produced artifact hashes
- every surfaced adapter includes a lineage record pointing back to the source run

## Rollback Model

- adapter activation must be reversible from Settings
- previous default model or adapter selection remains stored as the rollback target
- deleting an adapter does not delete its lineage record or run logs

## Quotas

- cap concurrent research jobs to a small fixed number
- cap retained research artifacts by bytes and age
- cap adaptation datasets, adapter artifacts, and total disk usage separately
- refuse new runs when host pressure is elevated or critical

## UI Entry Points

- `Chat`
  - explicit "Research" action for operator-requested loops
  - explicit "Add to memory draft" follow-up from research outputs
- `Settings`
  - adapter registry, quotas, rollback, and provenance views
- `Models`
  - explicit adapter selection for a compatible base model
- `Jobs`
  - replay logs for research and adaptation runs

## Safety Guardrails

- keep research and adaptation opt-in and approval-gated
- never auto-apply adapters after a completed run
- never train on files outside the configured workspace and DroidAgent-owned data roots
- redact or reject obvious secrets before dataset export
- require localhost for adaptation start, activation, rollback, and deletion
- block new runs during maintenance or high host pressure
