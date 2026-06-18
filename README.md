<p align="center">
  <a href="https://www.npmjs.com/package/@roodriigoooo/pi-docket"><img src="https://img.shields.io/npm/v/@roodriigoooo/pi-docket?color=cb3837&label=npm&logo=npm" alt="npm version" /></a>
</p>

# pi-docket

Docket is a small decision inbox for pi.

When agent work gets long, useful things get scattered: failed commands, worker results, proposed patches, questions, notes, and files touched. Docket pulls those moments into review cards.

Open `/docket`, decide what matters, and attach evidence only when you want the model to see it.

## Watch it

Compressed terminal recordings from the demo project.

### Capture test failure evidence

![Capture test failure evidence demo](.github/media/docket-capture-evidence.gif)

Shows:

- Ask pi to run tests and explain failures.
- Docket turns the failed command and model answer into review cards.
- Save the useful bits as a bundle, then open the inbox.

### Run a patcher worker and steer it

![Run a patcher worker and steer it demo](.github/media/docket-worker-verdict.gif)

Shows:

- Spawn a patcher for failing session tests.
- Watch live worker status, then peek without attaching.
- Pick a verdict when the worker asks how far to go.
- Promote the patch only after you like the plan.

## What it does

- Shows review cards for things that need attention.
- Starts background pi workers when you ask for them.
- Keeps worker output, errors, and evidence on disk.
- Lets you peek at running workers without attaching.
- Saves evidence bundles you can load later at zero model-context cost.
- Logs verdicts, so accepted, rejected, and skipped worker work stays visible.

## What it is not

Docket is not a memory layer, transcript browser, todo app, or session manager.

pi already has `/tree`, `/fork`, `/clone`, `/compact`, `/new`, and `/resume`. Use those for session shape. Docket plugs into that flow by keeping the review queue and evidence stable while you branch, compact, resume, or move work between sessions.

Docket handles attention, evidence, workers, and decisions.

## Install

```bash
pi install git:github.com/roodriigoooo/pi-docket
```

Open it:

```text
/docket
```

Start a background worker:

```text
/docket spawn --as scout find the auth middleware and list risky paths
```

Review worker result:

```text
/docket verdict
```

Save useful evidence:

```text
/docket save auth middleware notes
```

Load it later:

```text
/docket load last
```

## Basic loop

```text
work or spawn -> capture evidence -> open /docket -> decide -> act
```

1. Work in pi, or spawn a worker with `/docket spawn`.
2. Docket records useful artifacts: errors, changes, worker status, answers, and bundles.
3. `/docket` shows only review items, not every line of history.
4. You accept, reject, reply, attach evidence, save a bundle, or mark done.

The model does not see full evidence until you attach it with `/docket ref` or `/docket inject-full`.

## tmux, simply

Docket uses tmux for worker processes.

Each worker is a normal pi process in one window inside one shared tmux session:

```bash
tmux attach -t docket-workers
```

You do not need to know tmux to use Docket. Most of the time, use `/docket workers`, `/docket verdict`, and `/docket tell`.

tmux gives Docket three useful things:

- **Real terminals.** Workers are visible processes, not hidden daemons.
- **Safe inspection.** You can attach when something looks weird.
- **Crash evidence.** If a worker dies, Docket captures the final pane output before cleanup.

Docket stores status, artifacts, verdicts, and bundles on disk. tmux owns live worker terminals and scrollback.

If you run `/docket attach [w<N>]` from inside tmux, Docket deliberately uses `tmux switch-client -t docket-workers[:wN]` so you move straight to the worker session. Outside tmux, it copies the normal `tmux attach` command.

### Peek without attaching

Run:

```text
/docket workers
```

Press `p` on a worker row. Docket shows a bounded live tmux pane snapshot inside the dashboard. It is read-only, does not focus the pane, and costs zero model context.

Use peek to answer quick questions:

- Is the worker still running tests?
- Is it waiting on a prompt?
- Did it crash before reporting status?

Use attach only when you need full terminal control:

```text
/docket attach w2
```

## Workers

Workers are explicit. Docket should not silently spawn them.

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

A plan gate means the worker can inspect first, then must ask before its first edit or mutating command.

## Evidence bundles

`/docket save` writes a small markdown note plus an artifact sidecar. It preserves evidence. It does not move your Pi session.

`/docket load` mounts a bundle or worker artifacts into the current Docket view. Mounting costs zero model-context tokens. Loading a ready worker also marks it `loaded` in the dock, so it stops presenting as unresolved review work without pretending you accepted it.

Only these commands send evidence to the model:

```text
/docket ref <artifact-id>          # compact reference
/docket inject-full <artifact-id>  # full text
```

This is the main rule: keep evidence available, not automatically injected.

## Commands you will use most

| Command | Use |
|---|---|
| `/docket` | Open review inbox. |
| `/docket spawn <task>` | Start a background worker. |
| `/docket workers` | See worker dashboard. |
| `/docket verdict [w<N>]` | Resolve a worker decision. |
| `/docket tell w<N> <text>` | Reply to a worker. Multiline replies stay multiline. |
| `/docket attach [w<N>]` | Switch to worker tmux session when already in tmux; otherwise copy attach command. |
| `/docket save [note]` | Save selected evidence as a bundle. |
| `/docket load [id|last|w<N>]` | Mount bundle or worker artifacts. |
| `/docket log decisions` | Show verdict history and unreviewed worker debt. |

For the full command reference, see [docs/full-reference.md](./docs/full-reference.md).

## Philosophy

Docket is built around a few rules:

- Human stays in charge of decisions.
- Background work must be visible.
- Workers are useful, but they are not trusted by default.
- Evidence should be cheap to browse and explicit to inject.
- Parallel work should not become parallel confusion; overlapping worker edits must be visible.
- Failed work should leave evidence, not disappear.

In short: pi keeps the conversation. tmux keeps the workers visible. Docket keeps the decisions organized.

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
