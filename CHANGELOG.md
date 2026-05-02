# Changelog

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
