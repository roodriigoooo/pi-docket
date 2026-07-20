# ADR-0004: Keep worker creation human-started; separate kind intent from execution

## Status

accepted

## Context

Worker kinds mixed two concerns:

- task intent and authority (`read_only`, plan gate, decision rights, output guidance), and
- launch execution (`model`, thinking, parent seed, worktree, tmux layout).

Kinds could also grant `docket_spawn_child`, creating a persisted worker hierarchy with depth limits and cascade deletion. That made spend and topology depend on markdown selected indirectly, while deleting one worker could delete others.

## Decision

Every Worker is created by a human action through `WorkerCommands.spawn`:

- `/docket spawn`, or
- approved Use → Worker.

Workers expose only `docket_todos`, `docket_wait`, `docket_done`, and `docket_fail`. They cannot create Workers. Persisted workers are independent; delete and prune affect only the requested Worker. `parentTmuxTarget` remains navigation back to the human launch session, and `sourceHandoff` remains reviewed-input provenance. Neither field defines worker topology.

`WorkerKind` now contains intent and authority only: name, description, read-only posture, plan gate, decision rights, soft artifact/time limits, guardrail/system-prompt additions, and source metadata.

One pure spawn-policy resolver chooses execution once for validation, confirmation, persistence, and launch. Precedence is:

| Concern | Highest → lowest |
|---|---|
| Kind | `--as` → `worker.defaultKind` → builtin default |
| Model | per-spawn/handoff choice → legacy kind model → canonical parent model |
| Thinking | per-spawn/handoff choice → legacy kind thinking → current parent thinking |
| Parent context | handoff forced-fresh / `--fresh` → `--seed` → `worker.parentSeedPolicy` → legacy kind `parent_seed` → fresh |
| Workspace | `--worktree` → legacy kind `default_worktree` → writable isolated / read-only shared |
| Tmux layout | legacy compatibility value → single |

Model refs must exactly match an available Pi `provider/model`; splitting occurs at first slash so model ids may contain slashes. Invalid model or thinking choices abort. Explicit non-off thinking on a non-reasoning model aborts; inherited thinking resolves visibly to `off`. If parent model is absent and no explicit or legacy model exists, launch aborts.

Interactive confirmation is required when resolved model/thinking differs from the parent, when a legacy execution default contributes, or for Use → Worker. Bare same-parent spawn stays low-friction. Noninteractive modes never wait for UI; they validate, announce resolved execution, and launch.

## Compatibility

Legacy kind execution frontmatter remains readable through the next major release. Docket diagnoses it and identifies contributing deprecated defaults at launch. `can_spawn` is parsed only to report that it is ignored because worker creation is human-only. Existing hierarchy keys in `status.json` and `worker.maxSpawnDepth` in config are harmless extra data; no storage rewrite runs.

Legacy `layout` remains compatibility-only until dedicated tmux layout work. Respawn uses stored canonical model/thinking and does not re-resolve against changed parent state.

## Consequences

Spend becomes visible and per-launch. Kinds remain reusable statements of task authority instead of hidden model profiles. Worker lifecycle is flat: independent launch, review, retry, and deletion. Existing custom kinds continue launching with migration warnings, while new builtins and runtime registrations use intent-only shapes.
