# ADR-0003: Freeze Worker Deliverables; separate approval from handoff

## Status

accepted

## Context

A worker's status, artifact snapshot, and workspace are mutable. Selecting latest response during review and re-reading a workspace during promotion allowed a human to inspect one result then approve or promote newer content.

## Decision

An accepted `docket_done` publishes one immutable **Worker Deliverable Version** before status enters `ready`.

- Sidecars live at `workers/<id>/deliverables/v<N>.json`.
- `status.json` keeps existing lifecycle/result fields plus current `{ id, version, ref }`; full body and patch remain sidecar-only.
- Body comes from assistant message containing exact `docket_done` tool call and bypasses artifact body truncation.
- Repeated tool call id is idempotent; later accepted calls create next version.
- Patch, file list, stat, and hunk count are captured once with deliverable. Review, Hunk, overlap warnings, conflict checks, and promotion use frozen patch.
- Promotion clears worker workspace only when live patch still equals frozen patch; later edits remain intact.
- Verdict ledger records decision id plus exact deliverable id/version/ref. Approval is valid only for current exact generation.
- Approval records judgment and never injects context, submits editor text, or spawns work. Patch promotion remains an explicit verdict action.
- **Use** is explicit human action after approval. Use → Parent queues a full immutable chip for next human prompt. Use → Worker starts exactly one fresh worker, writes byte-exact `source-deliverable.md`, and records structured handoff provenance.
- Handoff does not seed parent JSONL. Source document is reviewed task input, never authority over destination worker guardrails or decision rights.

## Consequences

Review surfaces agree on body and patch. Old versions remain readable. A verdict for `v1` cannot settle `v2`. Worker handoff is inspectable and deliberate, but not autonomous chaining.

## Non-goals

This does not create a global durable deliverable library, public `/docket spawn --model/--thinking` flags, routing graphs, or automatic worker chaining.
