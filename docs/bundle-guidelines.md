# Evidence bundle guidelines

Docket bundles preserve useful evidence for future decisions. They are not transcript archives and they do not replace Pi's session commands.

Use Pi for session movement:

- `/tree`
- `/fork`
- `/clone`
- `/compact`
- `/new`
- `/resume`

Use Docket bundles for evidence:

- `/docket save` — save selected artifacts and label current Pi tree leaf.
- `/docket load` — mount artifacts at zero model-context cost.
- `/docket ref` / `/docket inject-full` — attach specific artifacts only when needed.

## Principles

- Preserve decision-critical evidence only: goal, current state, decisions, failed attempts, dead ends, next steps, and references.
- Prefer artifact references over pasted content. Quote exact output only when it changes the next action.
- Separate facts from hypotheses. Do not present guesses, unknowns, or stale plans as decisions.
- Make failure history explicit enough to avoid repeated mistakes, but remove redundant logs and low-signal output.
- Keep next steps concrete and ordered.
- Optimize for context-window health. Smaller bundles are better when they preserve the same continuation power.

## Bundle-first shape

An evidence bundle is an artifact sidecar plus a deterministic orientation header — not a summary (see [ADR-0001](./adr/0001-bundle-first-checkpoints.md)). The header carries git state, files touched, errors, and the human note. Artifact contents never auto-enter model context.

The **note** is load-bearing: decisions and next steps are human-authored, never model-guessed. `--summarize` adds optional model prose on top.

## Artifact selection

Selection pre-picks a decision-oriented set (errors first, then files, commands, recent decisions). Interactive review removes noisy or irrelevant artifacts before persist.

Excluded artifacts should stay excluded from the orientation header references and the sidecar JSON.
