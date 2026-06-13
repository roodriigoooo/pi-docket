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
  /docket spawn      status.json         evidence             r reply · b save
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
| `/docket verdict [w<N>]` | Resolve the top worker decision (accept/reject/chat). |
| `/docket spawn [--fresh] [--as <kind>] <task>` | Start explicit background worker. |
| `/docket tell w<N> [text]` | Reply to worker. Multiline text is pasted intact. |
| `/docket attach [w<N>]` | Copy tmux attach command for shared worker session. |
| `/docket save [flags] [note]` | Save selected evidence as bundle and label current pi tree leaf. |
| `/docket load [id\|last\|w<N>]` | Mount bundle or worker artifacts at zero model-context cost. |

Advanced commands:

| Command | Purpose |
|---|---|
| `/docket workers [--all]` | Worker dashboard. |
| `/docket kinds` | List worker kinds. |
| `/docket respawn <w<N>\|all>` | Relaunch worker whose tmux window died. |
| `/docket answers [query]` | Browse assistant/worker answers. |
| `/docket log` | Audit timeline grouped by episode. |
| `/docket log decisions` | Verdict ledger plus workers evicted unreviewed. |
| `/docket search <query>` | Ranked artifact search. |
| `/docket list [--include-consumed] [--workers\|--all]` | List saved bundles or workers. |
| `/docket unload <id\|w<N>\|all>` | Drop mounted bundle/worker artifacts. |
| `/docket delete [id\|last\|w<N>]` | Delete bundle or worker. Worker delete cascades to children. |
| `/docket ref <artifact-id>` | Attach compact artifact reference to next prompt. |
| `/docket inject-full <artifact-id>` | Attach full artifact text to next prompt. |
| `/docket copy <artifact-id>` | Copy artifact text. |
| `/docket clear` | Drop pending chips/widgets. |

No short aliases are intentionally provided. Fewer commands, clearer intent.

## The review surface

`/docket` opens the inbox as an overlay. On a wide terminal (roughly 120 columns and up) it splits into two panes: the list of review items on the left, and the selected item's card plus an evidence preview on the right. Move with `j`/`k` and the preview follows. On narrower terminals the card renders below the list, same as before.

```text
 Failed / blocked · 2                      │ TypeError: boom in auth.ts [error]
▸  TypeError: boom in auth.ts  [error]     │ [Enter Inspect] [a Attach] [y Copy]
   Command failed: npm test   [error]      │ current session · 2m ago · @e1
                                           │ ····································
                                           │ at verifyToken (src/auth.ts:42)
                                           │ at middleware (src/app.ts:10)
```

The preview is read from disk. Browsing costs zero model context; attaching still requires an explicit `a` (compact ref) or `I` (full text). Reply to a worker with `r`, save a bundle with `b`, copy with `y`, mark done with `Space`. Press `?` for the full key list.

## The verdict card

`/docket verdict` (or `Enter` on a worker row) opens one decision at a time. It reads only status fields and the deterministic change set, never the transcript, so it costs zero model context. Resolve it from the verb menu, or, when a blocked worker proposes options, press `1`..`9` to pick one directly:

```text
 docket · verdict                                        Esc close
 ● w3 · run migration suite   needs input · 1m ago
   ⚠ irreversible: drops the sessions table

 ▸ 1 Use the migration-safe path        · recommended
   2 Proceed as proposed
   Steer          something else · stays alive

   Reject & stop  kill worker + remove workspace
   Chat           type a reply
 1-2 pick · ↑↓ move · Enter select · Esc close
```

`Reject & stop` is set apart with a blank line and warning color because it kills the worker and removes its workspace, and it always asks for confirmation. Number keys only reach the offered options, never the destructive verb.

## Decision ledger

Every verdict you resolve (accept, reject, reject & stop, chat, or an option-send) is appended to `~/.pi/agent/docket/decisions.ndjson` with the verb, the option text, any risk the worker flagged, and the evidence refs that were on the card. `/docket log decisions` (short: `/docket decisions`) renders it:

```text
Decisions · last 7 days
  6 resolved · 2 evicted unreviewed
  accept 3 · reject 2 · reject & stop 1
  decision debt: 2 workers evicted unreviewed this week

Recent (8 of 8):
  3m ago   w3  option "Use the migration-safe path"  (needs_input)  ⚠ irreversible: drops the sessions table
  1h ago   w1  accept  (ready)  [worker-changeset:auth-bug-a3b1:0]
  2h ago   w2  evicted unreviewed (ended) · refactor token cache
```

The last line is decision debt: a worker reached a terminal state and was pruned with no verdict ever recorded, so it aged out before anyone looked. Counting it keeps automation bias visible rather than silent.

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

### When a worker dies

If the worker process exits, Docket keeps the dead tmux pane around just long enough to capture its final terminal output, then cleans the window up. The capture is saved as `pane-tail.txt` in the worker directory, appears in review as a `terminal tail` artifact, and the failed verdict card prints the last few lines. A crashing worker tells you why it crashed, not just its exit code:

```text
w3 failed · run migration suite
  worker process exited before reporting ready (exit 1)

  terminal tail
  Error: missing DATABASE_URL
      at loadConfig (src/db.ts:14)
  Pane is dead (status 1, Fri Jun 13 00:15:59 2026)
```

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

### Peek without attaching

Most of the time you don't need a full attach. In the workers dashboard (`/docket workers`), press `p` on a worker row to see the last lines of its live tmux pane rendered inside the dashboard. It refreshes about once a second, is strictly read-only, and costs zero model context. Useful for the quick "is it grinding or stuck on a prompt" check. Press `p` again or `Esc` to close.

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
