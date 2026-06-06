# Rename Trail to Docket

Trail is renamed to **Docket** and the repository/package title becomes **pi-docket**.

## Status

accepted

## Context

The old name, Trail, suggested a history path, transcript browser, or session-resume tool. That conflicted with the product direction.

Pi already provides first-class session topology and context-management tools: `/tree`, `/fork`, `/clone`, `/compact`, `/new`, and `/resume`. Docket should respect those instead of competing with them.

The extension's stronger identity is a decision queue: artifacts become review items, workers produce evidence, verdict cards resolve cases, and evidence bundles can be mounted at zero model-context cost.

## Decision

Rename the product surface to Docket:

- package: `@roodriigoooo/pi-docket`
- repo title: `pi-docket`
- command: `/docket`
- extension entrypoint: `extensions/docket.ts`
- extension surface: `globalThis.__docket`
- worker tmux session: `docket-workers`
- worker protocol tools: `docket_todos`, `docket_wait`, `docket_done`, `docket_fail`, `docket_spawn_child`
- config/storage paths: `~/.pi/agent/docket*` and `.pi/docket*`

Do not keep `/trail` compatibility aliases. Command bloat works against the new clarity.

Replace checkpoint-first user language with **evidence bundle** language:

- `/docket save` creates a durable evidence bundle and labels the current Pi tree leaf.
- `/docket load` mounts bundle or worker artifacts at zero model-context cost.
- Pi owns continuation and branch/session movement.

## Consequences

- This is a breaking release.
- Users must move from `/trail` to `/docket`.
- Old Trail storage is not automatically read from the new Docket paths. Migration is a copy operation documented in README and release notes.
- Internal TypeScript module names may still use `checkpoint` where storage compatibility makes a full rename low-value.
- Future spawn suggestions, if added, must be rare and explicit: only when context-heavy work is obvious, maps to a known worker kind, and separate context protects the parent session.
