# Design decisions: shared tmux + event stream + cache seeding

This file is a working record of the design discussions and implementation
choices made while reshaping Trail's multi-worker workflow. It's not user
documentation — read the README for that. It exists so future-me (and anyone
else picking this up) can see the why behind the moves, not only the what.

## Starting symptoms

Two pain points motivated this round of work:

1. **Slowdown at 4-5 active workers.** The parent's UI felt sluggish even when
   no worker was producing output. CPU usage climbed with worker count even
   though each worker is supposed to run independently.
2. **Information overload in the navigator and dock.** The dock repeated
   `active · working` for every worker, the inbox carried duplicate footers and
   in-card action rows, and `/trail help` listed 30+ commands at the top level
   of the user's mental model.

## Root-cause analysis (before any code changed)

### Why the parent felt slow

- `refreshWorkerDockWidget` ran on a 500 ms `setInterval`. Each tick:
  `store.list()` → `readdir` + N × `readFile(status.json)` + N × `readFile(artifacts.json)` + N × `JSON.parse`. With five workers that's ten file reads and ten JSON parses, twice per second, mostly returning identical bytes.
- Each worker's heartbeat (15 s) unconditionally rewrote `artifacts.json` —
  the full catalog every time, even when nothing had changed since the last
  heartbeat. Atomic rename per worker per 15 s.
- The 500 ms timer and the heartbeat were running simultaneously on the same
  files, racing for the inode.

### Why tmux looked expensive but wasn't (mostly)

The instinct was "tmux is heavy at 5 sessions." It isn't — `tmux` is a small
C program and a detached session is cheap. The actual cost at N workers is:

- N node processes (pi runtime)
- N independent LLM contexts (no shared prompt cache)
- N status/artifacts JSON files being polled

Tmux's only real overhead is one server process per session created with
`new-session`. Multiple sessions don't share that server; multiple windows
within one session do. We were paying for N servers when we could pay for one.

### Why pi-fork's approach (cited inspiration) doesn't transfer cleanly

pi-fork spawns child pi processes with the parent's session JSONL pre-seeded.
That gives prompt-cache hits and zero protocol surface. But pi-fork has no
live-attach affordance, no progress board, no "needs decision" inbox — and the
user explicitly values Trail's live-attach + protocol. So the move was to
absorb pi-fork's cache idea (session seeding) without dropping tmux.

## The decision matrix

We grilled four design choices.

### Execution shape

Three options on the table:

1. Drop tmux entirely. Detached child pi + log files; `/trail attach` lazily
   constructs a tmux session for read-only viewing.
2. Single shared tmux session, N windows, one server. `pipe-pane` available
   for capture, `send-keys -l` for safe stdin, `display-message` and
   `wait-for` for structured queries.
3. Hybrid: detached by default, lazy tmux only when attached.

We picked option 2. The argument:

- The real cost is pi-per-worker, not tmux-per-worker. Dropping tmux only
  reclaims ~5 MB per worker. Option 2 keeps the affordance and still kills the
  N-servers cost.
- Tmux has structured tooling (`-l` literal mode, `wait-for`, `display-message`,
  `set-hook pane-died`, `list-panes -F`) that gives us a real control plane
  for free, without inventing a FIFO/UDS protocol.
- Smaller rewrite than option 1. The existing worker-store already calls tmux;
  we changed "new-session per worker" → "new-window in shared session."

The cost of option 2: tmux is now mandatory, and if the shared session dies
the entire fleet dies together. Mitigated by orphan reconciliation (see below).

### Parent → worker stdin

`tmux send-keys -t <window> -l <text>` is the structured channel option 2
unlocks. `-l` is literal mode: tmux skips key-table interpretation, so
escapes and special characters can't accidentally trigger shortcuts. We also
prefix injected text with `[trail] ` so an attached user can tell their own
keystrokes apart from parent-injected ones.

We considered named FIFOs and Unix domain sockets. They would have been
necessary if we'd dropped tmux. With shared-tmux they were over-engineering.

### Worker output streaming

The parent shouldn't have to re-read `artifacts.json` to learn that a worker
state changed. We added an append-only NDJSON event stream at
`workers/<id>/events.ndjson`. The worker writes one JSON line per significant
event (state change, todo update, tool call). The parent tails the file: read
new bytes since the last held offset, detect rotation by `size < lastOffset`,
parse each line, hand to the dock.

Why NDJSON-on-disk rather than a Unix socket or `tmux pipe-pane`:

- A file survives parent restarts. `tail` from a previous offset works after a
  reload.
- `pipe-pane` captures terminal output (TUI noise, colours, ANSI), not
  structured events. We want the latter.
- Sockets need a server in the worker process plus reconnect logic. Disk
  append is one `appendFileSync` call. Simpler, robust.

Rotation policy: 5 MB cap, one generation retained (`events.ndjson.1`). That
limits worst-case unbounded growth without losing the most recent activity.

### Session JSONL seeding for prompt cache

On `/trail spawn`, we use `SessionManager.forkFrom(parentSession, workerCwd, workerSessionDir)` to copy the parent's JSONL into the worker's session dir
before launching pi. The worker then launches with `--continue`, picks up the
seeded file, and starts with the parent's discoveries already in context.

This gives two wins:

1. The shared prefix between parent and worker is cache-eligible on the
   provider side — first call is much cheaper.
2. The worker doesn't need to re-explore the codebase that the parent already
   walked. Real LLM-turn savings, not just token savings.

`/trail spawn --fresh` opts out. We also gracefully fall back when the parent
session file doesn't exist yet (pi defers JSONL flush until the first assistant
turn, so spawn-before-first-assistant gets a fresh worker).

## What is implemented

Two commits on the `feat/dock-perf-and-calm-ui` branch (plus one inherited
worker change-set commit). What follows is the technical substance:

### Performance

- **Watcher replaces polling.** `extensions/worker-dock-cache.ts` exposes
  `watchWorkersRoot(root, onChange, options)` which sets up `fs.watch` on the
  workers root (recursive on macOS), debounces 150 ms, and adds a 3 s fallback
  poll for systems where `fs.watch` is unreliable. The parent dock now reacts
  to writes instead of polling at 500 ms.
- **`WorkerSnapshotCache` keyed by mtime.** Holds per-worker
  `{ statusMtime, artifactsMtime, status, artifacts, eventOffset }`. Skips
  `readFile` + `JSON.parse` when mtime is unchanged. Drops entries when the
  worker dir disappears.
- **Re-entry guard.** `refreshWorkerDockWidget` won't run concurrently with
  itself — if a refresh is already in flight, a follow-up is queued and runs
  once exactly when the first completes.
- **Heartbeat dedup + cap.** The worker hashes its artifact list with
  `heartbeatArtifactSignature` (length + last ref + last timestamp) and skips
  the `writeArtifacts` call when unchanged. Cap of 200 artifacts per
  heartbeat. The status patch still runs so `updatedAt` advances and the
  parent sees liveness.

### Shared tmux topology

- All workers now live in a single tmux session named `trail-workers`. First
  `/trail spawn` creates the session with `tmux new-session -d -s trail-workers -n w<N>`. Subsequent spawns add windows with `tmux new-window`.
- Worker status carries `tmuxSession: "trail-workers:w<N>"` so kill/purge
  target the window, not the session. Legacy `trail-worker-<id>` sessions are
  still recognised by `killTmux` for graceful migration.
- `sendInput` uses `tmux send-keys -t <target> -l <[trail] text>` followed by
  a separate `Enter` send. Literal mode + `[trail] ` prefix.
- `launchSharedWindow` is the single entry point; it decides whether to
  `new-session` (first worker) or `new-window` (subsequent).
- `sharedSessionExists()` is exported so the dock can detect the case where
  the shared session has died but worker status.json files still claim
  active state. The reconciler then patches each orphan to `state: error`
  with a clear lastError.

### Worker event stream

- `extensions/worker-events.ts` owns the file format and tailer.
  `appendWorkerEventSync(root, id, { kind, payload })` appends one NDJSON line
  with a timestamp. `tailWorkerEvents(root, id, { offset })` reads new bytes
  since `offset`, parses each line, and returns `{ events, rotated, offset }`.
- Worker pi emits events at three sites: `applyWorkerState` (state transition),
  `applyWorkerTodos` (progress update), and `pi.on("tool_call", …)` (live
  tool activity). All write through the synchronous append helper.
- `WorkerSnapshotCache.snapshot()` now tails events alongside its status and
  artifacts reads. Returns `eventsByWorker: Map<id, WorkerEvent[]>`. The dock
  doesn't yet render events explicitly; it relies on the fact that
  `events.ndjson` writes drive the same `fs.watch` notification that drives
  status/artifact reads. Events are surfaced through the cache so future UI
  work can read them.
- Rotation at 5 MB, one generation retained.

### Cache seeding

- `seedWorkerSession(parentSessionFile, workerCwd, workerSessionDir)` calls
  `SessionManager.forkFrom`, returns a boolean.
- `buildWorkerLaunchCommand` accepts `resumeSeeded` and conditionally inserts
  `--continue` into the launch command.
- `WorkerCommands.spawn` and the grammar/router thread the `fresh` flag through
  so `/trail spawn --fresh investigate ...` opts out of seeding.
- Heartbeat captures `ctx.model.id` so the dock can render a model badge when
  the worker's model differs from the parent's.

### Calm UI

- Dock row format is `● w<N>[model?] state · task · progress · elapsed [chip]`,
  rendered one row per worker. Idle rows are dimmed; attention rows
  (`needs_input`, `failed`, `ready`, `ready_open_todos`) are state-coloured and
  receive a `← reply / inspect / review` chip on the right.
- `shortModelLabel` strips known provider prefixes for the badge. `pickModelBadge` hides the badge when the worker model matches the parent and all workers share that model; shows it otherwise.
- Inbox: the source toggle bar no longer carries the `s source` label prefix
  when pills are already visible.
- Footer trimmed to `↑↓ move · / search · ? more · Esc close`. The card already
  exposes its own contextual action row.

### Command surface

- `trailUsage(advanced?)` returns the primary six commands by default
  (`/trail`, `/trail spawn`, `/trail tell`, `/trail w<N>`,
  `/trail checkpoint`, `/trail continue`) plus `more: /trail help advanced`.
- `parseTrailCommand("help advanced")` toggles the longer view.
- New `/trail attach [w<N>]` lands as a first-class command. With no arg it
  copies `tmux attach -t trail-workers`. With a worker arg it copies the
  attach + `select-window` form so the user lands directly on that pane.

## What is left to do

Roughly in priority order — these are next-round candidates, not commitments.

1. **Render events in the dock.** The cache emits `eventsByWorker` but the
   dock doesn't read it yet. The natural next step is a sub-line under each
   thinking row showing the most recent tool call (`tool: edit src/foo.ts`)
   or the live todo just promoted. The plumbing is in place; this is pure UI.
2. **Idle eviction.** Auto-hide ended workers older than N hours from the
   dock (and ideally auto-prune their files after a configurable retention
   window). Keeps the dock calm without manual `/trail delete`.
3. **Stress test.** Spawn 8 workers, measure parent CPU and RAM at idle,
   compare against pre-refactor baseline. The win should be measurable; we
   should know the number.
4. **Sync architecture doc.** `docs/architecture.md` predates this work and
   doesn't mention the shared session, the event stream, or session seeding.
5. **Worker-side guardrails for the shared session.** Workers should know
   they share a tmux session with siblings. Mostly informational, but if a
   worker ever called `tmux kill-server` (unlikely) the whole fleet would
   die. Add to `worker-guardrails.md`: "never invoke tmux directly."
6. **Window-name collisions across crashes.** Worker indexes are
   monotonically incremented within a session lifetime, but if the parent
   crashes and restarts while leaving worker dirs on disk, a new spawn could
   reuse an old index. Acceptable today (orphans get reconciled to `error`
   before any reuse) but a stable `window_id` (e.g. `@7`) captured at
   creation time would be more robust.
7. **`tmux pipe-pane` for terminal capture, optionally.** We deliberately
   skipped this because we want structured events, not TUI noise. But for
   debugging a dead worker, having a `pane.log` of the actual terminal
   output (colours stripped) would be a real help. Could be opt-in via
   config.

## Things we chose to *not* do

- **No FIFO / Unix domain sockets.** Considered. The structured-channel
  motivation collapsed once we picked option 2 (tmux + `send-keys -l`).
- **No detached-child pi without tmux.** Considered as option 1. Loses the
  live-attach affordance the user values, returns minimal perf win at this
  worker count.
- **No socket-based event bus.** Considered. Disk NDJSON wins on simplicity,
  survives restarts, and the parent already runs `fs.watch` on the workers
  root for free.
- **No restructured tab completion.** Existing `TRAIL_COMMANDS` still includes
  every advanced command for tab completion. We hid commands from `/trail help`,
  not from the parser.

## Implementation summary by file

| File | Role |
|---|---|
| `extensions/worker-dock-cache.ts` | `WorkerSnapshotCache` + `watchWorkersRoot`; status/artifacts mtime cache + event tailer |
| `extensions/worker-events.ts` | NDJSON append + tail + rotation |
| `extensions/worker-store.ts` | Shared tmux session/window topology, `send-keys -l`, `seedWorkerSession`, `--continue` flag |
| `extensions/worker-activity.ts` | Dock row data model, `shortModelLabel`, `pickModelBadge`, `dockRowsForRender` |
| `extensions/background-work.ts` | `heartbeatArtifactSignature`, `HEARTBEAT_ARTIFACT_CAP` |
| `extensions/trail.ts` | Dock wiring, fs.watch lifecycle, orphan reconciliation, event emission on state/todo/tool, heartbeat dedup + model field |
| `extensions/trail-command-grammar.ts` | `/trail attach`, `--fresh`, `help advanced`, primary/advanced help split |
| `extensions/trail-command-router.ts` | Attach handler, shared-session attach command, fresh propagation, help advanced |

Tests: `tests/worker-dock-cache.test.ts`, `tests/worker-events.test.ts`,
`tests/shared-tmux.test.ts`, `tests/heartbeat.test.ts`,
`tests/dock-rows.test.ts`, `tests/worker-session-seed.test.ts`,
`tests/trail-help.test.ts`.
