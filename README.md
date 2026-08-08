<p align="center">
  <a href="https://www.npmjs.com/package/@roodriigoooo/pi-docket"><img src="https://img.shields.io/npm/v/@roodriigoooo/pi-docket?color=cb3837&label=npm&logo=npm" alt="npm version" /></a>
</p>

# pi-docket

> Delegate safely without losing control.

Docket lets you spawn visible background workers, watch them calmly, and decide from evidence — without smuggling worker claims into your parent session.

Durable deliverables matter, but they are supporting infrastructure. The first-use story is workers: spawn → watch / peek / tell → verdict → Report / diff / Hunk → decide.

## What Docket helps with

- **Workers:** start an explicit scout or patcher, peek without attaching, then resolve a verdict card.
- **Control:** automatic worker → parent flow is metadata only. Content enters model context only when you attach it.
- **Deliverables:** save approved worker output or explicitly author selected content as an immutable record.
- **Decisions:** promote, discard, reply, or acknowledge from cards — you keep the final say.

Docket keeps three things separate:

- Pi keeps the conversation and session tree.
- tmux keeps live worker terminals visible.
- Docket keeps review cards, evidence, and decisions organized.

## Watch it

Compressed terminal recordings from the demo project. These predate several releases, so some
wording and card layout has moved on — the flow they show is still how Docket works.

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
- Save an immutable deliverable, then open the inbox.

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
4. Press `r` for Report if you need full immutable deliverable body, then `d`/`h` for frozen diff/Hunk, then promote, approve, or reject.
5. Approval records judgment for exact deliverable version. It does not inject context or start work. Reopen an approved result and press `u Use`: queue its full body for next parent prompt, or start one fresh reviewed-input worker.

Deliverables (`/docket save` / `/docket load`) sit beside that loop when you want durable, reusable output outside a worker.

## Quick start

Start with the simple, safe default:

```text
/docket spawn investigate auth flake
```

The built-in default uses an isolated worktree and asks before the first mutation. Choose a read-only scout for reconnaissance:

```text
/docket spawn --as scout map auth call sites
```

Choose plan-gated patcher when you want scoped edits in isolated workspace:

```text
/docket spawn --as patcher fix failing auth test
```

Workers start fresh by default, without parent-session context. Add `--seed` only when worker needs current conversation:

```text
/docket spawn --seed --as patcher fix the failing auth test, but ask before edits
```

Model and thinking inherit current parent. Override spend explicitly when needed:

```text
/docket spawn --model anthropic/claude-sonnet-4-6 --thinking high audit auth
```

Interactive changed spend asks for confirmation. Bare same-parent spawn stays low-friction; noninteractive mode never waits for UI.

Open worker progress:

```text
f8
```

Reply to a worker:

```text
/docket tell w1 focus only on src/auth and tests/auth
```

The reply is queued into the worker's own inbox and delivered by the worker between its tool calls, so it never lands mid-keystroke. The chip says `queued`, then updates itself to `delivered` and `read` as the worker actually takes it — Docket does not report a delivery it has not observed. Answering one specific question leaves the worker's other questions open:

```text
/docket tell w1 --q q2 yes, update the tests
```

Save an approved worker deliverable:

```text
/docket save --from w1
```

Save selected parent content:

```text
/docket save
```

Load it later:

```text
/docket load last
```

## tmux, as an implementation detail

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

Docket stores status, artifacts, verdicts, and deliverables on disk. tmux is only the live worker-terminal substrate and scrollback store.

Core worker operations target the pane Docket recorded at launch. A companion may register an operator-owned window adapter and add panes, but it cannot redirect tell, peek, or post-mortem harvesting. Advanced tmux layouts are intentionally outside Docket’s core seam.

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

Workers are explicit, human-started, and independent. Docket does not silently spawn them; workers have no spawn tool, and deleting one never deletes another.

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
- `architect`: read-only planning; publishes an approvable implementation plan.
- `implementer`: executes an approved plan handed to it.

A plan gate lets a worker inspect first, then requires it to ask before its first edit or mutating command.
Configured `worker.defaultKind` values are deliberate power-user overrides: Docket preserves the selected kind's declared rights instead of adding an implicit policy on top.

Ready review loop: accepted `docket_done` freezes a Worker Deliverable version → verdict card (Evidence → Worker says → Actions) → `r` Report if needed → `d`/`h` for exact frozen diff/Hunk → promote, approve, or reject. Approval never injects context. After approval, `u Use` either queues one full immutable body for next parent prompt or starts one fresh worker with `source-deliverable.md` input and recorded provenance. Attach is a secondary debug escape hatch, not the normal path.

## Plan, then implement

> A note on why this exists: often, a pattern I use with workers is to send a read-only one out first, make it come back with a plan, argue with it for a round or two, and only then let anything touch the repo. It works, but the seam between those two steps was me — reading the plan in one card, then hand-writing a task for a second worker and hoping I had not paraphrased away the part that mattered. Therefore: the architect kind, and an `Implement` action on an approved plan that carries the exact bytes I approved into the worker that does the work. The approval *is* the handoff. Everything about reviewing the result stayed the same.

A plan is not a separate kind of object: it is a deliverable that proposes work instead of carrying it. That means it gets everything a deliverable already has — one immutable frozen body, versions, approval bound to one exact version, revision notes, provenance, and zero-token mounting.

```text
/docket spawn --as architect  add rate limiting to the public API
# worker publishes the plan with docket_done outcome: proposal
/docket verdict            # read it, approve it, or request a revision
u  →  Implement            # start the implementation worker from that exact plan
```

`Implement` appears on an approved plan only. It picks the `implementer` kind, seeds the task from the plan's goal, inherits the parent's model and thinking, and writes the plan byte-exact to the worker's `source-deliverable.md`. One confirmation card shows the resolved launch before anything starts. `Worker` remains the explicit path where you choose kind, model, and thinking by hand; `Parent` still just queues the body for your next prompt.

**The plan gate is discharged, not skipped.** You already approved this exact plan version, so the implementation worker executes it instead of stopping to propose it again. The gate stays armed for everything the plan does not cover: files it never names, destructive commands, dependency changes, scope growth, or a step that turns out to be wrong. Its `task.md` says which approval discharged it and which decision recorded that.

A plan the architect writes in the shape below is machine-checkable at review time — steps become the implementer's progress board, and the verdict card compares the files the plan named against the diff that came back:

```text
## Goal        one sentence
## Steps       1. numbered — files: path/one.ts, path/two.ts
## Verification  exact commands
## Risks       what could invalidate this
```

Off-plan or untouched files show as a warning-colored `plan … 3/4 planned files touched · 1 off-plan` line on the verdict card and in Report. A plan that does not follow the shape still works everywhere — it just reviews as an ordinary proposal.

Writing the plan yourself in the parent works the same way: `/docket save --from <artifact-id>`, choose **Proposal**, then `u → Implement`. Docket does not restrict the parent's own tools while you plan; that is Pi's job, and a plan-mode extension composes with this cleanly.

## Durable deliverables

`/docket save --from w<N>` copies an approved exact Worker Deliverable—including its body, frozen patch, approval, review notes, refs, and provenance—to an immutable durable record. Re-saving the same worker generation is idempotent.

`/docket save` with no source opens a picker. Selecting a non-deliverable artifact opens its full content in an editor; the returned bytes and a human-selected Proposal, Findings, or Completed outcome become a parent-authored deliverable. Parent-authored records are immediately eligible for Use.

`/docket load` mounts a deliverable under a `d<N>` slot, or reads an older legacy bundle/worker source. Mounting costs zero model-context tokens and never queues a chip. Use → Parent queues only the exact full body for the next human submission; Use → Worker starts a fresh, confirmed worker with the exact sidecar input.

New records live under `~/.pi/agent/docket/deliverables/<safe-id>/v<N>.json`. Older checkpoint/bundle files remain readable for compatibility, but Docket never creates or converts them.

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
| `/docket tell w<N> <text>` | Reply to a worker. Delivery state is observed, not assumed; multiline replies stay multiline. |
| `/docket save [--from <artifact-ref\|w<N>>]` | Save an approved worker or author a deliverable interactively. |
| `/docket load [ref\|last\|w<N>]` | Mount a deliverable, legacy bundle, or worker artifacts. |

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

deliverables/<safe-id>/v<N>.json  # immutable durable records
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
- [Manual visual demo](./docs/manual-demo.md)
- [Changelog](./CHANGELOG.md)
