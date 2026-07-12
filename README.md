<p align="center">
  <a href="https://www.npmjs.com/package/@roodriigoooo/pi-docket"><img src="https://img.shields.io/npm/v/@roodriigoooo/pi-docket?color=cb3837&label=npm&logo=npm" alt="npm version" /></a>
</p>

# pi-docket

> Delegate safely without losing control.

Docket lets you spawn visible background workers, watch them calmly, and decide from evidence — without smuggling worker claims into your parent session.

Evidence bundles matter, but they are supporting infrastructure. The first-use story is workers: spawn → watch / peek / tell → verdict → Report / diff / Hunk → decide.

## What Docket helps with

- **Workers:** start an explicit scout or patcher, peek without attaching, then resolve a verdict card.
- **Control:** automatic worker → parent flow is metadata only. Content enters model context only when you attach it.
- **Evidence:** save useful artifacts on disk and load them later without spending model context.
- **Decisions:** promote, discard, reply, or acknowledge from cards — you keep the final say.

Docket keeps three things separate:

- Pi keeps the conversation and session tree.
- tmux keeps live worker terminals visible.
- Docket keeps review cards, evidence, and decisions organized.

## Watch it

Compressed terminal recordings from the demo project.

### Run a patcher worker and steer it

![Run a patcher worker and steer it demo](.github/media/docket-worker-verdict.gif)

Shows:

- Spawn a patcher for failing session tests.
- Watch live worker status, then peek without attaching.
- Pick a verdict when the worker asks how far to go.
- Promote the patch only after you like the plan.

### Capture test failure evidence

![Capture test failure evidence demo](.github/media/docket-capture-evidence.gif)

Shows:

- Ask Pi to run tests and explain failures.
- Docket turns the failed command and model answer into review cards.
- Save useful bits as a bundle, then open the inbox.

## What it is not

Docket is not a memory layer, transcript browser, todo app, or session manager.

Pi already has (and pi-docket integrates well with) `/tree`, `/fork`, `/clone`, `/compact`, `/new`, and `/resume`. Use those for session shape. Docket plugs into that flow by keeping evidence and unresolved decisions stable while you branch, compact, resume, or move work between sessions.

## Install

```bash
pi install git:github.com/roodriigoooo/pi-docket
```

Open Docket:

```text
/docket
```

Dependencies:

- `tmux` is required for background workers.
- `hunk` is optional for `h` worker-diff review. Docket falls back to its built-in diff viewer.
- Clipboard actions use `pbcopy`, `wl-copy`, or `xclip` when available.

## Basic loop

```text
spawn worker -> watch / peek / tell -> verdict -> Report / diff / Hunk -> decide
```

1. Start a worker with `/docket spawn` (always user-initiated — Docket never silently spawns).
2. Watch the dock; peek or tell if you need to steer.
3. When the worker is ready, open the verdict card.
4. Press `r` for Report if you need the full evidence view, then `d`/`h` for diff/Hunk, then promote or discard.

Evidence bundles (`/docket save` / `/docket load`) sit beside that loop when you want durable capture outside a worker.

## Quick start

Start with the simple, safe default:

```text
/docket spawn investigate auth flake
```

The built-in default uses an isolated worktree and asks before the first mutation. Choose a read-only scout for reconnaissance:

```text
/docket spawn --as scout map auth call sites
```

Choose the plan-gated patcher when you want scoped edits and child-scout rights:

```text
/docket spawn --as patcher fix failing auth test
```

Workers start fresh by default, without parent-session context. Add `--seed` only when the worker needs the current conversation:

```text
/docket spawn --seed --as patcher fix the failing auth test, but ask before edits
```

Open worker progress:

```text
f8
```

Reply to a worker:

```text
/docket tell w1 focus only on src/auth and tests/auth
```

Save useful evidence:

```text
/docket save auth middleware notes
```

Load it later:

```text
/docket load last
```

## tmux, in plain terms

Docket uses tmux so background workers stay visible and controllable.

A worker is a normal Pi process running in a tmux window. Docket puts all worker windows in one shared tmux session:

```bash
tmux attach -t docket-workers
```

You do not need to know tmux to use Docket. Most of the time:

- Press `f8` to see worker status.
- Press `p` on a worker row to peek at its live terminal.
- Use `/docket tell w<N> ...` to reply.
- Use `/docket attach w<N>` only when you need full terminal control.

Why tmux:

- **Real terminals:** workers are visible Pi sessions, not hidden daemons.
- **Safe inspection:** you can attach when a worker looks stuck or strange.
- **Crash evidence:** if a worker dies, Docket captures the final pane output before cleanup.

Docket stores status, artifacts, verdicts, and bundles on disk. tmux owns only the live worker terminals and scrollback.

If you run `/docket attach [w<N>]` from inside tmux, Docket switches you to the worker session with `tmux switch-client`. From a worker, `/docket attach parent` switches back to the parent tmux target recorded at spawn. Outside tmux, Docket copies the normal `tmux attach` command.

### Peek without attaching

Press `f8` or run `/docket workers`, then press `p` on a worker row. Docket shows a bounded, read-only tmux pane snapshot inside the dashboard.

Peek is for quick checks:

- Is the worker still running tests?
- Is it waiting on a prompt?
- Did it crash before reporting status?

Peek does not focus the pane and costs zero model context.

Attach only when you need full terminal control:

```text
/docket attach w2
```

### Review worker diffs

When a ready worker has a patch, the verdict card offers `h Hunk review`.

Docket opens the exact worker patch in `hunk patch`. If you leave Hunk comments, Docket can send them back to the worker for revision. If Hunk is not installed, Docket shows an install hint and opens its built-in full diff viewer.

## Workers

Workers are explicit and user-initiated. Docket does not silently spawn them, and it does not suggest spawn forms or wizards.

Focused examples:

```text
/docket spawn --as scout map auth call sites
/docket spawn --as patcher fix failing auth test
/docket tell w1 focus only on src/auth and tests/auth
```

When there are no workers yet, empty states stay tiny:

```text
docket · no workers yet · /docket spawn <task>
```

Bundled worker kinds:

- `default`: plan-gated general work in a fresh isolated workspace.
- `scout`: read-only investigation.
- `patcher`: plan-gated edits in an isolated worker workspace.

A plan gate lets a worker inspect first, then requires it to ask before its first edit or mutating command.
Configured `worker.defaultKind` values are deliberate power-user overrides: Docket preserves the selected kind's declared rights instead of adding an implicit policy on top.

Ready review loop: verdict card (Evidence → Worker says → Actions) → `r` Report if needed → `d`/`h` for diff/Hunk → promote or discard. Attach is a secondary debug escape hatch, not the normal path.

## Evidence bundles

`/docket save` writes a small markdown note plus an artifact sidecar. It preserves evidence. It does not move your Pi session.

`/docket load` mounts a bundle or worker artifacts into the current Docket view. Mounting costs zero model-context tokens. Loading a worker makes its evidence available and adds a `loaded` marker; it does not resolve the worker's decision debt. Only a verdict clears unresolved review attention.

Only these commands send evidence to the model:

```text
/docket ref <artifact-id>          # compact reference
/docket inject-full <artifact-id>  # full text
```

Main rule: keep evidence available, not automatically injected.

## Commands you will use most

| Command | Use |
|---|---|
| `/docket` | Open review inbox. |
| `/docket spawn <task>` | Start a background worker. Fresh session by default; `--seed` inherits parent context. |
| `f8` | Open worker progress lens. |
| `/docket tell w<N> <text>` | Reply to a worker. Multiline replies stay multiline. |
| `/docket save [note]` | Save selected evidence as a bundle. |
| `/docket load [id\|last\|w<N>]` | Mount bundle or worker artifacts. |

For full command reference, see [docs/full-reference.md](./docs/full-reference.md).

## Philosophy

Docket follows a few rules:

- Human decides.
- Background work stays visible.
- Workers are useful but not trusted by default.
- Evidence stays cheap to browse and explicit to inject.
- Parallel work should not become parallel confusion.
- Failed work should leave evidence, not disappear.

## Data location

Default local data lives here:

```text
~/.pi/agent/docket/
```

Project config can live here:

```text
.pi/docket.json
.pi/docket/worker-kinds/*.md
```

Coming from old Trail builds? Docket is a breaking rename. Old `/trail` aliases are gone. Migration notes live in [docs/full-reference.md](./docs/full-reference.md#rename-from-trail).

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

## More docs

- [Full reference](./docs/full-reference.md)
- [Configuration](./docs/configuration.md)
- [Architecture](./docs/architecture.md)
- [Changelog](./CHANGELOG.md)
