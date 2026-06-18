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
  "bundleArtifacts": 24,
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
    "guardrailsPath": "~/.pi/agent/docket/my-worker-rules.md"
  }
}
```

## Core artifact + bundle knobs

| key | default | meaning |
|---|---|---|
| `maxArtifacts` | 300 | hard cap on artifacts kept per session. older entries fall off. |
| `maxBodyChars` | 6000 | truncate any single artifact body to this many chars before storing. |
| `bundleArtifacts` | 24 | initial artifact pool a saved bundle considers before user prune. `checkpointArtifacts` is accepted as a deprecated alias. |
| `consumedRetentionDays` | 7 | how long `--once` bundles stay on disk after first use. |

## Summarizer (opt-in)

Evidence bundles are bundle-first: by default `/docket save` writes a deterministic orientation header and never calls a model ([ADR-0001](./adr/0001-bundle-first-checkpoints.md)). The summarizer only runs when you pass `--summarize`; these keys tune it when you do.

| key | default | meaning |
|---|---|---|
| `summarizer.enabled` | true | when false, `--summarize` is ignored and the bundle header is always used. |
| `summarizer.provider` | — | provider id (`openai`, `anthropic`, …). inferred from `model` when omitted. |
| `summarizer.model` | active session model | provider/model string used for summarization. |
| `summarizer.maxOutputTokens` | 1200 | cap summary length. |
| `summarizer.maxInputChars` | 36000 | cap input fed into summarizer. |
| `summarizer.timeoutMs` | 120000 | abort summarization after this many ms; fall back to the bundle header. |

`/docket save --model <provider/model>` and `--max-output <tokens>` override per call.

## Worker fleet

| key | default | meaning |
|---|---|---|
| `worker.maxActive` | 8 | reject `/docket spawn` once this many workers are starting/active/idle/needs_input. |
| `worker.maxSpawnDepth` | 2 | bound `docket_spawn_child` recursion (top-level worker = depth 0). |
| `worker.defaultKind` | `default` | kind used when `/docket spawn` is invoked without `--as`. |
| `worker.dockIdleHideMinutes` | 30 | hide `ended` workers from the dock after this many minutes; 0 keeps them. |
| `worker.pruneAfterHours` | 24 | auto-prune `ended` worker dirs after this many hours; 0 disables. |
| `worker.tmuxStatusLine` | false | write a compact summary to `docket-workers`' `status-right`. |
| `worker.captureTerminal` | false | enable `tmux pipe-pane` to `<worker-dir>/pane.log` per worker. |
| `worker.autoRespawn` | false | reserved; today `/docket respawn` is manual. |
| `worker.autoEmbedSummary` | false | when true, append a short summary (outcome + 1-line summary + up to 5 recommended bullets) to the parent session as a worker reaches `ready`. Default false keeps the parent JSONL fully manual — the inbox card still surfaces the ready worker; nothing is auto-injected. |
| `worker.parentSeedPolicy` | `none` | default parent-seed policy for `/docket spawn` when neither `--seed`/`--fresh` nor the kind sets one. `"none"` (default) spawns fresh workers with no parent context; `"full"` seeds the worker with the parent session JSONL (reuses prompt cache prefix but inherits full parent context). Use as a project-wide escape hatch when most workers need parent context. |
| `worker.guardrailsPath` | bundled | absolute or cwd-relative path to a guardrail file appended to every worker prompt. |

`worker.guardrailsPath` replaces `extensions/worker-guardrails.md` from this package. Use it to pin team-wide policies into every worker.

## Worker kinds

A *kind* is a markdown file with YAML frontmatter. Drop into either:

- `~/.pi/agent/docket/worker-kinds/*.md` — user-global
- `<project>/.pi/docket/worker-kinds/*.md` — project-scoped

Bundled kinds (`default`, `scout`, `patcher`) live in `extensions/worker-kinds/` and reload on every command.

### Frontmatter fields

| field | default | meaning |
|---|---|---|
| `name` | — | required; kebab-case slug used by `--as` |
| `description` | — | one-line shown in `/docket kinds` |
| `model` | parent | optional model override (`provider/model` string) |
| `thinking` | `medium` | `off` / `low` / `medium` / `high` |
| `read_only` | false | when true, appendix tells the worker not to edit files |
| `default_worktree` | true | spawn this kind in a detached worktree by default |
| `parent_seed` | `none` | `none` for a fresh worker; `full` to seed the worker session with the parent's JSONL (reuses prompt cache prefix but inherits full parent context — use only when the worker needs it). Per-spawn `--seed`/`--fresh` flags override. |
| `max_artifacts` | — | soft cap surfaced as guidance; not enforced |
| `max_duration_sec` | — | soft cap surfaced as guidance |
| `can_spawn` | none | comma-list of kinds this worker may dispatch via `docket_spawn_child` |
| `layout` | `single` | `split-events` opens a right pane with `tail -F events.ndjson` |
| `plan_gate` | false | when true, worker must ask for parent approval before first edit or mutating command |
| `decision_rights` | none | list of task authority lines shown in `task.md` and guardrails |
| `guardrails_append` | — | extra guardrail lines folded into the kind appendix |

The MD body is appended to the universal guardrails; it never replaces them. The protocol contract (`docket_wait`/`docket_done`/`docket_fail`/`docket_todos`) is the same for every kind.

`plan_gate` is intentionally small. The worker may do read-only discovery first, then uses `docket_wait` to show the plan, options, recommendation, and risk before it edits or runs a mutating command.

For a writable kind:

```yaml
plan_gate: true
decision_rights:
  - May edit docs after approval
  - May run local tests
```

### Example: a `reviewer` kind

`~/.pi/agent/docket/worker-kinds/reviewer.md`:

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

You are a code reviewer. Read the diff vs HEAD, then call `docket_done` with:
- `outcome: findings` (or `no_evidence` when the diff is clean)
- `summary`: one sentence on what changed and overall risk
- `evidence`: file:line refs for each concrete finding
- `recommended`: ordered action bullets for the parent
```

Spawn it:

```bash
/docket spawn --as reviewer audit the diff for missing error handling
```

### Example: a model + child spawn override

`<project>/.pi/docket/worker-kinds/architect.md`:

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
and which files each step touches. Use `docket_spawn_child` with `--as scout`
when you need to ground a step in real code instead of guessing.
```

### Runtime registration

Other pi extensions can contribute kinds at runtime:

```ts
globalThis.__docket?.registerWorkerKind({
  name: "linkcheck",
  description: "Verify external links in markdown",
  readOnly: true,
  defaultWorktree: false,
  body: "You verify HTTP links in *.md and report broken ones …",
});
```

See [architecture.md](./architecture.md) for the full extension surface.

## Storage paths

Bundle state:

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
