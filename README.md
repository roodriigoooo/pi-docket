<p align="center">
  <img src="./assets/docket_logo.jpeg" alt="Docket logo" width="220" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@roodriigoooo/pi-docket"><img src="https://img.shields.io/npm/v/@roodriigoooo/pi-docket?color=cb3837&label=npm&logo=npm" alt="npm version" /></a>
</p>

# pi-docket

Docket is a decision queue for work done inside pi.

It pulls the few moments that need human judgment out of long agent work: worker findings, proposed patches, failed commands, saved evidence bundles, and questions. It is not a transcript browser, not a memory system, and not a task manager. Docket keeps evidence available and asks: **what needs a decision now?**

> Formerly `trail`. The rename is intentional: the product is no longer framed as a history trail or session-resume system. Docket is a docket of cases needing judgment, with evidence bundles attached.

## Core philosophy

- **Pi owns sessions.** Use pi's `/tree`, `/fork`, `/clone`, `/compact`, `/new`, and `/resume` for conversation topology and context-window management.
- **Docket owns decisions.** It ranks artifacts into review items, shows cards, and keeps evidence out of model context until you attach it.
- **tmux owns parallel visibility.** Workers are visible pi processes in one shared tmux session. You can attach and inspect them directly.
- **Workers are explicit.** Docket may eventually suggest a worker only when context-heavy work is obvious and maps to a known worker kind. It must never silently spawn.

## Install

```bash
pi install git:github.com/roodriigoooo/pi-docket
```

Open Docket:

```bash
/docket
```

Spawn a worker explicitly:

```bash
/docket spawn --as scout map callers of getUser()
```

Save evidence as a zero-token bundle:

```bash
/docket save auth investigation findings
```

Load a bundle or worker artifacts:

```bash
/docket load last
/docket load w1
```

## Rename from Trail

This release is a breaking rename.

- Package: `@roodriigoooo/pi-docket`
- GitHub repo title: `pi-docket`
- Slash command: `/docket`
- Old `/trail` commands are not kept as aliases.
- Worker protocol tools are now `docket_wait`, `docket_done`, `docket_fail`, `docket_todos`, and `docket_spawn_child`.
- Storage/config paths now use `docket`:
  - `~/.pi/agent/docket/`
  - `~/.pi/agent/docket.json`
  - `<project>/.pi/docket.json`
  - `<project>/.pi/docket/worker-kinds/*.md`

If you need old data, copy it manually before deleting the old package:

```bash
cp -R ~/.pi/agent/trail ~/.pi/agent/docket
cp ~/.pi/agent/trail.json ~/.pi/agent/docket.json 2>/dev/null || true
cp -R .pi/trail .pi/docket 2>/dev/null || true
cp .pi/trail.json .pi/docket.json 2>/dev/null || true
```

## Basic loop

```text
  work / spawn       capture             decide                act
  current pi    ->   artifacts       ->  /docket cards   ->   Enter review
  /docket spawn      status.json         evidence             c reply/save
                                      bundles/workers         a attach ref
```

1. **Work or spawn** — keep working in the parent session, or explicitly start a background worker with `/docket spawn`.
2. **Capture** — Docket records failed commands, file changes, worker results, saved bundles, and questions.
3. **Decide** — `/docket` opens only items that likely need attention.
4. **Act** — review, reply, promote, dismiss, attach evidence, save/load bundles, or attach to tmux.

## Commands

Primary commands:

| Command | Purpose |
|---|---|
| `/docket` | Open decision docket. |
| `/docket spawn [--fresh] [--as <kind>] <task>` | Start explicit background worker. |
| `/docket tell w<N> [text]` | Reply to worker. |
| `/docket attach [w<N>]` | Copy tmux attach command for shared worker session. |
| `/docket save [flags] [note]` | Save selected evidence as bundle and label current pi tree leaf. |
| `/docket load [id\|last\|w<N>]` | Mount bundle or worker artifacts at zero model-context cost. |

Advanced commands:

| Command | Purpose |
|---|---|
| `/docket workers [--all]` | Worker dashboard. |
| `/docket verdict [w<N>]` | Resolve highest-attention worker decision. |
| `/docket kinds` | List worker kinds. |
| `/docket respawn <w<N>\|all>` | Relaunch worker whose tmux window died. |
| `/docket answers [query]` | Browse assistant/worker answers. |
| `/docket log` | Audit timeline grouped by episode. |
| `/docket search <query>` | Ranked artifact search. |
| `/docket list [--include-consumed] [--workers\|--all]` | List saved bundles or workers. |
| `/docket unload <id\|w<N>\|all>` | Drop mounted bundle/worker artifacts. |
| `/docket delete [id\|last\|w<N>]` | Delete bundle or worker. Worker delete cascades to children. |
| `/docket ref <artifact-id>` | Attach compact artifact reference to next prompt. |
| `/docket inject-full <artifact-id>` | Attach full artifact text to next prompt. |
| `/docket copy <artifact-id>` | Copy artifact text. |
| `/docket clear` | Drop pending chips/widgets. |

No short aliases are intentionally provided. Fewer commands, clearer intent.

## Evidence bundles

A Docket bundle is a frozen artifact sidecar plus a small orientation markdown file. It is not a model-written summary by default.

`/docket save`:

- selects relevant artifacts,
- lets you prune/edit the bundle header,
- writes `<id>.md` + `<id>.artifacts.json`,
- labels the current pi session tree leaf as `docket:<id>`.

`/docket load` mounts bundle artifacts into the current session's Docket navigator at zero model-context cost. Nothing enters the model prompt until you explicitly attach a compact ref or full artifact.

This deliberately complements pi:

- use `/tree` to move conversation state,
- use `/fork` or `/clone` to split sessions,
- use `/compact` for lossy summary,
- use `/docket save` for durable evidence,
- use `/docket load` when that evidence becomes relevant.

## Workers

`/docket spawn <task>` starts a background pi worker as one window in a shared tmux session named `docket-workers`.

Workers have:

- hidden workspace, often a detached git worktree,
- task file,
- `status.json`,
- `artifacts.json`,
- append-only `events.ndjson`,
- protocol tools for parent communication.

Worker artifacts never enter model context automatically except for the short ready summary, if enabled. Full evidence stays on disk until loaded or attached.

### Worker kinds

Bundled kinds:

- `default` — general worker, edits allowed when task asks.
- `scout` — fast read-only recon.
- `patcher` — edits in worker worktree and proposes a change set.

Examples:

```bash
/docket spawn --as scout find route handlers that touch auth cookies
/docket spawn --as patcher rename AccountService in src only
```

Custom kinds live in:

- `~/.pi/agent/docket/worker-kinds/*.md`
- `<project>/.pi/docket/worker-kinds/*.md`

See [docs/configuration.md](./docs/configuration.md#worker-kinds).

### Worker protocol

Workers use tools, not shell commands:

| Tool | Purpose |
|---|---|
| `docket_todos` | Publish small progress board. |
| `docket_wait` | Ask parent for input and pause. |
| `docket_done` | Mark useful output ready for review. |
| `docket_fail` | Mark cannot continue with no useful partial output. |
| `docket_spawn_child` | Dispatch allowed child worker kind. |

Worker-side `/docket wait`, `/docket done`, and `/docket fail` are fallback prompt commands only.

## tmux

All workers live in one shared tmux session:

```bash
tmux attach -t docket-workers
```

`/docket attach` copies the attach command. `/docket attach w2` selects that worker's window.

This is intentional: tmux gives direct observability and real parallelism, while Docket controls artifact capture and parent/worker coordination.

## Development

Run from repo:

```bash
pi --no-extensions -e ./extensions/docket.ts
```

Smoke test:

```bash
npm run smoke:help
```

Type check:

```bash
npm run check
```

Tests:

```bash
npm test
```

Dry-run package:

```bash
npm run pack:dry
```
