# Changelog

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
