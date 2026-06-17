# Docket Architecture

Docket is a pi extension. The unit of work is an **artifact**: a structured object derived from session activity (command, file edit, prompt, response, error, worker status, or saved evidence bundle). A small attention queue ranks unresolved artifacts as **review items**; the **verdict** card is where one worker decision is resolved — reading only status fields and the deterministic change set, never the transcript. **Workers** are background pi processes; **evidence bundles** are durable artifact packages. Pi owns session movement; Docket owns evidence and decisions. Rename rationale lives in [ADR-0002](./adr/0002-rename-to-docket.md).

If you're contributing, read this end-to-end. If you're using Docket, the README and [configuration.md](./configuration.md) are what you want.

## Module map

Each module owns its data, its interface, and its tests. Adapters at the seam talk to pi, tmux, the filesystem, or the clipboard.

| Module | File | Owns |
|---|---|---|
| Artifact Catalog | `extensions/artifact-catalog.ts` | Extraction, identity, lookup, references, full text, inspect, bundle payloads. |
| Search Index | `extensions/search-index.ts` | Ripgrep adapter over artifact docs, in-memory fallback, attention-weighted ranking. |
| Bundle Lifecycle | `extensions/checkpoint-lifecycle.ts` | Bundle-first: select candidates → user prune → orientation header (opt-in `--summarize`) → review → persist. Internal type names still use checkpoint for storage compatibility. See [ADR-0001](./adr/0001-bundle-first-checkpoints.md). |
| Bundle Store | `extensions/checkpoint-store.ts` | Markdown + sidecar JSON on disk; event-backed lifecycle; soft-consume. |
| Bundle Commands | `extensions/checkpoint-commands.ts` | `list` / `delete` support for saved bundles. |
| Bundle Selector | `extensions/checkpoint-selector.ts` | Interactive accept/exclude before optional summarization. |
| Loaded Artifact Context | `extensions/loaded-artifact-context.ts` | Mounted source slots, reference/full chip expansion, consume-on-use queue. |
| Background Work | `extensions/background-work.ts` | Worker state transitions, protocol semantics, pre-flight task docs, synthetic status artifacts, heartbeat dedup. |
| Worker Review | `extensions/worker-review.ts` | Shared Worker + Artifact projection: state, result artifact, summary, recommendations, and status-card text. |
| Worker Verdict | `extensions/worker-verdict.ts` | Worker decision lifecycle: candidate ranking, verdict actions, decision-ledger context, and change-set promotion. |
| Worker Commands | `extensions/worker-commands.ts` | `spawn` / `tell` / `delete` / `load` / `unload` / completion. |
| Worker Store | `extensions/worker-store.ts` | Shared tmux session topology, `send-keys -l` stdin (single line) and `paste-buffer` (multiline), task doc write, session seeding. |
| Worker Events | `extensions/worker-events.ts` | NDJSON append + tail + rotation. |
| Worker Snapshot Cache | `extensions/worker-dock-cache.ts` | mtime-cached status/artifacts read, `fs.watch`, sticky recent-event ring. |
| Worker Eviction | `extensions/worker-eviction.ts` | Dock idle-hide window, prune-after-hours sweep. |
| Decision Log | `extensions/decision-log.ts` | Append-only verdict ledger + unreviewed-eviction count; pure summarize/render over the events. |
| Worker Kinds | `extensions/worker-kinds.ts` | Frontmatter parser, registry, guardrails appendix composer. |
| Extension Surface | `extensions/docket.ts` (via `globalThis.__docket`) | `registerWorkerKind`, `listWorkerKinds`, `onWorkerEvent`. |
| Navigator | `extensions/docket-navigator.ts` | View model, ranking, selection state, mode/source transitions. |
| Command Router | `extensions/docket-command-router.ts` | Routes parsed intents to the modules above. |

## Worker lifecycle

1. `Worker Commands.spawn(task, { as, fresh, worktree })` resolves the kind, checks `maxActive`, passes kind policy to `Worker Store.spawn`.
2. `Worker Store` writes `task.md` as a pre-flight brief: task, kind, workspace, decision rights, and any plan gate. It then opens a window in the shared tmux session `docket-workers`. If `parent_seed: full`, it forks the parent's JSONL via `SessionManager.forkFrom` and launches with `--continue`.
3. The worker pi reads `task.md`, ticks `status.json` every 15 s (heartbeat), updates `artifacts.json` only when its signature changes, and appends every state transition / todo update / tool call to `events.ndjson`. A plan-gated worker may do read-only discovery, then must use `docket_wait` before the first edit or mutating command.
4. Parent watches the workers root with `fs.watch` (recursive on macOS, polled fallback elsewhere). `WorkerSnapshotCache` reads new event bytes since its held offset, deduplicates by mtime, and keeps a 16-event sticky ring per worker.
5. `Background Work` projects the snapshot into a synthetic status artifact. Navigator ranks it alongside file edits and errors. The dock renders one row per worker plus an event sub-line when thinking. Passive warnings use the same data: `silent Nm` for no recent tool/todo events, `waiting Nm` for an old parent question.
6. Worker calls `docket_done` / `docket_fail` → state goes terminal → row enters `ready` / `failed` until evicted (`worker.dockIdleHideMinutes`) or pruned (`worker.pruneAfterHours`). When the prune sweep removes a terminal worker that never got a verdict (its id is absent from the decision ledger), it records a `worker_evicted_unreviewed` event first so the debt is counted before the record is gone.
7. If the worker *process* dies, `remain-on-exit` keeps the dead pane. The dock's harvest sweep (`isPaneHarvestCandidate` → `WorkerStore.harvestPaneTail`) captures the last 200 lines to `pane-tail.txt`, kills the window, and stamps `paneCapturedAt` on the status so the probe never repeats. The tail surfaces as a `terminal tail` artifact in review and as the last lines on the failed verdict card. Workers in a terminal state whose pane is still alive (a protocol `docket_fail` with pi still running) are left untouched so you can keep chatting with them.

## Worker protocol

One contract for every kind. The MD body of a kind extends the universal guardrails; it does not replace them.

| Tool | When | Effect |
|---|---|---|
| `docket_todos` | Multi-step work. | Replaces the visible todo board. |
| `docket_wait` | Ambiguity, blocked auth, irreversible action. | Worker → `needs_input`, parent gets an inbox row. |
| `docket_done` | Finished with useful output. | Requires `outcome`, `summary`, `evidence`. Vague work is rejected back to `docket_wait`. |
| `docket_fail` | Cannot continue, no useful partial output. | Worker → `failed`. |
| `docket_spawn_child` | Kind has `can_spawn`. | Opens a sibling window; child returns to parent worker, not the human. |

`/docket wait` etc. via bash are intercepted inside worker sessions for fallback.

## Storage layout

Per-worker state under `~/.pi/agent/docket/workers/<id>/`:

| File | Owner | Purpose |
|---|---|---|
| `task.md` | parent on spawn | Assignment plus pre-flight brief: kind, workspace, decision rights, plan gate. |
| `status.json` | worker heartbeat + protocol | Current state, mtime-cached by the dock. |
| `artifacts.json` | worker heartbeat | Snapshot, signature-deduped between heartbeats. |
| `events.ndjson` | worker live | Append-only event stream; rotated at 5 MB, one generation retained. |
| `pane-tail.txt` | parent harvest | Last terminal lines captured from the dead tmux pane after the worker process exited. |
| `session/` | parent (seeded) | Forked pi JSONL prefix, enables `--continue` + cache reuse. |
| `workspace/` | parent (seeded) | Detached git worktree isolated from the parent's working copy. |

Bundle state under `~/.pi/agent/docket/`:

| File | Owner | Purpose |
|---|---|---|
| `checkpoints/<id>.md` | Bundle Lifecycle | Orientation markdown. |
| `checkpoints/<id>.artifacts.json` | Bundle Lifecycle | Sidecar refs, mounted by `/docket load`. |
| `events.ndjson` | Bundle Store | Append-only lifecycle (save/consume/purge/sweep). |
| `index.json` | Bundle Store (snapshot) | Compatibility snapshot, rebuilt from `events.ndjson`. |
| `decisions.ndjson` | Decision Log | Append-only verdict ledger + unreviewed-eviction events, read by `/docket log decisions`. |

`index.json` is not authoritative — the event log is. It exists so external readers don't break.

## Extension surface

Other pi extensions read `globalThis.__docket` (installed once on activation):

```ts
declare global {
  var __docket: {
    registerWorkerKind(kind: WorkerKind): () => void;
    listWorkerKinds(): WorkerKind[];
    onWorkerEvent(handler: (event: WorkerEvent) => void): () => void;
  };
}
```

`onWorkerEvent` fires once per event tail per dock tick. Subscriber errors are caught and dropped — a misbehaving extension cannot crash Docket.

## Key design choices

- **One tmux session, N windows.** Pays for one tmux server regardless of fleet size. `send-keys -l` gives a safe parent→worker stdin without inventing a FIFO/socket protocol.
- **Dead panes are evidence.** Worker windows run with `remain-on-exit on`, so a crash leaves the pane (and its scrollback) for the parent to harvest before the window is killed. While the pane is alive, `capture-pane` doubles as the dashboard's read-only peek: observation without attach, zero model-context cost.
- **NDJSON event stream over `fs.watch`.** Disk-backed, survives parent restarts, no daemon. Drives the dock without polling. `pipe-pane` captures terminal noise, not structured events — opt-in via `worker.captureTerminal` when debugging.
- **Heartbeat dedup.** Worker hashes its artifact list each heartbeat; `writeArtifacts` is skipped when unchanged. Quiet workers cost ~0 disk I/O.
- **mtime-cached reads in the parent.** `WorkerSnapshotCache` skips parse when neither status nor artifacts has changed.
- **Session seeding for prompt cache.** `/docket spawn` (without `--fresh`) forks the parent JSONL into the worker session dir; worker resumes with `--continue` so the shared prefix is provider-cache eligible.
- **Kinds extend, never replace.** Every worker runs the universal guardrails; the kind MD is appended. Adding a kind needs zero TypeScript.
- **Plan gates use the existing wait path.** A kind can set `plan_gate: true`, which adds instructions to `task.md` and the guardrails. The worker asks through `docket_wait`; the parent resolves it through the normal verdict card. No extra state machine.
- **Silence is a hint, not automation.** The dock warns when `events.ndjson` has no recent useful activity or a parent question gets old. It does not kill, respawn, or attach automatically.
- **Decisions are logged, debt is counted.** Every verdict resolution appends to `decisions.ndjson` with the verb, option, risk, and evidence refs that were on the card. A terminal worker pruned with no verdict recorded is logged as decision debt. The router holds the single choke point (`runVerdict`); the log module stays pure summarize/render so the counts are testable without a TUI.
- **Multiline stays multiline.** One-line replies go through `send-keys -l`; a reply with newlines is loaded into a tmux buffer and bracketed-pasted so the worker reads the whole block at once instead of running it on the first newline.
