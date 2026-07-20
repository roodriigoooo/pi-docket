# Docket Architecture

Docket is a pi extension whose first-use promise is **delegate safely without losing control**. Explicit workers are the primary story: spawn → watch/peek/tell → verdict → Report/diff/Hunk → decide. Evidence bundles are durable supporting infrastructure for capture outside a worker.

The unit of work is an **artifact**: a structured object derived from session activity (command, file edit, prompt, response, error, worker status, or saved evidence bundle). A small attention queue ranks unresolved artifacts as **review items**; the **verdict** card is where one worker decision is resolved — evidence first, worker claims second, never the transcript. Automatic worker → parent flow is **metadata only**. **Workers** are human-started, independent background pi processes; **evidence bundles** are durable artifact packages. Pi owns session movement; Docket owns evidence and decisions. Rename rationale lives in [ADR-0002](./adr/0002-rename-to-docket.md); flat worker creation and execution-policy rationale lives in [ADR-0004](./adr/0004-human-started-workers-and-execution-policy.md).

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
| Worker Lifecycle | `extensions/worker-lifecycle.ts` | Pure status transitions and lifecycle selectors: review/respawn/harvest eligibility, dock-terminal age, and prune disposition. |
| Worker Deliverable | `extensions/worker-deliverable.ts` | Immutable ready-generation identity, full-body extraction, atomic version sidecars, artifact adapter, and presentation classification. |
| Worker Handoff | `extensions/worker-handoff.ts` | Reviewed-deliverable provenance and model/thinking choice shaping. |
| Worker Spawn Policy | `extensions/worker-spawn-policy.ts` | Pure kind/execution precedence, Pi-model validation, source attribution, compatibility resolution, confirmation policy, and launch summary. |
| Background Work | `extensions/background-work.ts` | Protocol payload shaping, pre-flight task docs, synthetic status artifacts, and heartbeat artifact dedup. |
| Worker Review | `extensions/worker-review.ts` | Shared Worker + Artifact projection: state, result artifact, summary, recommendations, and status-card text. |
| Worker Report | `extensions/worker-report.ts` | Pure Report projection for verdict Evidence/Worker-says sections, full Report overlay, and expanded result widget. |
| Worker Conflicts | `extensions/worker-conflicts.ts` | Edited-file overlap detection across workers; warning text for dock, dashboard, and promote confirmation. |
| Worker Verdict | `extensions/worker-verdict.ts` | Worker decision lifecycle: candidate ranking, verdict actions, decision-ledger context, and change-set promotion. |
| Worker Change Review | `extensions/worker-change-review.ts` | One review operation over a deterministic change set: built-in diff, Hunk fallback, comment disposition, and worker-only comment delivery. It cannot promote or mount artifacts. |
| Hunk Diff Review | `extensions/worker-diff-review.ts` | Hunk process adapter: availability, exact patch extraction, launch, comment harvesting, and comment formatting. |
| Worker Commands | `extensions/worker-commands.ts` | `spawn` / `tell` / `delete` / `load` / `unload` / completion. |
| Worker Store | `extensions/worker-store.ts` | Flat shared-tmux worker persistence, status-file locking/atomic transitions, `send-keys -l` stdin (single line), `paste-buffer` (multiline), task docs, session seeding, and exact-execution respawn. |
| Worker Events | `extensions/worker-events.ts` | NDJSON append + tail + rotation. |
| Worker Snapshot Cache | `extensions/worker-dock-cache.ts` | mtime-cached status/artifacts read, `fs.watch`, sticky recent-event ring. |
| Worker Eviction | `extensions/worker-eviction.ts` | Dock idle-hide window, prune-after-hours sweep. |
| Decision Log | `extensions/decision-log.ts` | Append-only verdict ledger + unreviewed-eviction count; pure summarize/render over the events. |
| Worker Kinds | `extensions/worker-kinds.ts` | Intent-only frontmatter parser/registry, legacy execution compatibility metadata, diagnostics, and guardrails appendix. |
| Extension Surface | `extensions/docket.ts` (via `globalThis.__docket`) | `registerWorkerKind`, `listWorkerKinds`, `onWorkerEvent`. |
| Navigator | `extensions/docket-navigator.ts` | View model, ranking, selection state, mode/source transitions. |
| Command Router | `extensions/docket-command-router.ts` | Routes parsed intents to the modules above. |
| Shared Session Runtime | `extensions/shared-session-runtime.ts` | Parent/worker-neutral registration: `/docket` routing, message rendering, mounted artifact expansion, checkpoint lifecycle, and session cleanup. |
| Parent Runtime | `extensions/parent-runtime.ts` | Parent-only worker watch/dock startup and teardown. The parent owns cache refresh, reconciliation, harvest, tmux status, and dock animation. |
| Worker Runtime | `extensions/worker-runtime.ts` | Worker-only guardrail/protocol registration plus heartbeat lifecycle. Worker owns four protocol tools, nudges, shell fallback, and event capture; it has no spawn tool. |
| Docket Views | `extensions/docket-views/` | Artifact/file viewers, shared layout primitives, and router/verdict action type boundaries. Runtime state is not imported into views. |
| Docket Keymap | `extensions/docket-keymap.ts` | Normalized physical-key bindings, conflict checking, and shared card/footer/help hint rendering for interactive views. |

## Worker lifecycle

1. A human invokes `/docket spawn` or approved Use → Worker. `Worker Commands.spawn` asks the pure spawn resolver for one policy, validates exact model/thinking against Pi, checks `maxActive`, and conditionally confirms changed spend or legacy defaults. Noninteractive mode skips UI waits.
2. `Worker Store` receives only resolved execution. It writes `task.md` as a pre-flight brief (task, kind, workspace, decision rights, plan gate), persists canonical model/effective thinking, and opens one independent window in `docket-workers`. Seeded execution forks the parent's JSONL through `SessionManager.forkFrom` and launches with `--continue`; fresh execution starts blank.
3. Worker pi reads `task.md`, ticks `status.json` every 15 s, records Pi's actual canonical model and effective thinking, updates `artifacts.json` only when its signature changes, and appends state/progress/tool events to `events.ndjson`. A plan-gated worker may do read-only discovery, then must use `docket_wait` before first mutation.
4. Parent watches the workers root with `fs.watch` (recursive on macOS, polled fallback elsewhere). `WorkerSnapshotCache` reads new event bytes since its held offset, deduplicates by mtime, and keeps a 16-event sticky ring per worker.
5. `Background Work` projects the snapshot into a synthetic status artifact. Navigator ranks it alongside file edits and errors. The dock renders one row per worker plus an event sub-line when thinking. Passive warnings use the same data: `silent Nm` for no recent tool/todo events, `waiting Nm` for an old parent question.
6. An accepted `docket_done` first freezes a **Worker Deliverable** under `deliverables/v<N>.json`: full assistant body, structured fields, refs, and one staged patch. Only then does status point at `{ id, version, ref }` and enter `ready`. A duplicate tool call is idempotent; a later accepted done produces `vN+1`. `docket_fail` enters `failed` without a Deliverable.
7. Verdict judges that exact version. Approval is generation-bound; Review Notes request a later version. Diff, Hunk, overlap checks, and promotion use frozen patch bytes. Promotion clears worker source only when live patch still equals reviewed patch.
8. **Use** is separate from Approval. Use → Parent queues one full immutable chip for next human prompt. Use → Worker is a human-confirmed fresh spawn with `source-deliverable.md`; it never seeds parent JSONL.
9. Terminal rows remain until evicted (`worker.dockIdleHideMinutes`) or pruned (`worker.pruneAfterHours`). Pruning tests judgment for current Deliverable Version, so verdict on `v1` cannot settle `v2`; unreviewed work records `worker_evicted_unreviewed` first.
10. If the worker *process* dies, `remain-on-exit` keeps the dead pane. The dock's harvest sweep (`isPaneHarvestCandidate` → `WorkerStore.harvestPaneTail`) captures the last 200 lines to `pane-tail.txt`, kills the window, and stamps `paneCapturedAt` on the status so the probe never repeats. The tail surfaces as a `terminal tail` artifact in review and as the last lines on the failed verdict card. Workers in a terminal state whose pane is still alive (a protocol `docket_fail` with pi still running) are left untouched so you can keep chatting with them.

For a ready worker, the verdict card can open the deterministic change-set artifact directly or ask Hunk to annotate its exact patch. `Worker Change Review` owns the fallback to the built-in diff and comment send/copy/ignore handling. Only a successful send returns `comments-sent`; `Worker Verdict` then records the chat decision and advances the queue.

### Execution resolution

One resolved object feeds validation, confirmation, persistence, and launch:

| Concern | Precedence |
|---|---|
| Kind | `--as` → `worker.defaultKind` → builtin default |
| Model | `--model` / handoff choice → deprecated kind model → canonical parent model |
| Thinking | `--thinking` / handoff choice → deprecated kind thinking → current parent thinking |
| Context | handoff forced-fresh / `--fresh` → `--seed` → `worker.parentSeedPolicy` → deprecated kind `parent_seed` → fresh |
| Workspace | `--worktree` → deprecated kind `default_worktree` → writable isolated / read-only shared |
| Layout | deprecated compatibility value → single |

The resolver accepts only exact models from `ctx.modelRegistry.getAvailable()`. Model ids may contain `/`; parsing splits at first slash. Explicit non-off thinking on a non-reasoning model fails, while inherited thinking visibly resolves to `off`. Pi may clamp supported reasoning levels; worker heartbeat records resulting effective value.

## Worker protocol

One contract for every kind. The MD body of a kind extends the universal guardrails; it does not replace them.

| Tool | When | Effect |
|---|---|---|
| `docket_todos` | Multi-step work. | Replaces the visible progress board; informational, not completion. |
| `docket_wait` | Ambiguity, blocked auth, irreversible action. | Worker → `needs_input`, parent gets an inbox row. |
| `docket_done` | Finished with useful output. | Requires `outcome`, `summary`, `evidence`. Vague work is rejected back to `docket_wait`. |
| `docket_fail` | Cannot continue, no useful partial output. | Worker → `failed`. |

Worker creation is human-only. No kind or legacy status grants a spawn tool. `/docket wait` etc. via bash are intercepted inside worker sessions for fallback.

## Storage layout

Per-worker state under `~/.pi/agent/docket/workers/<id>/`:

| File | Owner | Purpose |
|---|---|---|
| `task.md` | parent on spawn | Assignment plus pre-flight brief: kind, workspace, decision rights, plan gate. |
| `status.json` | worker heartbeat + protocol | Current state, mtime-cached by the dock. |
| `artifacts.json` | worker heartbeat | Snapshot, signature-deduped between heartbeats. |
| `deliverables/v<N>.json` | worker publication | Immutable primary ready generation: full body, evidence, recommendations, refs, frozen patch, provenance. |
| `source-deliverable.md` | parent handoff | Byte-exact reviewed source body for a fresh Use → Worker destination. |
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

`WorkerKind` on this surface is intent-only: `name`, optional description, `readOnly`, optional plan gate/decision rights/soft limits, guardrail or system-prompt additions, and source metadata. Pre-0.8 runtime objects with execution keys are normalized into hidden compatibility metadata and produce migration diagnostics.

`onWorkerEvent` fires once per event tail per dock tick. Subscriber errors are caught and dropped — a misbehaving extension cannot crash Docket.

## Key design choices

- **One tmux session, N windows.** Pays for one tmux server regardless of fleet size. `send-keys -l` gives a safe parent→worker stdin without inventing a FIFO/socket protocol.
- **Dead panes are evidence.** Worker windows run with `remain-on-exit on`, so a crash leaves the pane (and its scrollback) for the parent to harvest before the window is killed. While the pane is alive, `capture-pane` doubles as the dashboard's bounded read-only peek: observation without attach, zero model-context cost.
- **NDJSON event stream over `fs.watch`.** Disk-backed, survives parent restarts, no daemon. Drives the dock without polling. `pipe-pane` captures terminal noise, not structured events — opt-in via `worker.captureTerminal` when debugging.
- **Heartbeat dedup.** Worker hashes its artifact list each heartbeat; `writeArtifacts` is skipped when unchanged. Quiet workers cost ~0 disk I/O.
- **mtime-cached reads in the parent.** `WorkerSnapshotCache` skips parse when neither status nor artifacts has changed.
- **Session seeding is opt-in.** By default `/docket spawn` starts fresh. `--seed` or `worker.parentSeedPolicy: "full"` forks parent JSONL and resumes with `--continue`; legacy kind `parent_seed` remains lower-precedence compatibility. `--fresh` wins when both flags appear.
- **Kinds state intent, not spend.** Every worker runs universal guardrails and appends kind markdown. New kinds declare authority/output only. Model/thinking are parent defaults or explicit spawn flags; workspace derives shared for read-only and isolated for writable kinds.
- **Plan gates use the existing wait path.** A kind can set `plan_gate: true`, which adds instructions to `task.md` and the guardrails. The worker asks through `docket_wait`; the parent resolves it through the normal verdict card. No extra state machine.
- **Silence is a hint, not automation.** The dock warns when `events.ndjson` has no recent useful activity or a parent question gets old. It does not kill, respawn, or attach automatically.
- **Deliverables freeze before judgment.** Full primary output and patch are sidecar-only immutable generations. Status points at one version; raw worker responses remain supporting evidence. No review surface recomputes a ready result from mutable artifacts or workspace.
- **Decisions are logged, debt is counted.** Every verdict resolution appends a decision id, verb, exact deliverable id/version/ref when ready, option/note, risk, and visible evidence refs to `decisions.ndjson`. Approval is not Use. A terminal worker pruned with no judgment for its current generation is logged as decision debt. The router holds the single choke point (`runVerdict`); the log module stays pure summarize/render so the counts are testable without a TUI.
- **Handoff stays human-started and transcript-free.** Approval changes no context. Use → Parent queues a chip only. Use → Worker routes selected model/thinking through the same resolver, writes reviewed sidecar bytes, forces fresh launch, confirms, rechecks approval, and records provenance.
- **Worker overlap is surfaced, not prevented.** Isolated worktrees keep workers from clobbering each other while they work. Docket detects edited-file overlap and warns before promote; the parent remains the mediator.
- **Attach means switch when already inside tmux.** `/docket attach` uses `switch-client` inside tmux and a copyable `attach` command outside. Workers record the human launch session's tmux target; `/docket attach parent` uses that value directly. Legacy `parentWorkerId` is not topology or fallback.
- **Progress boards are informational.** `docket_todos` helps parent visibility, but `docket_done` is authoritative; stale progress never keeps a ready worker in a special unresolved state.
- **Multiline stays multiline.** One-line replies go through `send-keys -l`; a reply with newlines is loaded into a tmux buffer and bracketed-pasted so the worker reads the whole block at once instead of running it on the first newline.
