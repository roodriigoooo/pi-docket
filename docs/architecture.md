# Trail Architecture

Trail is a pi extension. The unit of work is an **artifact**: a structured object derived from session activity (command, file edit, prompt, response, error, checkpoint). A small attention queue ranks unresolved artifacts as **review items**. **Workers** are background pi processes; **checkpoints** are durable handoff packages.

If you're contributing, read this end-to-end. If you're using Trail, the README and [configuration.md](./configuration.md) are what you want.

## Module map

Each module owns its data, its interface, and its tests. Adapters at the seam talk to pi, tmux, the filesystem, or the clipboard.

| Module | File | Owns |
|---|---|---|
| Artifact Catalog | `extensions/artifact-catalog.ts` | Extraction, identity, lookup, references, full text, inspect, checkpoint payloads. |
| Search Index | `extensions/artifact-search.ts` | Ripgrep adapter over artifact docs, in-memory fallback, attention-weighted ranking. |
| Checkpoint Lifecycle | `extensions/checkpoint-lifecycle.ts` | Bundle-first: select candidates → user prune → orientation header (opt-in `--summarize`) → review → persist. See [ADR-0001](./adr/0001-bundle-first-checkpoints.md). |
| Checkpoint Store | `extensions/checkpoint-store.ts` | Markdown + sidecar JSON on disk; event-backed lifecycle; soft-consume. |
| Checkpoint Commands | `extensions/trail-checkpoint-commands.ts` | `continue` / `list` / `delete` flows. |
| Checkpoint Selector | `extensions/trail-checkpoint-selector.ts` | Interactive accept/exclude before summarization. |
| Loaded Artifact Context | `extensions/loaded-artifact-context.ts` | Mounted source slots, reference/full chip expansion, consume-on-use queue. |
| Background Work | `extensions/background-work.ts` | Worker state transitions, protocol semantics, synthetic status artifacts, heartbeat dedup. |
| Worker Commands | `extensions/worker-commands.ts` | `spawn` / `tell` / `delete` / `load` / `unload` / completion. |
| Worker Store | `extensions/worker-store.ts` | Shared tmux session topology, `send-keys -l` stdin, session seeding. |
| Worker Events | `extensions/worker-events.ts` | NDJSON append + tail + rotation. |
| Worker Snapshot Cache | `extensions/worker-dock-cache.ts` | mtime-cached status/artifacts read, `fs.watch`, sticky recent-event ring. |
| Worker Eviction | `extensions/worker-eviction.ts` | Dock idle-hide window, prune-after-hours sweep. |
| Worker Kinds | `extensions/worker-kinds.ts` | Frontmatter parser, registry, guardrails appendix composer. |
| Extension Surface | `extensions/trail.ts` (via `globalThis.__trail`) | `registerWorkerKind`, `listWorkerKinds`, `onWorkerEvent`. |
| Navigator | `extensions/trail-navigator.ts` | View model, ranking, selection state, mode/source transitions. |
| Command Router | `extensions/trail-command-router.ts` | Routes parsed intents to the modules above. |

## Worker lifecycle

1. `Worker Commands.spawn(task, { as, fresh, worktree })` resolves the kind, checks `maxActive`, calls `Worker Store.spawn`.
2. `Worker Store` opens a window in the shared tmux session `trail-workers`. If `parent_seed: full`, it forks the parent's JSONL via `SessionManager.forkFrom` and launches with `--continue`.
3. The worker pi writes to `task.md`, ticks `status.json` every 15 s (heartbeat), updates `artifacts.json` only when its signature changes, and appends every state transition / todo update / tool call to `events.ndjson`.
4. Parent watches the workers root with `fs.watch` (recursive on macOS, polled fallback elsewhere). `WorkerSnapshotCache` reads new event bytes since its held offset, deduplicates by mtime, and keeps a 16-event sticky ring per worker.
5. `Background Work` projects the snapshot into a synthetic status artifact. Navigator ranks it alongside file edits and errors. The dock renders one row per worker plus an event sub-line when thinking.
6. Worker calls `trail_done` / `trail_fail` → state goes terminal → row enters `ready` / `failed` until evicted (`worker.dockIdleHideMinutes`) or pruned (`worker.pruneAfterHours`).

## Worker protocol

One contract for every kind. The MD body of a kind extends the universal guardrails; it does not replace them.

| Tool | When | Effect |
|---|---|---|
| `trail_todos` | Multi-step work. | Replaces the visible todo board. |
| `trail_wait` | Ambiguity, blocked auth, irreversible action. | Worker → `needs_input`, parent gets an inbox row. |
| `trail_done` | Finished with useful output. | Requires `outcome`, `summary`, `evidence`. Vague work is rejected back to `trail_wait`. |
| `trail_fail` | Cannot continue, no useful partial output. | Worker → `failed`. |
| `trail_spawn_child` | Kind has `can_spawn`. | Opens a sibling window; child returns to parent worker, not the human. |

`/trail wait` etc. via bash are intercepted inside worker sessions for fallback.

## Storage layout

Per-worker state under `~/.pi/agent/trail/workers/<id>/`:

| File | Owner | Purpose |
|---|---|---|
| `task.md` | parent on spawn | Assignment, read once by the worker. |
| `status.json` | worker heartbeat + protocol | Current state, mtime-cached by the dock. |
| `artifacts.json` | worker heartbeat | Snapshot, signature-deduped between heartbeats. |
| `events.ndjson` | worker live | Append-only event stream; rotated at 5 MB, one generation retained. |
| `session/` | parent (seeded) | Forked pi JSONL prefix, enables `--continue` + cache reuse. |
| `workspace/` | parent (seeded) | Detached git worktree isolated from the parent's working copy. |

Checkpoint state under `~/.pi/agent/trail/`:

| File | Owner | Purpose |
|---|---|---|
| `checkpoints/<id>.md` | Checkpoint Lifecycle | Handoff prose. |
| `checkpoints/<id>.artifacts.json` | Checkpoint Lifecycle | Sidecar refs, mounted by `/trail load`. |
| `events.ndjson` | Checkpoint Store | Append-only lifecycle (save/consume/purge/sweep). |
| `index.json` | Checkpoint Store (snapshot) | Compatibility snapshot, rebuilt from `events.ndjson`. |

`index.json` is not authoritative — the event log is. It exists so external readers don't break.

## Extension surface

Other pi extensions read `globalThis.__trail` (installed once on activation):

```ts
declare global {
  var __trail: {
    registerWorkerKind(kind: WorkerKind): () => void;
    listWorkerKinds(): WorkerKind[];
    onWorkerEvent(handler: (event: WorkerEvent) => void): () => void;
  };
}
```

`onWorkerEvent` fires once per event tail per dock tick. Subscriber errors are caught and dropped — a misbehaving extension cannot crash Trail.

## Key design choices

- **One tmux session, N windows.** Pays for one tmux server regardless of fleet size. `send-keys -l` gives a safe parent→worker stdin without inventing a FIFO/socket protocol.
- **NDJSON event stream over `fs.watch`.** Disk-backed, survives parent restarts, no daemon. Drives the dock without polling. `pipe-pane` captures terminal noise, not structured events — opt-in via `worker.captureTerminal` when debugging.
- **Heartbeat dedup.** Worker hashes its artifact list each heartbeat; `writeArtifacts` is skipped when unchanged. Quiet workers cost ~0 disk I/O.
- **mtime-cached reads in the parent.** `WorkerSnapshotCache` skips parse when neither status nor artifacts has changed.
- **Session seeding for prompt cache.** `/trail spawn` (without `--fresh`) forks the parent JSONL into the worker session dir; worker resumes with `--continue` so the shared prefix is provider-cache eligible.
- **Kinds extend, never replace.** Every worker runs the universal guardrails; the kind MD is appended. Adding a kind needs zero TypeScript.

Stress-test runbook + numbers in [stress-test.md](./stress-test.md).
