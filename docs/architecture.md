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
- `WorkerSnapshotCache.snapshot()` — mtime-cached status + artifacts read with per-worker event tail and sticky recent-event buffer
- `watchWorkersRoot(root, onChange, options)` — `fs.watch` recursive + debounced + fallback poll
- `dockEventSubLine(events, state)` — pure mapper that picks the latest meaningful event (tool call, todo update) for the dock sub-line

Owned flow:
1. Worker pi appends one JSON line per significant event (state transition, todo update, tool call with target) to `workers/<id>/events.ndjson`, rotated at 5 MB with one retained generation.
2. Parent watches the workers root with `fs.watch` (recursive on macOS, fallback poll 3 s otherwise) and debounces refresh ticks at 150 ms.
3. `WorkerSnapshotCache` keeps per-worker `{ statusMtime, artifactsMtime, status, artifacts, eventOffset, recentEvents }` and skips re-reads when mtimes match. On each snapshot it tails new events, appends them to the per-worker `recentEvents` ring (capped at 16), and returns `eventsByWorker` alongside the existing status/artifacts maps.
4. The dock projects each thinking/starting row's most recent non-protocol tool call (or todo progress) into a dim sub-line under the worker row. Ready/needs-input/failed rows skip the sub-line — the main row's chip already conveys what is needed.
5. On dock tick, orphan workers (active state but shared session gone) are reconciled to `state: error` with a tmux-died lastError.

Leverage:
- Liveness is event-driven, not poll-driven. The parent reacts to file writes instead of running a 500 ms timer.
- The 15 s worker heartbeat hashes its artifact list and skips the `writeArtifacts` call when unchanged, so a quiet worker no longer rewrites 200 artifacts twice per minute.
- Event log lives on disk so it survives parent restarts; no daemon or socket needed.
- Dock UI consumers read structured events without parsing terminal output (no `tmux pipe-pane` required).
- Sticky `recentEvents` buffer means the dock sub-line stays populated across refresh ticks, not only on the tick that observed the append.

### Worker Kinds

Interface:

- `createWorkerKindRegistry()` → `{ get, list, names, register, unregister, reload, defaultKind }`
- `parseWorkerKindMarkdown(text, source, sourcePath?)` — pure frontmatter+body parser
- `workerKindGuardrailsAppendix(kind)` — composes the kind-specific section appended to the universal guardrails

Owned flow:
1. On first command, the registry reloads bundled MDs from `extensions/worker-kinds/`, then user MDs from `~/.pi/agent/trail/worker-kinds/` and `<project>/.pi/trail/worker-kinds/`.
2. Runtime-registered kinds (via `globalThis.__trail.registerWorkerKind`) survive reloads.
3. Each kind ships posture knobs (read-only, seed policy, layout, max-artifacts/duration, can-spawn) plus a free-form markdown body that becomes part of the worker's guardrails *appendix*, never a replacement.
4. The `default` kind name is reserved and matches pre-0.3 behavior.

Leverage:
- One protocol contract (`trail_wait`/`trail_done`/`trail_fail`/`trail_todos`) for every kind.
- Tool/permission deltas live in MD, not in code paths; new kinds need zero TypeScript.
- The registry is the single source of truth for the worker-side prompt appendix, parent-side `--as` resolution, and the `trail_spawn_child` allowlist.

### Extension surface

Interface (`globalThis.__trail`):

- `registerWorkerKind(kind)` → `() => void`
- `listWorkerKinds()` → `WorkerKind[]`
- `onWorkerEvent(handler)` → `() => void`

Owned flow:
1. Installed once on extension activation; later calls (e.g. another extension's activation hook) read the live object.
2. `onWorkerEvent` fires once per event tail per dock tick (sourced from `WorkerSnapshotCache.newEventsByWorker`), so subscribers see each event exactly once.
3. Subscriber errors are caught and dropped — a misbehaving extension can never crash Trail.

Leverage:
- Other pi extensions plug in domain-specific kinds without touching Trail's code.
- Event subscribers can build dashboards, telemetry, or routing without polling the file system.

### Worker Eviction

Interface:

- `dockIdleHideMs(config)` / `pruneAfterMs(config)` — parse config knobs into millisecond windows
- `isDockIdleEvictable(worker, now, idleHideMs)` — pure predicate, true only for `ended` workers older than the window
- `selectPrunableWorkers(workers, now, pruneMs)` — pure filter over the worker list

Owned flow:
1. Dock filters `ended` workers from the prompt-area row set once their `updatedAt` is older than `worker.dockIdleHideMinutes` (default 30 min).
2. Session start triggers a one-shot sweep that calls `WorkerStore.purge` for every `ended` worker older than `worker.pruneAfterHours` (default 24 h), removing the worker dir and its detached worktree.
3. Both windows are configurable per-project via `.pi/trail.json` and globally via `~/.pi/agent/trail.json`. Setting either to 0 disables that side.

Leverage:
- Auto-eviction only touches `ended` workers. `ready` and `failed` workers stay visible so the user can still act on them.
- Hide and prune are independent — disk retention can outlive dock visibility, or vice versa.
- Logic is pure; tests run without filesystem or tmux.

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

## Storage layout

Per-worker state lives under `~/.pi/agent/trail/workers/<id>/`:

| File | Owner | Purpose |
|---|---|---|
| `task.md` | parent on spawn | the assignment, read once by the worker |
| `status.json` | worker heartbeat + protocol | current state, mtime-cached by the dock |
| `artifacts.json` | worker heartbeat | snapshot of captured artifacts, signature-deduped between heartbeats |
| `events.ndjson` | worker live | append-only event stream for liveness + dock sub-line |
| `session/` | parent (seeded) | forked pi JSONL prefix, enables `--continue` + cache reuse |
| `workspace/` | parent (seeded) | detached git worktree isolated from the parent's working copy |

Checkpoint state lives under `~/.pi/agent/trail/`:

| File | Owner | Purpose |
|---|---|---|
| `checkpoints/<id>.md` | Checkpoint Lifecycle | handoff prose |
| `checkpoints/<id>.artifacts.json` | Checkpoint Lifecycle | sidecar refs, mounted by `/trail load` |
| `events.ndjson` | Event Log | append-only checkpoint lifecycle (save/consume/purge/sweep) |
| `index.json` | Event Log (snapshot) | compat snapshot rebuilt from `events.ndjson` |

`index.json` is a compatibility artifact: the event log is the source of truth and can replay the index on demand. It is kept so external tools that read `index.json` directly do not break, but no Trail code path treats it as authoritative.

## Planned deepening opportunities
