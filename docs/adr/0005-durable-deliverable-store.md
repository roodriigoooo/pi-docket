# ADR-0005: Store immutable deliverables

## Status

accepted

## Context

Worker Deliverables are immutable and generation-bound, but the old checkpoint path bundled mutable catalog selections, orientation text, sidecars, summaries, and session markers. That made durable reuse depend on a legacy lifecycle and left parent-authored material without the same explicit approval and provenance model.

## Decision

Introduce `DeliverableStore` over immutable `StoredDeliverable` records:

- store records at `~/.pi/agent/docket/deliverables/<safe-id>/v<N>.json`;
- use a deterministic safe identity derived from worker ID, and a timestamp-plus-entropy identity for parent-authored v1 records;
- preserve the exact body bytes, structured outcome/evidence/recommendations, artifact refs, optional frozen change set, source facts, ordered exact-generation review notes, approval, and inherited handoff provenance;
- accept worker sources only when the referenced current Worker Deliverable has an exact terminal approval; parent authoring is interactive and receives synthetic human-authorship approval;
- serialize through a per-deliverable lock and atomic no-replace version claim. A corrupt or claimed version is never overwritten; repeated saves of the same worker generation are idempotent;
- treat directory scans as untrusted input and skip malformed or unrelated files.

`/docket load` mounts a stored record under a `d<N>` slot without model-context cost. Load and preview are inspection only. `Use → Parent` queues the exact body for the next human submission; `Use → Worker` starts a fresh, human-confirmed worker and records generalized handoff provenance. Saving never appends a Pi session marker or relabels a session leaf.

The checkpoint/bundle path remains compatibility-only for existing list/load/preview/unload, consume-metadata, and explicit-delete behavior. It never creates or converts a bundle through the new save path. New saves never write checkpoint files, the legacy event log, or the legacy index, and legacy bundles cannot use reviewed-deliverable handoff.

## Consequences

Approved work survives worker pruning as a portable, byte-exact record. Human authorship is explicit, and approval is never silently widened from one worker generation to another. The old bundle machinery remains available only where compatibility requires it and no longer controls the new-write path.
