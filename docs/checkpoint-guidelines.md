# Checkpoint guidelines

Trail checkpoints preserve useful work state for a fresh session. They are not transcript archives.

## Principles

- Preserve restart-critical context only: goal, current state, decisions, failed attempts, dead ends, next steps, and references.
- Prefer artifact references over pasted content. Quote exact output only when it changes the next action.
- Separate facts from hypotheses. Do not present guesses, unknowns, or stale plans as decisions.
- Make failure history explicit enough to avoid repeated mistakes, but remove redundant logs and low-signal output.
- Keep next steps concrete and ordered.
- Optimize for context window health. Smaller checkpoints are better when they preserve the same continuation power.

## Mode expectations

- `handoff`: preserve enough state for another agent/session to continue safely.
- `compact`: smallest useful continuation note; omit nice-to-have context.
- `debug`: emphasize failures, hypotheses tried, dead ends, and safest next checks.
- `review`: emphasize changed files, decisions, risks, test status, and reviewer focus.

## Artifact selection

Checkpoint mode chooses initial artifacts. Interactive review should remove noisy or irrelevant artifacts before summarization.

Excluded artifacts should stay excluded from checkpoint markdown and sidecar JSON.
