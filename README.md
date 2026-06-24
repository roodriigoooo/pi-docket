<p align="center">
  <a href="https://www.npmjs.com/package/@roodriigoooo/pi-docket"><img src="https://img.shields.io/npm/v/@roodriigoooo/pi-docket?color=cb3837&label=npm&logo=npm" alt="npm version" /></a>
</p>

# pi-docket

> Review Pi agent work, run visible tmux workers, and save evidence outside model context.

Docket is a review inbox for work done inside Pi.

When a Pi agent run gets long, important things hide in scrollback: failed commands, file edits, worker questions, proposed patches, notes, and results. Docket pulls those moments into review cards.

Open `/docket`, decide what matters, and attach evidence only when you want the model to see it.

## What Docket helps with

- **Review:** see only work that needs attention, not every line of history.
- **Workers:** start background Pi workers for research or patches.
- **Evidence:** save useful artifacts on disk and load them later without spending model context.
- **Decisions:** accept, reject, redirect, promote, or dismiss worker output from cards.

Docket keeps three things separate:

- Pi keeps the conversation and session tree.
- tmux keeps live worker terminals visible.
- Docket keeps review cards, evidence, and decisions organized.

## Watch it

Compressed terminal recordings from the demo project.

### Capture test failure evidence

![Capture test failure evidence demo](.github/media/docket-capture-evidence.gif)

Shows:

- Ask Pi to run tests and explain failures.
- Docket turns the failed command and model answer into review cards.
- Save useful bits as a bundle, then open the inbox.

### Run a patcher worker and steer it

![Run a patcher worker and steer it demo](.github/media/docket-worker-verdict.gif)

Shows:

- Spawn a patcher for failing session tests.
- Watch live worker status, then peek without attaching.
- Pick a verdict when the worker asks how far to go.
- Promote the patch only after you like the plan.

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
work -> capture evidence or spawn worker -> open /docket -> decide -> act
```

1. Work in Pi, or start a worker with `/docket spawn`.
2. Docket records useful artifacts: errors, edits, answers, worker status, and bundles.
3. `/docket` shows review cards for items that need judgment.
4. You accept, reject, reply, attach evidence, save a bundle, or mark done.

The model does not see full evidence until you attach it with `/docket ref` or `/docket inject-full`.

## Quick start

Start a background worker:

```text
/docket spawn --as scout find the auth middleware and list risky paths
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

Workers are explicit. Docket does not silently spawn them.

Useful examples:

```text
/docket spawn --as scout map every caller of getUser()
/docket spawn --as patcher fix the failing auth test, but ask before edits
/docket tell w1 focus only on src/auth and tests/auth
```

Bundled worker kinds:

- `default`: general background work.
- `scout`: read-only investigation.
- `patcher`: plan-gated edits in an isolated worker workspace.

A plan gate lets a worker inspect first, then requires it to ask before its first edit or mutating command.

## Evidence bundles

`/docket save` writes a small markdown note plus an artifact sidecar. It preserves evidence. It does not move your Pi session.

`/docket load` mounts a bundle or worker artifacts into the current Docket view. Mounting costs zero model-context tokens. Loading a ready worker also marks it `loaded` in the dock, so it stops presenting as unresolved review work without pretending you accepted it.

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
