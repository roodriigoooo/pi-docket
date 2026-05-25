# Checkpoint guidelines

Trail checkpoints preserve useful work state for a fresh session. They are not transcript archives.

## Principles

- Preserve restart-critical context only: goal, current state, decisions, failed attempts, dead ends, next steps, and references.
- Prefer artifact references over pasted content. Quote exact output only when it changes the next action.
- Separate facts from hypotheses. Do not present guesses, unknowns, or stale plans as decisions.
- Make failure history explicit enough to avoid repeated mistakes, but remove redundant logs and low-signal output.
- Keep next steps concrete and ordered.
- Optimize for context window health. Smaller checkpoints are better when they preserve the same continuation power.

## Bundle-first shape

A checkpoint is an artifact **bundle** plus a deterministic **orientation header** — not a summary (see [ADR-0001](./adr/0001-bundle-first-checkpoints.md)). The header carries git state, files touched, errors, and the note; `continue`/`load` mount the bundle at zero token cost. Artifact contents never auto-enter context.

The **note** is load-bearing: decisions and next steps are human-authored (the note + the editor pass that fills `## Decisions` / `## Next steps`), never model-guessed. `--summarize` adds optional model prose on top.

## Artifact selection

Selection pre-picks a restart-oriented set (errors first, then files, commands, recent decisions). Interactive review removes noisy or irrelevant artifacts before persist.

Excluded artifacts should stay excluded from the checkpoint header references and the sidecar JSON.
