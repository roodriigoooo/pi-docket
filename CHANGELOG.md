# Changelog

## Unreleased

- **auto-embed ready summary**: when a worker reaches `ready`, trail appends a short summary (outcome + one-line headline + up to five recommended bullets) to the parent pi session via `pi.sendMessage({ triggerTurn: false })`. The parent assistant sees it on its next turn without manual `/trail inject`, and any worker spawned afterwards inherits it through session seeding — so sibling findings cross-pollinate without a dedicated channel. Full artifacts still live on disk; `/trail load w<N>` remains the path for the long-form detail. Gated by `worker.autoEmbedSummary` (default true) for users who prefer the pure-ledger behavior. New pure formatter `formatReadyEmbedMessage` in `extensions/worker-summary-embed.ts` is fully testable without pi.
- **kind visibility in the UI**: the worker kind now shows in three surfaces that previously only labelled the worker by index. Dock row renders `● w1·scout …` next to the label; the spawn announce chip becomes `w3·patcher[o  ] · starting`; the spawn-detail and the `/trail w<N>` mini-report both gain an explicit `kind:` line. The implicit `default` kind is suppressed everywhere to keep the common case clean. Model badge keeps its existing brackets so kind and model are visually distinct.

## 0.3.0

Included:
- **worker kinds**: frontmatter MD presets that tune one worker's posture without changing the protocol contract. Bundled `scout` (fast read-only recon) and `patcher` (edits in worktree, can dispatch scout) under `extensions/worker-kinds/`; user overrides in `~/.pi/agent/trail/worker-kinds/*.md` and `<project>/.pi/trail/worker-kinds/*.md`. Fields: `name`, `description`, `model`, `thinking`, `read_only`, `default_worktree`, `parent_seed`, `max_artifacts`, `max_duration_sec`, `can_spawn`, `layout`, `guardrails_append`, plus a markdown body that is *appended* to the universal guardrails (never replaces them).
- **`/trail spawn --as <kind>`**: pick a kind per spawn. `/trail kinds` lists registered kinds.
- **fleet + depth caps**: `worker.maxActive` (default 8) rejects spawns past the cap with a clear error rather than queuing. `worker.maxSpawnDepth` (default 2) bounds how deep child spawns can recurse.
- **cascade delete**: `/trail delete w<N>` now purges children dispatched via `trail_spawn_child` along with the parent.
- **`trail_spawn_child` tool**: only registered for workers whose kind has a `can_spawn` allowlist and only when current depth is below the cap. Child status carries `parentWorkerId`/`depth`; child outcome surfaces in the parent worker's inbox, not directly to the human user.
- **stable tmux window id**: `tmuxWindowId` (`@N`) captured at spawn time. kill, send-keys, and pipe-pane target the id first with name fallback, so renamed/recycled windows no longer misroute parent input.
- **per-kind tmux layout**: `layout: split-events` opens a right pane showing `tail -F events.ndjson` so the user can watch tool activity live without context switching.
- **optional tmux status-line dock**: `worker.tmuxStatusLine: true` writes a compact `trail ?N ✗N ✓N ●N` summary to the shared session's `status-right` so the dock survives even when you're attached to a pane.
- **optional terminal capture**: `worker.captureTerminal: true` enables `tmux pipe-pane` to `pane.log` inside each worker dir for post-hoc debug.
- **`/trail respawn <w<N>|all>`**: relaunch workers whose tmux window died (orphan reconciliation no longer means losing the session dir).
- **`globalThis.__trail` extension surface**: `registerWorkerKind`, `listWorkerKinds`, `onWorkerEvent`. Other pi extensions can contribute kinds at runtime and subscribe to worker events without coupling to trail internals.
- **worker event subscription**: `WorkerSnapshotCache.snapshot()` now returns `newEventsByWorker` (events read this tick) alongside the existing sticky `eventsByWorker` ring. The parent dock pipes new events through the extension surface on every refresh.
- new tests cover worker-kinds parsing + registry, extension surface, grammar (`--as`, `kinds`, `respawn`), cascade purge, and `countActive`.
- **docs cleanup**: README slimmed (587 → ~400 lines) and points at new `docs/configuration.md` for the full config reference, worker-kind frontmatter table, and worked kind examples. `docs/architecture.md` rewritten as a module map + worker lifecycle + storage + extension surface. `docs/stress-test.md` moved out of `scripts/` and inlined the sampler so it has no external dependency. `docs/design-decisions-tmux-and-events.md` removed; same content now lives in much shorter form in `docs/architecture.md`. `scripts/` removed from the package and gitignored. npm-pack leak of personal stress-test results closed by moving the file to a hidden, gitignored path.
- **README banner**: npm version badge.

## 0.2.2

Included:
- shared `trail-workers` tmux session: one server hosts every worker window instead of N servers
- worker NDJSON event stream at `workers/<id>/events.ndjson` for state, todo, and tool-call events
- dock sub-line under thinking workers showing the latest non-protocol tool call (file path, command, etc.)
- `WorkerSnapshotCache` keeps a sticky recent-event buffer so sub-lines survive across refresh ticks
- `fs.watch`-driven dock refresh in place of the 500 ms polling timer, with mtime-cached status + artifacts reads
- heartbeat dedup: workers skip `writeArtifacts` when their artifact list signature is unchanged
- session JSONL seeding (`SessionManager.forkFrom`) so spawned workers resume from the parent's prefix and hit the provider's prompt cache. Opt out with `/trail spawn --fresh`
- `/trail attach [w<N>]` first-class command that copies the tmux attach incantation, optionally pinned to one worker
- idle eviction: ended workers auto-hide from the dock after `worker.dockIdleHideMinutes` (default 30) and auto-prune after `worker.pruneAfterHours` (default 24)
- worker guardrails note that the tmux session is shared; workers must not invoke `tmux` directly
- README simplified, outdated demo gifs removed
- stress-test runbook + sampler under `scripts/`
- architecture doc resynced (storage layout, shared topology, event stream, eviction)

## 0.2.1

Included:
- README rewrite with a more direct, personal tone
- note that current GIFs are outdated and need refreshing

## 0.2.0

Included:
- compact worker dock above the prompt for live worker state without context injection
- worker protocol tools (`trail_wait`, `trail_done`, `trail_fail`) plus bash fallback interception for accidental `/trail wait|done|fail` calls
- `/trail tell w<N> [text]` for explicit worker input/follow-up, with modal input when text is omitted
- simplified Navigator modes: Review, Answers, All
- hard rename from Memory to Answers and Catalog to All
- numeric mode keys (`1` Review, `2` Answers, `3` All) and `t` for telling workers
- `/trail workers` positioned as a debug/power view with clearer labels
- docs and tests for updated worker/mode UX

## 0.1.4

Included:
- soft-consume for `--once` checkpoints: marked consumed at session end (not on inject), files retained for `consumedRetentionDays` (default 7) so accidental cancels are recoverable
- `/trail load [id|last|w<N>] [--include-consumed]` — lazy carryover of checkpoint or worker artifacts into the navigator with **zero** model-context cost; injected only when user creates a chip with `/trail ref` or `/trail inject-full`
- unified `/trail load` picker for checkpoints and workers, with preview for checkpoints before loading
- `/trail unload <id|w<N>|all>` — drop loaded checkpoint/worker artifacts from the session and cancel pending checkpoint consume contracts
- tmux-backed `/trail spawn <task>` workers, plus `/trail list --workers`, `/trail load w<N>`, and `/trail delete w<N>`
- worker artifact snapshots so parent sessions can inspect and reference worker findings via loaded slots
- JSONL-backed checkpoint event log with legacy index backfill
- navigator `s` key cycles source filter (current / all / `c1` / `w1` / ...); default view is `current`
- carryover artifacts namespaced as `<slot>.<displayId>` (e.g. `c1.f12` or `w2.c3`), refs unchanged
- `/trail list [--include-consumed]` shows soft-consumed checkpoints
- `/trail delete` permanently purges checkpoints (bypasses soft-consume) and kills workers when targeting `w<N>`
- internal deepening: Loaded Artifact Context, Checkpoint Commands, and Worker Commands concentrate reference/carryover and command-flow logic behind tested Modules

## 0.1.3

Included:
- ranked artifact search index backing `/trail search`, with ripgrep-backed candidate scoring and in-memory fallback
- npm trusted publishing pipeline for releases
- README demo videos / gif walkthroughs

## 0.1.2

Included:
- cleaner checkpoint reference lists with single file guidance note
- hidden checkpoint context loading for `/trail continue` to avoid editor prompt bloat
- loaded checkpoint chip above the editor
- `/trail delete [id|last]` command
- checkpoint selector delete action with confirmation

## 0.1.1

Included:
- centered Trail command-center overlay with stronger island borders
- denser artifact rows with filter chips, relative time, and preview toggle
- interactive `/trail resume` / `/trail continue` checkpoint selector
- checkpoint preview and edit-before-continue flow
- checkpoint summaries with file, error, command, and token estimates

## 0.1.0

Initial package scaffold.

Included:
- `/trail` artifact navigator
- artifact search via ripgrep-backed temp docs
- compact artifact references
- full artifact injection
- summarized/raw checkpoints
- one-off `--once` checkpoints
- checkpoint sidecar artifacts
