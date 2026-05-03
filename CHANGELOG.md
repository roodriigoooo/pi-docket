# Changelog

## 0.1.4

Included:
- soft-consume for `--once` checkpoints: marked consumed at session end (not on inject), files retained for `consumedRetentionDays` (default 7) so accidental cancels are recoverable
- `/trail load [id|last] [--include-consumed]` — lazy carryover of a prior checkpoint's artifacts into the navigator with **zero** model-context cost; injected only when user creates a chip with `/trail ref` or `/trail inject-full`
- `/trail unload <id|all>` — drop a loaded checkpoint from the session and cancel its pending consume contract
- navigator `s` key cycles source filter (current / all / `c1` / `c2` / ...); default view is `current`
- carryover artifacts namespaced as `<slot>.<displayId>` (e.g. `c1.f12`), refs unchanged
- `/trail list [--include-consumed]` shows soft-consumed checkpoints
- `/trail delete` permanently purges (bypasses soft-consume)

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
