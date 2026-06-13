# Changelog

## Unreleased

- **worker pre-flight briefs**: `task.md` now starts with kind, workspace, decision rights, and plan-gate policy so workers know their authority before they act.
- **plan-gated patcher**: worker kinds can set `plan_gate: true` and `decision_rights`. The bundled `patcher` now does read-only discovery first, then asks through `docket_wait` before its first edit or mutating command.
- **passive worker warnings**: the dock shows `silent Nm` when a running worker has no recent tool/todo event and `waiting Nm` when a parent question ages. No auto-kill, no auto-respawn.
- **tmux docs**: README now spells out the tmux API boundary: shared session spawn, literal reply, paste-buffer multiline tell, capture-pane peek, dead-pane harvest, optional `pipe-pane`, and status-line HUD.

## 0.5.0

- **post-mortem terminal tails**: worker windows now run with `remain-on-exit on`, so a crashing worker leaves its dead pane behind. The parent captures the last lines to `pane-tail.txt`, then cleans the window up. The capture shows up in review as a `terminal tail` artifact and the failed verdict card prints the final lines. You see why a worker died, not just its exit code.
- **peek**: in `/docket workers`, `p` shows a live read-only view of the selected worker's tmux pane inside the dashboard, refreshing about once a second. Check on a worker without attaching and without spending model context. `p` or `Esc` closes it.
- **two-pane review**: on terminals around 120 columns and wider, `/docket` renders the item list on the left and the selected item's card plus evidence preview on the right. Narrower terminals keep the stacked layout.
- **decision ledger**: every resolved verdict (accept, reject, reject & stop, chat, option-send) is appended to `~/.pi/agent/docket/decisions.ndjson` with the verb, option text, any risk shown, and the evidence refs that were on the card. `/docket log decisions` (or `/docket decisions`) renders the ledger: a last-7-days headline, a per-verb breakdown, and the recent entries. When a terminal worker is pruned with no verdict ever recorded, that counts as decision debt and shows up as "N workers evicted unreviewed this week" so automation bias stays visible instead of silent.
- **safer verdict keys**: the verdict card now numbers worker-proposed options so you can pick one directly with `1`..`9`, and sets `Reject & stop` apart with a blank line and warning color since it kills the worker and removes its workspace. Number keys only reach the offered options, never the destructive verb.
- **docket key cleanup**: in `/docket`, reply and save are split off the old overloaded `c` into `r` (reply to worker) and `b` (save bundle), and the duplicate `c`/`t`/`i` aliases are gone. `a` is the single attach key. Footer and `?` help updated to match.
- **multiline replies**: `/docket tell` and the verdict chat reply now preserve line breaks. A multiline message is delivered through a tmux paste buffer (bracketed paste) so the worker reads the whole block at once instead of running it on the first newline; one-liners keep the existing send-keys path.
- new tests cover the decision ledger (summary/render/eviction debt), the verdict number keys and destructive-verb guard, the navigator key cleanup, the multiline input classifiers, and the `decisions` grammar.
- **release notes**: see [docs/releases/0.5.0.md](docs/releases/0.5.0.md).

## 0.4.0

- **rename to pi-docket**: product, package, repo title, command, storage paths, worker tools, tmux session, and extension surface now use Docket. Package is `@roodriigoooo/pi-docket`; GitHub repo title should be `pi-docket`; command is `/docket`; extension surface is `globalThis.__docket`; worker tmux session is `docket-workers`.
- **no compatibility command aliases**: old `/trail` commands are intentionally not retained. Removed public grammar for `/docket checkpoint`, `/docket continue`, `/docket resume`, short aliases (`ckpt`, `r`, `s`, `v`), worker-result aliases (`w<N>`, `result`, `use`), and `inject` alias. The command surface now favors explicit verbs.
- **evidence bundles replace checkpoint-first UX**: use `/docket save` to save selected evidence as a durable zero-token bundle and label the current Pi tree leaf; use `/docket load` to mount bundle or worker artifacts. Pi's native `/tree`, `/fork`, `/clone`, `/compact`, `/new`, and `/resume` remain responsible for session movement and context topology.
- **worker protocol renamed**: workers now call `docket_todos`, `docket_wait`, `docket_done`, `docket_fail`, and `docket_spawn_child`. Worker-side `/docket wait|done|fail` remains only a fallback for prompt entry mistakes.
- **release notes**: see [docs/releases/0.4.0.md](docs/releases/0.4.0.md) for rationale, migration notes, and repository rename checklist.

## 0.3.2

- **bundle-first checkpoints**: a checkpoint is now a frozen artifact bundle (`<id>.artifacts.json`) plus a small deterministic orientation header — git state, files touched, errors, and your note — not a model summary. `continue` and `load` both *mount* the bundle at zero model-context tokens; `continue` injects only the header, and artifacts are chipped on demand. The model summarizer becomes an opt-in `--summarize` layer (`--model` / `--max-output` imply it), off the default path. The four mode flags (`--handoff` / `--compact` / `--debug` / `--review`) and `--raw` are dropped in favour of one default selection that the interactive selector prunes. Checkpoints written by older versions still read and continue (`CheckpointMode` kept for back-compat reads). Rationale in [ADR-0001](docs/adr/0001-bundle-first-checkpoints.md); a new `CONTEXT.md` glossary fixes the "checkpoint = bundle, not summary" ambiguity.
- **verdict card**: a focused per-worker decision surface. Open it with `ctrl+shift+d` (jumps to the highest-attention decision), `/docket v` / `/docket verdict [w<N>]`, or `enter` on a worker row. It reads only status fields and the deterministic change set — the worker's intent line, its question, or the diffstat (`+/-` with a proportional bar) — never the transcript or artifacts, so it costs zero model-context tokens. `d` opens the full diff in an overlay without injecting it.
- **worker-proposed decisions**: `docket_wait({ risk?, options?, recommend? })` lets a blocked worker propose discrete branches. The card renders them as the menu (sent back to the worker verbatim), pre-selects the recommended option, and surfaces `risk` as a warning — ADR-0001's human-authored-note lesson applied to the question side.
- **verdict queue**: opening the card without a target now walks every pending decision in attention order instead of resolving only the top one — the footer counts what's left and `esc` stops the walk. It re-ranks after each resolution so new arrivals and dismissals stay current. Verbs name the outcome: **promote** / **discard** when a change set exists, **acknowledge** / **dismiss** when it doesn't, plus **reject & stop** and **chat**; a cancelled sub-action returns to the verb menu instead of closing the card.
- **live dock dot**: the frozen `[o  ]` worker chip becomes a breathing dot that animates only while a worker is active; static mascot frames are stripped from one-shot spawn messages.
- **cross-project worker views**: `/docket workers --all` and `/docket list --all` surface workers from other projects, and the dock breadcrumb summarizes their attention state (`N waiting · N failed · N ready`) instead of a bare count.
- new tests cover verdict verbs/queue, the change-set card, structured `docket_wait`, bundle-first checkpoint selection + orientation header, and cross-project worker ranking.

## 0.3.1

- **auto-embed ready summary**: when a worker reaches `ready`, docket appends a short summary (outcome + one-line headline + up to five recommended bullets) to the parent pi session via `pi.sendMessage({ triggerTurn: false })`. The parent assistant sees it on its next turn without manual `/docket inject`, and any worker spawned afterwards inherits it through session seeding — so sibling findings cross-pollinate without a dedicated channel. Full artifacts still live on disk; `/docket load w<N>` remains the path for the long-form detail. Gated by `worker.autoEmbedSummary` (default true) for users who prefer the pure-ledger behavior. New pure formatter `formatReadyEmbedMessage` in `extensions/worker-summary-embed.ts` is fully testable without pi.
- **kind visibility in the UI**: the worker kind now shows in three surfaces that previously only labelled the worker by index. Dock row renders `● w1·scout …` next to the label; the spawn announce chip becomes `w3·patcher[o  ] · starting`; the spawn-detail and the `/docket w<N>` mini-report both gain an explicit `kind:` line. The implicit `default` kind is suppressed everywhere to keep the common case clean. Model badge keeps its existing brackets so kind and model are visually distinct.

## 0.3.0

Included:
- **worker kinds**: frontmatter MD presets that tune one worker's posture without changing the protocol contract. Bundled `scout` (fast read-only recon) and `patcher` (edits in worktree, can dispatch scout) under `extensions/worker-kinds/`; user overrides in `~/.pi/agent/docket/worker-kinds/*.md` and `<project>/.pi/docket/worker-kinds/*.md`. Fields: `name`, `description`, `model`, `thinking`, `read_only`, `default_worktree`, `parent_seed`, `max_artifacts`, `max_duration_sec`, `can_spawn`, `layout`, `guardrails_append`, plus a markdown body that is *appended* to the universal guardrails (never replaces them).
- **`/docket spawn --as <kind>`**: pick a kind per spawn. `/docket kinds` lists registered kinds.
- **fleet + depth caps**: `worker.maxActive` (default 8) rejects spawns past the cap with a clear error rather than queuing. `worker.maxSpawnDepth` (default 2) bounds how deep child spawns can recurse.
- **cascade delete**: `/docket delete w<N>` now purges children dispatched via `docket_spawn_child` along with the parent.
- **`docket_spawn_child` tool**: only registered for workers whose kind has a `can_spawn` allowlist and only when current depth is below the cap. Child status carries `parentWorkerId`/`depth`; child outcome surfaces in the parent worker's inbox, not directly to the human user.
- **stable tmux window id**: `tmuxWindowId` (`@N`) captured at spawn time. kill, send-keys, and pipe-pane target the id first with name fallback, so renamed/recycled windows no longer misroute parent input.
- **per-kind tmux layout**: `layout: split-events` opens a right pane showing `tail -F events.ndjson` so the user can watch tool activity live without context switching.
- **optional tmux status-line dock**: `worker.tmuxStatusLine: true` writes a compact `docket ?N ✗N ✓N ●N` summary to the shared session's `status-right` so the dock survives even when you're attached to a pane.
- **optional terminal capture**: `worker.captureTerminal: true` enables `tmux pipe-pane` to `pane.log` inside each worker dir for post-hoc debug.
- **`/docket respawn <w<N>|all>`**: relaunch workers whose tmux window died (orphan reconciliation no longer means losing the session dir).
- **`globalThis.__docket` extension surface**: `registerWorkerKind`, `listWorkerKinds`, `onWorkerEvent`. Other pi extensions can contribute kinds at runtime and subscribe to worker events without coupling to docket internals.
- **worker event subscription**: `WorkerSnapshotCache.snapshot()` now returns `newEventsByWorker` (events read this tick) alongside the existing sticky `eventsByWorker` ring. The parent dock pipes new events through the extension surface on every refresh.
- new tests cover worker-kinds parsing + registry, extension surface, grammar (`--as`, `kinds`, `respawn`), cascade purge, and `countActive`.
- **docs cleanup**: README slimmed (587 → ~400 lines) and points at new `docs/configuration.md` for the full config reference, worker-kind frontmatter table, and worked kind examples. `docs/architecture.md` rewritten as a module map + worker lifecycle + storage + extension surface. `docs/stress-test.md` moved out of `scripts/` and inlined the sampler so it has no external dependency. `docs/design-decisions-tmux-and-events.md` removed; same content now lives in much shorter form in `docs/architecture.md`. `scripts/` removed from the package and gitignored. npm-pack leak of personal stress-test results closed by moving the file to a hidden, gitignored path.
- **README banner**: npm version badge.

## 0.2.2

Included:
- shared `docket-workers` tmux session: one server hosts every worker window instead of N servers
- worker NDJSON event stream at `workers/<id>/events.ndjson` for state, todo, and tool-call events
- dock sub-line under thinking workers showing the latest non-protocol tool call (file path, command, etc.)
- `WorkerSnapshotCache` keeps a sticky recent-event buffer so sub-lines survive across refresh ticks
- `fs.watch`-driven dock refresh in place of the 500 ms polling timer, with mtime-cached status + artifacts reads
- heartbeat dedup: workers skip `writeArtifacts` when their artifact list signature is unchanged
- session JSONL seeding (`SessionManager.forkFrom`) so spawned workers resume from the parent's prefix and hit the provider's prompt cache. Opt out with `/docket spawn --fresh`
- `/docket attach [w<N>]` first-class command that copies the tmux attach incantation, optionally pinned to one worker
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
- worker protocol tools (`docket_wait`, `docket_done`, `docket_fail`) plus bash fallback interception for accidental `/docket wait|done|fail` calls
- `/docket tell w<N> [text]` for explicit worker input/follow-up, with modal input when text is omitted
- simplified Navigator modes: Review, Answers, All
- hard rename from Memory to Answers and Catalog to All
- numeric mode keys (`1` Review, `2` Answers, `3` All) and `t` for telling workers
- `/docket workers` positioned as a debug/power view with clearer labels
- docs and tests for updated worker/mode UX

## 0.1.4

Included:
- soft-consume for `--once` checkpoints: marked consumed at session end (not on inject), files retained for `consumedRetentionDays` (default 7) so accidental cancels are recoverable
- `/docket load [id|last|w<N>] [--include-consumed]` — lazy carryover of checkpoint or worker artifacts into the navigator with **zero** model-context cost; injected only when user creates a chip with `/docket ref` or `/docket inject-full`
- unified `/docket load` picker for checkpoints and workers, with preview for checkpoints before loading
- `/docket unload <id|w<N>|all>` — drop loaded checkpoint/worker artifacts from the session and cancel pending checkpoint consume contracts
- tmux-backed `/docket spawn <task>` workers, plus `/docket list --workers`, `/docket load w<N>`, and `/docket delete w<N>`
- worker artifact snapshots so parent sessions can inspect and reference worker findings via loaded slots
- JSONL-backed checkpoint event log with legacy index backfill
- navigator `s` key cycles source filter (current / all / `c1` / `w1` / ...); default view is `current`
- carryover artifacts namespaced as `<slot>.<displayId>` (e.g. `c1.f12` or `w2.c3`), refs unchanged
- `/docket list [--include-consumed]` shows soft-consumed checkpoints
- `/docket delete` permanently purges checkpoints (bypasses soft-consume) and kills workers when targeting `w<N>`
- internal deepening: Loaded Artifact Context, Checkpoint Commands, and Worker Commands concentrate reference/carryover and command-flow logic behind tested Modules

## 0.1.3

Included:
- ranked artifact search index backing `/docket search`, with ripgrep-backed candidate scoring and in-memory fallback
- npm trusted publishing pipeline for releases
- README demo videos / gif walkthroughs

## 0.1.2

Included:
- cleaner checkpoint reference lists with single file guidance note
- hidden checkpoint context loading for `/docket continue` to avoid editor prompt bloat
- loaded checkpoint chip above the editor
- `/docket delete [id|last]` command
- checkpoint selector delete action with confirmation

## 0.1.1

Included:
- centered Docket command-center overlay with stronger island borders
- denser artifact rows with filter chips, relative time, and preview toggle
- interactive `/docket resume` / `/docket continue` checkpoint selector
- checkpoint preview and edit-before-continue flow
- checkpoint summaries with file, error, command, and token estimates

## 0.1.0

Initial package scaffold.

Included:
- `/docket` artifact navigator
- artifact search via ripgrep-backed temp docs
- compact artifact references
- full artifact injection
- summarized/raw checkpoints
- one-off `--once` checkpoints
- checkpoint sidecar artifacts
