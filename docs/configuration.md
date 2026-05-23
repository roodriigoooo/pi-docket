# Configuration

Trail reads two files and merges them, project overriding global:

1. `~/.pi/agent/trail.json` — global
2. `<project>/.pi/trail.json` — project

Both optional. Defaults below.

## Realistic example

```json
{
  "maxArtifacts": 300,
  "maxBodyChars": 6000,
  "checkpointArtifacts": 24,
  "consumedRetentionDays": 7,

  "summarizer": {
    "enabled": true,
    "provider": "openai",
    "model": "gpt-5.2",
    "maxOutputTokens": 1200,
    "maxInputChars": 36000,
    "timeoutMs": 120000
  },

  "worker": {
    "maxActive": 8,
    "maxSpawnDepth": 2,
    "defaultKind": "default",
    "dockIdleHideMinutes": 30,
    "pruneAfterHours": 24,
    "tmuxStatusLine": false,
    "captureTerminal": false,
    "guardrailsPath": "~/.pi/agent/trail/my-worker-rules.md"
  }
}
```

## Core artifact + checkpoint knobs

| key | default | meaning |
|---|---|---|
| `maxArtifacts` | 300 | hard cap on artifacts kept per session. older entries fall off. |
| `maxBodyChars` | 6000 | truncate any single artifact body to this many chars before storing. |
| `checkpointArtifacts` | 24 | initial artifact pool a checkpoint mode considers before user prune. |
| `consumedRetentionDays` | 7 | how long `--once` checkpoints stay on disk after first use. |

## Summarizer

| key | default | meaning |
|---|---|---|
| `summarizer.enabled` | true | when false, `/trail checkpoint` always uses raw markdown. |
| `summarizer.provider` | — | provider id (`openai`, `anthropic`, …). inferred from `model` when omitted. |
| `summarizer.model` | active session model | provider/model string used for summarization. |
| `summarizer.maxOutputTokens` | 1200 | cap summary length. |
| `summarizer.maxInputChars` | 36000 | cap input fed into summarizer. |
| `summarizer.timeoutMs` | 120000 | abort summarization after this many ms; fall back to raw. |

`/trail checkpoint --model <provider/model>` and `--max-output <tokens>` override per call.

## Worker fleet

| key | default | meaning |
|---|---|---|
| `worker.maxActive` | 8 | reject `/trail spawn` once this many workers are starting/active/idle/needs_input. |
| `worker.maxSpawnDepth` | 2 | bound `trail_spawn_child` recursion (top-level worker = depth 0). |
| `worker.defaultKind` | `default` | kind used when `/trail spawn` is invoked without `--as`. |
| `worker.dockIdleHideMinutes` | 30 | hide `ended` workers from the dock after this many minutes; 0 keeps them. |
| `worker.pruneAfterHours` | 24 | auto-prune `ended` worker dirs after this many hours; 0 disables. |
| `worker.tmuxStatusLine` | false | write a compact summary to `trail-workers`' `status-right`. |
| `worker.captureTerminal` | false | enable `tmux pipe-pane` to `<worker-dir>/pane.log` per worker. |
| `worker.autoRespawn` | false | reserved; today `/trail respawn` is manual. |
| `worker.guardrailsPath` | bundled | absolute or cwd-relative path to a guardrail file appended to every worker prompt. |

`worker.guardrailsPath` replaces `extensions/worker-guardrails.md` from this package. Use it to pin team-wide policies into every worker.

## Worker kinds

A *kind* is a markdown file with YAML frontmatter. Drop into either:

- `~/.pi/agent/trail/worker-kinds/*.md` — user-global
- `<project>/.pi/trail/worker-kinds/*.md` — project-scoped

Bundled kinds (`default`, `scout`, `patcher`) live in `extensions/worker-kinds/` and reload on every command.

### Frontmatter fields

| field | default | meaning |
|---|---|---|
| `name` | — | required; kebab-case slug used by `--as` |
| `description` | — | one-line shown in `/trail kinds` |
| `model` | parent | optional model override (`provider/model` string) |
| `thinking` | `medium` | `off` / `low` / `medium` / `high` |
| `read_only` | false | when true, appendix tells the worker not to edit files |
| `default_worktree` | true | spawn this kind in a detached worktree by default |
| `parent_seed` | `full` | `full` to seed parent session JSONL; `none` for a fresh worker |
| `max_artifacts` | — | soft cap surfaced as guidance; not enforced |
| `max_duration_sec` | — | soft cap surfaced as guidance |
| `can_spawn` | none | comma-list of kinds this worker may dispatch via `trail_spawn_child` |
| `layout` | `single` | `split-events` opens a right pane with `tail -F events.ndjson` |
| `guardrails_append` | — | extra guardrail lines folded into the kind appendix |

The MD body is appended to the universal guardrails — it never replaces them. The protocol contract (`trail_wait`/`trail_done`/`trail_fail`/`trail_todos`) is the same for every kind.

### Example: a `reviewer` kind

`~/.pi/agent/trail/worker-kinds/reviewer.md`:

```markdown
---
name: reviewer
description: Read-only diff review against HEAD.
read_only: true
default_worktree: false
parent_seed: full
max_duration_sec: 180
thinking: high
---

You are a code reviewer. Read the diff vs HEAD, then call `trail_done` with:
- `outcome: findings` (or `no_evidence` when the diff is clean)
- `summary`: one sentence on what changed and overall risk
- `evidence`: file:line refs for each concrete finding
- `recommended`: ordered action bullets for the parent
```

Spawn it:

```bash
/trail spawn --as reviewer audit the diff for missing error handling
```

### Example: a model + child spawn override

`<project>/.pi/trail/worker-kinds/architect.md`:

```markdown
---
name: architect
description: Plans a multi-file change. Can dispatch scout children for context.
model: anthropic/claude-opus-4-7
thinking: high
read_only: true
default_worktree: false
can_spawn: scout
layout: split-events
---

You are an architect. Produce an ordered plan: what to change, in which order,
and which files each step touches. Use `trail_spawn_child` with `--as scout`
when you need to ground a step in real code instead of guessing.
```

### Runtime registration

Other pi extensions can contribute kinds at runtime:

```ts
globalThis.__trail?.registerWorkerKind({
  name: "linkcheck",
  description: "Verify external links in markdown",
  readOnly: true,
  defaultWorktree: false,
  body: "You verify HTTP links in *.md and report broken ones …",
});
```

See [architecture.md](./architecture.md) for the full extension surface.

## Storage paths

Checkpoint state:

- `~/.pi/agent/trail/checkpoints/<id>.md`
- `~/.pi/agent/trail/checkpoints/<id>.artifacts.json`
- `~/.pi/agent/trail/events.ndjson`
- `~/.pi/agent/trail/index.json` (compatibility snapshot)

Worker state:

- `~/.pi/agent/trail/workers/<id>/task.md`
- `~/.pi/agent/trail/workers/<id>/status.json`
- `~/.pi/agent/trail/workers/<id>/artifacts.json`
- `~/.pi/agent/trail/workers/<id>/events.ndjson`
- `~/.pi/agent/trail/workers/<id>/session/` — seeded pi session JSONL
- `~/.pi/agent/trail/workers/<id>/workspace/` — detached git worktree
