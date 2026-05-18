# Trail Architecture

Trail is a Pi extension for session artifacts and fresh-session checkpoints.

## Domain language

**Artifact**: structured object derived from session activity, such as a command, file operation, prompt, response, code block, error, or checkpoint.

**Review Item**: actionable Navigator row derived from an Artifact. It exists in the default view only when the user has a likely next action. Review is a small attention queue: unresolved items first, pinned items next, and recent items only when everything is clear.

**Answers**: secondary Navigator mode for curated answer units (assistant/worker responses). It keeps conclusions reachable without filling Review with transcript-like artifacts.

**Artifact Catalog**: Module that owns artifact extraction, identity, lookup, references, full text, inspection, and checkpoint payloads.

**Reference**: compact prompt-safe pointer to an artifact that preserves intent without injecting full artifact text.

**Checkpoint**: distilled continuation package that can seed a fresh Pi session without carrying full prior context.

**Checkpoint Lifecycle**: Module that owns creating a checkpoint from selected artifacts, including drafting, review, persistence, and session labeling.

**Checkpoint Commands**: Module that owns `/trail` command flows for continuing, resuming, listing, previewing, editing, and deleting Checkpoints. It delegates Checkpoint creation to the Checkpoint Lifecycle.

**Checkpoint Selector**: interactive Trail view for accepting or excluding mode-selected artifacts before checkpoint drafting.

**Loaded Artifact Context**: session-local module that owns mounted Artifact slots, pending Reference chips, Reference/full expansion, stale chip handling, and consume-on-use checkpoint queueing.

**Worker Commands**: Module that owns `/trail` command flows for spawning, telling, listing, loading, unloading, and deleting Trail workers.

**Background Work**: Module that owns worker state transitions, worker protocol semantics, worker attention ranking, and synthetic status Artifacts. Workers are provenance for inbox rows, not a primary navigation axis unless the user opens the worker power/debug view. Waiting, ready, and failed worker states are represented as synthetic status Artifacts so Review can rank them with ordinary errors/files.

**Command Router**: Module that owns execution policy for parsed Trail intents. Pi command registration, TUI prompts, clipboard, tmux, and session creation are adapters.

**Navigator**: interactive Trail view for Review, Answers, All, search, inspection, referencing, copying, pinning, done/restore queue control, and checkpointing.

## UI principles

- Progressive hierarchy: modal title explains place, header shows mode/counts, controls live in their own zone, list shows compact rows, selected item shows next action, preview stays opt-in.
- Flow protection: attaching, copying, pinning, and marking done should be lightweight queue operations, not forced context injection or session switches.
- Answers stay secondary: answer units are reachable on demand, but transcript-like responses do not flood Review.
- Embedded theming: Trail uses Pi theme tokens (`selectedBg`, `customMessageBg`, `border`, `borderMuted`, `accent`, `muted`, `dim`) instead of custom palette values.
- Beauty serves orientation: fill/background marks active selection, color and glyphs encode attention state (`next`, `pinned`, `recent`) and worker state (`starting`, `thinking`, `needs input`, `ready`, `failed`, `stale`), metadata stays secondary.

## Current modules

### Artifact Catalog

Optional producer metadata contract:

```ts
message.details.trail = {
  title?: string,
  subtitle?: string,
  kind?: ArtifactKind // defaults to "response"
}
```

This lets worker/subagent extensions publish curated answer units without Trail inferring titles from raw text. Trail still works without this metadata.

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

- `defaultLoadSource(candidates)`
- `loadSource(source)`
- `loadCheckpoint(checkpoint)`
- `loadWorker(worker)`
- `unloadSlot(slot)`
- `unloadSource(kind, sourceId)`
- `toggleChip(artifact, mode)`
- `expandChipsForSubmit(ctx, userText)`
- `drainCheckpointConsumes(markConsumed)`

Owned flow:
1. Choose the default load source when `/trail load` has no explicit id.
2. Mount Checkpoint and worker Artifacts into stable carryover slots.
3. Queue consume-on-use Checkpoints when they are loaded.
4. Drop pending consume-on-use work when a mounted Checkpoint unloads.
5. Expand Reference/full chips on submit against current and mounted Artifacts.

Leverage:
- Trail command flow does not manage chip arrays, carryover maps, slot names, load defaults, or stale Reference expansion.
- Mounted Checkpoint and worker Artifacts share one source loading Interface and Reference expansion policy.
- Consume-on-use queueing stays local to mounted Checkpoint state while persistence remains a store adapter.

### Background Work

Interface:

- `deriveWorkerState(worker)`
- `workerProtocolPatch(worker, state, text, question)`
- `workerHeartbeatPatch(worker, heartbeat)`
- `workerStatusArtifact(worker)`
- `namespaceWorkerArtifacts(worker, artifacts)`
- `buildWorkerInitialPrompt(args)`

Owned flow:
1. Derive attention states from persisted worker snapshots.
2. Apply `trail_wait`, `trail_done`, and `trail_fail` protocol transitions.
3. Preserve sticky attention states across heartbeat updates.
4. Project worker attention into synthetic status Artifacts for Review.
5. Namespace worker-produced Artifacts by worker provenance.

Leverage:
- Tmux and filesystem code stays in Worker Store as adapters.
- Worker Commands and Trail TUI share one state vocabulary.
- Review receives worker attention as Artifacts and does not depend on worker storage.
- Protocol tests cross the Background Work Interface without tmux or Pi UI.

### Worker Commands

Interface:

- `spawn(task, { worktree?, fresh? })`
- `list()`
- `tell(ref, text)`
- `delete(ref)`
- `load(ref)`
- `unload(ref)`
- `completionCandidates()`

Background Work UI:
- A compact above-editor dock shows live worker status chips until workers are empty/deleted; it never injects model-context bytes.
- `/trail` refreshes worker artifact slots and surfaces worker output in Review without adding model-context bytes.
- Worker protocol tools (`trail_wait`, `trail_done`, `trail_fail`) publish attention state. Worker-side `/trail wait`, `/trail done`, and `/trail fail` remain Pi prompt fallbacks, and accidental direct bash calls are intercepted inside worker sessions.
- Parent-side `/trail tell w<N> [text]` sends input without attaching to tmux or polluting the parent prompt. Multiple waits from one worker are queued in worker status and collapsed into one Review row.
- `/trail workers` remains an artifact-first power/debug inbox across workers.
- Worker labels (`w1`, `w2`) are provenance first; source filtering is progressive disclosure.
- Destructive worker operations stay out of Review; mounting artifacts only enables browsing/attaching and does not add model context.

Leverage:
- Trail command registration does not own worker lookup, spawn announcement formatting, list formatting, or explicit load/unload/delete behavior.
- Worker Store and Loaded Artifact Context are adapters, so worker command behavior is testable without tmux or Pi UI.
- Mixed Checkpoint/worker load selection remains outside this Module, keeping Worker Commands focused on explicit worker operations.

### Worker Store (tmux topology)

Interface:

- `spawn(input)` — adds a window to the shared session
- `kill(id)` / `purge(id)` — kills the window, optionally purges the worker dir
- `sendInput(id, text)` — `tmux send-keys -l` with `[trail]` prefix
- `sharedSessionExists()` / `isSharedSessionTarget(target)` — shared-session probes
- `seedWorkerSession(parentFile, workerCwd, workerSessionDir)` — `SessionManager.forkFrom` adapter

Owned flow:
1. All workers live as windows inside one tmux session named `trail-workers`.
2. First spawn creates the session via `tmux new-session -d -s trail-workers -n w<N>`. Later spawns append windows via `tmux new-window -t trail-workers: -n w<N>`.
3. Worker status stores the window target (`trail-workers:w<N>`) in the `tmuxSession` field. Legacy per-worker session names are still recognised by kill/purge for graceful migration.
4. Parent-injected stdin uses `tmux send-keys -t <target> -l '[trail] <text>'` followed by a separate `Enter` send. Literal mode bypasses tmux key-table interpretation; the `[trail]` prefix marks the input as parent-originated.
5. When `parentSession` is supplied and `fresh` is not set, the worker's session dir is seeded from the parent's JSONL via `SessionManager.forkFrom`, and the worker pi launches with `--continue` so the parent prefix becomes the worker's starting context.

Leverage:
- Tmux topology is one decision held in this Module; everything else routes through `tmuxSession` opaquely.
- Session seeding for prompt-cache reuse is a `SessionManager.forkFrom` adapter, not a custom JSONL parser.
- Worker Commands and Background Work do not depend on whether the worker is in a shared session or a legacy per-worker one.

### Worker Events + Dock Cache

Interface:

- `appendWorkerEventSync(root, id, { kind, payload })` — append-only NDJSON event log
- `tailWorkerEvents(root, id, { offset })` — read new bytes since offset, return `{ events, rotated, offset }`
- `WorkerSnapshotCache.snapshot()` — mtime-cached status + artifacts read with per-worker event tail
- `watchWorkersRoot(root, onChange, options)` — `fs.watch` recursive + debounced + fallback poll

Owned flow:
1. Worker pi appends one JSON line per significant event (state transition, todo update, tool call) to `workers/<id>/events.ndjson`, rotated at 5 MB with one retained generation.
2. Parent watches the workers root with `fs.watch` (recursive on macOS, fallback poll 3 s otherwise) and debounces refresh ticks at 150 ms.
3. `WorkerSnapshotCache` keeps per-worker `{ statusMtime, artifactsMtime, status, artifacts, eventOffset }` and skips re-reads when mtimes match. On each snapshot it tails new events for every worker and returns `eventsByWorker` alongside the existing status/artifacts maps.
4. On dock tick, orphan workers (active state but shared session gone) are reconciled to `state: error` with a tmux-died lastError.

Leverage:
- Liveness is event-driven, not poll-driven. The parent reacts to file writes instead of running a 500 ms timer.
- The 15 s worker heartbeat hashes its artifact list and skips the `writeArtifacts` call when unchanged, so a quiet worker no longer rewrites 200 artifacts twice per minute.
- Event log lives on disk so it survives parent restarts; no daemon or socket needed.
- Dock UI consumers can read structured events without parsing terminal output (no `tmux pipe-pane` required).

### Navigator

Interface:

- `navigatorViewModel(state, artifacts, queueState)`
- `filteredReviewItems(state, artifacts, queueState)`
- `handleNavigatorIntent(state, artifacts, queueState, intent)`
- `availableSources(artifacts)`

Owned flow:
1. Derive Review Items from Artifacts and queue state.
2. Rank Review Items by attention: worker questions, failures, changed files, ready worker output, pinned items, and recent done items.
3. Expose domain action ids for selected Review Items.
4. Apply mode, source, filter, selection, and preview state transitions from Navigator intents.

Leverage:
- TUI views render Review Items and map keys/labels; they do not own Review ranking or action eligibility.
- Review queue tests cross the same seam as the TUI Adapter.
- Background Work reaches Review through synthetic status Artifacts, so Navigator does not depend on worker storage or tmux.

### Command Router

Interface:

- `createTrailCommandRouter(deps).handle(intent)`

Owned flow:
1. Route parsed Trail intents to Checkpoint Commands, Worker Commands, Loaded Artifact Context, Background Work, Artifact Catalog, and Navigator flows.
2. Decide command ordering: refresh worker carryover before browsing, mark Artifacts done before attachment/copy, and refresh worker dock after worker operations.
3. Keep load, unload, search, answers, artifact reference, and Review browser command policy in one Module.

Leverage:
- Pi command registration only parses arguments, builds adapters, and delegates one intent.
- Command behavior tests cross one seam without Pi UI, tmux, clipboard, or session creation.
- TUI prompts and renderers stay adapters; command policy stays local.

## Planned deepening opportunities
