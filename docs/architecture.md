# Trail Architecture

Trail is a Pi extension for session artifacts and fresh-session checkpoints.

## Domain language

**Artifact**: structured object derived from session activity, such as a command, file operation, prompt, response, code block, error, or checkpoint.

**Artifact Catalog**: Module that owns artifact extraction, identity, lookup, references, full text, inspection, and checkpoint payloads.

**Reference**: compact prompt-safe pointer to an artifact that preserves intent without injecting full artifact text.

**Checkpoint**: distilled continuation package that can seed a fresh Pi session without carrying full prior context.

**Checkpoint Lifecycle**: Module that owns creating a checkpoint from selected artifacts, including drafting, review, persistence, and session labeling.

**Checkpoint Commands**: Module that owns `/trail` command flows for continuing, resuming, listing, previewing, editing, and deleting Checkpoints. It delegates Checkpoint creation to the Checkpoint Lifecycle.

**Checkpoint Selector**: interactive Trail view for accepting or excluding mode-selected artifacts before checkpoint drafting.

**Loaded Artifact Context**: session-local module that owns mounted Artifact slots, pending Reference chips, Reference/full expansion, stale chip handling, and consume-on-use checkpoint queueing.

**Worker Commands**: Module that owns `/trail` command flows for spawning, listing, loading, unloading, and deleting Trail workers.

**Navigator**: interactive Trail view for browsing, inspecting, referencing, copying, and checkpointing artifacts.

## Current modules

### Artifact Catalog

Interface:

- `list()`
- `find(idOrRef)`
- `reference(artifact)`
- `fullText(artifact)`
- `inspect(artifact)`
- `search(query)`
- `selectForCheckpoint(mode, limit)`
- `checkpointPayload(artifacts, mode)`

Leverage:
- Callers do not inspect `meta.args` directly.
- Stable artifact refs survive beyond current navigator display IDs.
- Checkpoints, search, reference injection, and inspect share one artifact truth.

### Search Index

Interface:

- `searchArtifacts(query, artifacts)`
- `buildArtifactSearchDocument(artifact)`

Owned flow:
1. Build artifact search documents from the shared Artifact model.
2. Use ripgrep as candidate-finder adapter over temporary search docs.
3. Rank results by artifact relevance, favoring errors, files, and commands before transcript-like prompt/response matches.
4. Fall back to in-memory search when the ripgrep adapter fails.

Leverage:
- Search returns artifacts, not raw grep lines.
- Search documents are separate from checkpoint payloads and references, but derived from the same Artifact model.
- Checkpoint payload shape is not reused for search ranking.

### Checkpoint Lifecycle

Interface:

- `create(args)`

Owned flow:
1. Parse checkpoint options.
2. Select candidate artifacts by mode.
3. Let user accept/exclude candidate artifacts when UI exists.
4. Draft summarized or raw markdown.
5. Let user review/edit markdown when UI exists.
6. Persist checkpoint markdown and sidecar artifacts.
7. Append Trail checkpoint entry and label session leaf.

### Checkpoint Commands

Interface:

- `continue(idOrLast)`
- `delete(idOrLast)`
- `list(includeConsumed)`

Leverage:
- Trail command registration does not own Checkpoint Store lookup, delete confirmation, resume picker loops, preview/edit flow, or list formatting.
- TUI views and Pi session creation are adapters; Checkpoint command decisions are testable without Pi UI.
- Checkpoint creation stays in Checkpoint Lifecycle, so command flow and creation lifecycle remain separate Modules.

### Checkpoint Selector

Interface:

- `showCheckpointSelector(ctx, artifacts, mode)`
- `selectedCheckpointArtifacts(artifacts, state)`
- `checkpointSelectionStats(artifacts, state)`

Leverage:
- Mode flags define initial candidates.
- Users can remove noisy artifacts before token budget is spent on summarization.
- Sidecar JSON preserves only included artifacts.

### Loaded Artifact Context

Interface:

- `loadCheckpoint(checkpoint)`
- `loadWorker(worker)`
- `unloadSlot(slot)`
- `unloadSource(kind, sourceId)`
- `toggleChip(artifact, mode)`
- `expandChipsForSubmit(ctx, userText)`
- `drainCheckpointConsumes(markConsumed)`

Leverage:
- Trail command flow does not manage chip arrays, carryover maps, slot names, or stale Reference expansion.
- Mounted Checkpoint and worker Artifacts share one slot and Reference expansion policy.
- Consume-on-use queueing stays local to mounted Checkpoint state while persistence remains a store adapter.

### Worker Commands

Interface:

- `spawn(task)`
- `list()`
- `delete(ref)`
- `load(ref)`
- `unload(ref)`
- `completionCandidates()`

Leverage:
- Trail command registration does not own worker lookup, spawn announcement formatting, list formatting, or explicit load/unload/delete behavior.
- Worker Store and Loaded Artifact Context are adapters, so worker command behavior is testable without tmux or Pi UI.
- Mixed Checkpoint/worker load selection remains outside this Module, keeping Worker Commands focused on explicit worker operations.

## Planned deepening opportunities
