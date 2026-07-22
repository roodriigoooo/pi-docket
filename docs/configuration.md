# Configuration

Docket reads two files and merges them, project overriding global:

1. `~/.pi/agent/docket.json` — global
2. `<project>/.pi/docket.json` — project

Both optional. Defaults below.

## Realistic example

```json
{
  "maxArtifacts": 300,
  "maxBodyChars": 6000,

  "worker": {
    "maxActive": 8,
    "defaultKind": "default",
    "parentSeedPolicy": "none",
    "dockIdleHideMinutes": 30,
    "pruneAfterHours": 24,
    "guardrailsPath": "~/.pi/agent/docket/my-worker-rules.md"
  }
}
```

## Core artifact knobs

| key | default | meaning |
|---|---|---|
| `maxArtifacts` | 300 | hard cap on artifacts kept per session. older entries fall off. |
| `maxBodyChars` | 6000 | truncate any single artifact body to this many chars before storing. |
Deliverables do not use an artifact pool, summarizer, retention sweep, or event-backed index. The old `bundleArtifacts`, `checkpointArtifacts`, `consumedRetentionDays`, and `summarizer` keys are diagnosed once and ignored; old bundle files remain readable through the compatibility reader.

## Durable deliverables

New saves live at `~/.pi/agent/docket/deliverables/<safe-id>/v<N>.json`. Worker-backed ids are deterministic from the worker id; parent-authored ids contain a timestamp and entropy. Each claimed version is immutable and saves of the same worker generation are idempotent.

## Worker fleet

| key | default | meaning |
|---|---|---|
| `worker.maxActive` | 8 | reject `/docket spawn` once this many workers are starting/active/idle/needs_input. |
| `worker.defaultKind` | `default` | kind used when `/docket spawn` omits `--as`. |
| `worker.parentSeedPolicy` | `none` | `"full"` seeds parent JSONL when no per-spawn context flag is present; explicit `"none"` keeps workers fresh and overrides legacy kind seeding. |
| `worker.dockIdleHideMinutes` | 30 | hide ended workers from dock after this many minutes; 0 keeps them. |
| `worker.pruneAfterHours` | 24 | auto-prune ended worker dirs after this many hours; 0 disables. |
| `worker.guardrailsPath` | bundled | absolute or cwd-relative universal guardrail replacement. |

`worker.maxSpawnDepth` is removed. Existing JSON keys are ignored. Workers cannot create workers, and delete/prune affects one requested worker only.

`worker.defaultKind` preserves that kind's declared rights; Docket does not add an implicit plan gate. `worker.guardrailsPath` replaces packaged `extensions/worker-guardrails.md` for every worker.

### Per-spawn execution

```text
/docket spawn --model <provider/model> --thinking <level> [--seed|--fresh] [--as <kind>] [--worktree] [--] <task>
```

Both `--flag value` and `--flag=value` work. `--` ends option parsing. Unknown option-like tokens before `--` fail instead of becoming task text. If both context flags appear, `--fresh` wins.

Model/thinking default to current parent execution. Model refs must exactly match `ctx.modelRegistry.getAvailable()` as `provider/model`; model ids may contain more `/` characters. Thinking is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Invalid execution aborts. Explicit non-off thinking on a non-reasoning model aborts; inherited thinking resolves visibly to `off`.

Interactive Docket asks for confirmation when resolved model/thinking differs from parent or deprecated kind execution contributes. Bare same-parent spawn does not ask. Print/JSON/noninteractive mode never waits for UI; it emits resolved launch details and starts. Every launch and status records canonical model plus effective thinking.

Execution precedence:

| concern | highest → lowest |
|---|---|
| kind | `--as` → `worker.defaultKind` → builtin default |
| model | `--model` / handoff choice → legacy kind model → parent model |
| thinking | `--thinking` / handoff choice → legacy kind thinking → parent thinking |
| context | handoff forced-fresh / `--fresh` → `--seed` → `worker.parentSeedPolicy` → legacy `parent_seed` → fresh |
| workspace | `--worktree` → legacy `default_worktree` → writable isolated / read-only shared |
| tmux | implementation detail; one shared session/window per worker, stable pane targeting, durable PTY, and remain-on-exit |

## Worker kinds

Kind markdown states task intent and authority, not normal execution. Files load from:

- `~/.pi/agent/docket/worker-kinds/*.md`
- `<project>/.pi/docket/worker-kinds/*.md`

Bundled `default`, `scout`, and `patcher` kinds are intent-only.

### Current frontmatter

| field | default | meaning |
|---|---|---|
| `name` | — | required slug selected by `--as` |
| `description` | — | one-line intent shown by `/docket kinds` |
| `read_only` | false | forbids edits; workspace derives shared unless `--worktree` |
| `plan_gate` | false | requires `docket_wait` before first mutation |
| `decision_rights` | none | authority lines shown in `task.md` and guardrails |
| `max_artifacts` | — | soft guidance cap; not enforced |
| `max_duration_sec` | — | soft time guidance |
| `guardrails_append` | — | extra kind guardrail lines |

Markdown body appends output expectations and kind-specific instructions to universal guardrails. It never replaces them. Every kind uses exactly four protocol tools: `docket_todos`, `docket_wait`, `docket_done`, and `docket_fail`.

Workspace derives from intent: read-only kinds share parent directory; writable kinds receive isolated workspace. Both start fresh unless `--seed` or `worker.parentSeedPolicy: "full"` applies.

Example:

```markdown
---
name: reviewer
description: Read-only diff review against HEAD.
read_only: true
max_duration_sec: 180
---

Read the diff vs HEAD. Call `docket_done` with concrete file:line evidence,
overall risk, and ordered recommendations.
```

Choose spend at launch, not in kind:

```text
/docket spawn --as reviewer --model anthropic/claude-opus-4-6 --thinking high audit error handling
```

### Legacy execution frontmatter

Through next major release Docket still reads `model`, `thinking`, `parent_seed`, and `default_worktree`. `/docket kinds`, confirmation, warnings, and launch details mark these deprecated; valid values keep their precedence shown above. Migrate model/thinking to spawn flags, seeding to `worker.parentSeedPolicy` or context flags, and rely on intent-derived workspace.

`can_spawn` is different: it is ignored immediately and diagnosed as `can_spawn ignored; worker creation is human-only.` No worker receives a spawn tool. Legacy hierarchy fields in status JSON remain harmless extra data and are never used for list, respawn, attach fallback, or deletion.

Legacy `layout` declarations are recognized only to emit `layout ignored; operator layouts moved out of core.` They never affect spawn policy, confirmation, or tmux behavior.

### Runtime registration

Other Pi extensions contribute the same intent-only shape:

```ts
globalThis.__docket?.registerWorkerKind({
  name: "linkcheck",
  description: "Verify external links in markdown",
  readOnly: true,
  systemPrompt: "Verify HTTP links in *.md and report broken ones.",
});
```

Pre-0.8 runtime objects remain normalized through compatibility metadata and produce migration warnings. See [architecture.md](./architecture.md) for full extension surface.

## Storage paths

New deliverable state:

- `~/.pi/agent/docket/deliverables/<safe-id>/v<N>.json`

Legacy bundle compatibility state (never created or converted by the new save path; consume metadata and explicit delete may still update it):

- `~/.pi/agent/docket/checkpoints/<id>.md`
- `~/.pi/agent/docket/checkpoints/<id>.artifacts.json`
- `~/.pi/agent/docket/events.ndjson`
- `~/.pi/agent/docket/index.json` (compatibility snapshot)

Worker state:

- `~/.pi/agent/docket/workers/<id>/task.md`
- `~/.pi/agent/docket/workers/<id>/status.json`
- `~/.pi/agent/docket/workers/<id>/artifacts.json`
- `~/.pi/agent/docket/workers/<id>/events.ndjson`
- `~/.pi/agent/docket/workers/<id>/session/` — seeded pi session JSONL
- `~/.pi/agent/docket/workers/<id>/workspace/` — detached git worktree
