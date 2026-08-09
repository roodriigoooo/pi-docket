<p align="center">
  <img src="../assets/docket_logo.jpeg" alt="Docket logo" width="220" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@roodriigoooo/pi-docket"><img src="https://img.shields.io/npm/v/@roodriigoooo/pi-docket?color=cb3837&label=npm&logo=npm" alt="npm version" /></a>
</p>

# pi-docket full reference

> This page keeps the longer README content from earlier releases. The root README is now shorter and more product-focused.

Docket's promise: **delegate safely without losing control.**

Spawn explicit workers, watch them in the dock, peek or tell when needed, then decide from an evidence-first verdict — optionally opening Report for the full `docket_done` payload without injecting model context. Durable deliverables preserve approved work beside that loop.

It is not a transcript browser, not a memory system, and not a task manager.

> Formerly `trail`. The rename is intentional: the product is no longer framed as a history trail or session-resume system. Docket is a docket of cases needing judgment, with deliverables attached.

## Core philosophy

- **Pi owns sessions.** Use pi's `/tree`, `/fork`, `/clone`, `/compact`, `/new`, and `/resume` for conversation topology and context-window management.
- **Docket owns decisions.** It ranks artifacts into review items, shows cards, and keeps evidence out of model context until you attach it.
- **tmux is an implementation detail.** Workers remain visible pi processes in one shared session, with attach and advanced troubleshooting available as an escape hatch.
- **Workers are explicit and independent.** Every Worker comes from human `/docket spawn` or approved Use → Worker. Workers have no spawn tool; deleting one never deletes another.

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
/docket spawn --as scout map auth call sites
/docket spawn --as patcher fix failing auth test
/docket spawn --model anthropic/claude-sonnet-4-6 --thinking high audit auth
```

Save an approved worker deliverable:

```bash
/docket save --from w1
```

Save parent-authored content with the interactive source picker:

```bash
/docket save
```

Load a deliverable or worker artifacts:

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
- Worker protocol tools are `docket_wait`, `docket_done`, `docket_fail`, and `docket_todos`.
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
  spawn             watch              decide                 act
  /docket spawn ->  dock / peek /   -> verdict card      ->  r Report
                    tell                 Evidence first         d/h diff
                                         Worker says           promote
```

1. **Spawn** — explicitly start a background worker with `/docket spawn` (never automatic).
2. **Watch** — dock metadata updates; peek or tell to steer without attaching.
3. **Decide** — open the verdict; press `r` for zero-context Report when the card is too compact.
4. **Act** — promote, discard, approve, reply, or attach evidence only when you choose.

Every accepted `docket_done` freezes one immutable **Worker Deliverable Version** before review. Report, diff, Hunk, overlap checks, and promotion read that version, not live worker output. Approval is generation-bound and never injects context or starts work; patch promotion remains its own explicit verdict action. Reopen an approved card and press `u Use` to queue its full body for next parent prompt or start one fresh worker with byte-exact `source-deliverable.md` input; both paths stay human-started and transcript-free.

Deliverables (`/docket save` / `/docket load`) support durable capture beside that worker loop.

## Commands

Primary commands:

| Command | Purpose |
|---|---|
| `/docket` | Open decision docket. |
| `f8` | Open worker progress lens. |
| `/docket spawn [--model <provider/model>] [--thinking <level>] [--seed\|--fresh] [--as <kind>] [--worktree] [--] <task>` | Start explicit worker. Model/thinking inherit parent; context defaults fresh; workspace derives from kind intent. |
| `/docket broadcast [--from <notice>] <text>` | Tell the workers a change affects. Docket proposes who, from path/plan/identifier overlap; you confirm. Falls back to the bulletin when nothing is clearly affected. |
| `/docket tell w<N> [--after] [--q <id>] [text]` | Reply to worker. `--after` waits for the worker to finish its current turn instead of steering it; `--q` binds the reply to one open question and leaves the others open. Multiline text is pasted intact. |
| `/docket save [--from <artifact-ref\|w<N>>]` | Save an approved worker generation or author a deliverable interactively. |
| `/docket load [ref\|last\|w<N>]` | Mount a deliverable or worker artifacts at zero model-context cost. |

Advanced commands:

| Command | Purpose |
|---|---|
| `/docket workers [--all]` | Worker progress lens/dashboard. |
| `/docket verdict [w<N>]` | Resolve the top worker decision (accept/reject/chat). |
| `/docket attach [parent|w<N>]` | Switch to the parent/worker tmux target when already in tmux; otherwise copy attach command. |
| `/docket kinds` | List worker kinds. |
| `/docket respawn <w<N>\|all>` | Relaunch worker whose tmux window died. |
| `/docket answers [query]` | Browse assistant/worker answers. |
| `/docket log` | Audit timeline grouped by episode. |
| `/docket log decisions` | Verdict ledger plus workers evicted unreviewed. |
| `/docket search <query>` | Ranked artifact search. |
| `/docket list [--include-consumed] [--workers\|--all]` | List deliverables, legacy bundles, or workers. |
| `/docket unload <id\|w<N>\|all>` | Drop mounted deliverable/legacy-bundle/worker artifacts. |
| `/docket delete [id\|last\|w<N>]` | Delete a deliverable, legacy bundle, or one worker. Other workers remain independent. |
| `/docket ref <artifact-id>` | Attach compact artifact reference to next prompt. |
| `/docket inject-full <artifact-id>` | Attach full artifact text to next prompt. |
| `/docket copy <artifact-id>` | Copy artifact text. |
| `/docket clear` | Drop pending chips/widgets. |

No short aliases are intentionally provided. Fewer commands, clearer intent. `workers` is the fleet/operator dashboard; `answers` is only an advanced response-artifact lens, not a second worker dashboard.

Docket slash commands are Pi extension commands, so Pi executes them immediately even while an agent turn is streaming. Use them for parent-side operations like spawn, load, unload, delete, attach/switch, and dashboard inspection; natural-language prompts still follow Pi's normal steer/follow-up queue.

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

The preview is read from disk. Browsing costs zero model context; attaching still requires an explicit `a` (compact ref) or `I` (full text). Reply to a worker with `r`, save with `s`, copy with `y`, mark done with `Space`. Press `?` for the full key list.

## The verdict card

`f8` opens the worker progress lens. `Enter` opens a verdict for ready or waiting workers, and details for everything else. The advanced `/docket verdict` command opens one decision directly. It reads only status fields and the deterministic change set, never the transcript, so it costs zero model context. Resolve it from the verb menu, press `h` to review a worker patch in Hunk, or, when a blocked worker proposes options, press `1`..`9` to pick one directly:

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

When a ready worker has a change set, `h` opens Hunk with exact frozen patch from that Deliverable Version. Docket does not auto-promote or inject context after Hunk exits. Revision notes carry source ref/version and the next accepted `docket_done` publishes a new version; old body and patch remain unchanged. If Hunk comments exist, Docket asks whether to send them to the worker for revision, copy them, or ignore them. If Hunk is missing, Docket shows `npm i -g hunkdiff` and opens the built-in full diff viewer.

## Decision ledger

Every verdict you resolve (accept, reject, reject & stop, chat, or an option-send) is appended to `~/.pi/agent/docket/decisions.ndjson` with the verb, the option text, any risk the worker flagged, and the evidence refs that were on the card. Ready-state records also carry immutable Deliverable `id`, `version`, and `ref`; approval or rejection binds that exact version. `/docket log decisions` (short: `/docket decisions`) renders it:

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

## Durable deliverables

A deliverable is an immutable, versioned record. An approved Worker Deliverable is copied byte-for-byte with its exact generation-bound approval, review notes, evidence references, frozen change set, and source provenance. Parent-authored content is edited interactively, assigned an explicit outcome, and receives synthetic human-authorship approval.

`/docket save --from w<N>` saves only the currently approved exact worker generation. `/docket save --from <artifact-ref>` saves a selected Worker Deliverable exactly when it is a deliverable ref; a non-deliverable artifact opens its full content in an editor before saving it. `/docket save` opens a source picker; parent authoring remains interactive.

`/docket load` mounts one stored deliverable under a `d<N>` slot at zero model-context cost. Listing, previewing, and loading never queue a chip or start work. Open a loaded deliverable and press `u Use`: Parent queues the exact full body for the next human submission; Worker follows the existing fresh-session, human-confirmed model/thinking flow and records generalized handoff provenance.

### Plans and the Implement handoff

A plan is a deliverable that proposes work rather than carrying one: no frozen change set, and either `outcome: proposal` or a body that parses as a plan. Docket adds no plan record, store, or slot — a plan reuses deliverable immutability, versioning, generation-bound approval, review notes, and provenance unchanged.

The plan contract is a body shape, not a schema: `## Goal`, `## Constraints`, `## Steps` (numbered; each code-touching step declares `files: a.ts, b.ts`), `## Verification`, `## Risks`. Bare `Plan:` / `Goal:` label lines are accepted alongside markdown headings. A body that declares no numbered step simply does not parse, and everything downstream degrades to ordinary proposal behavior.

`u Use` on an approved plan offers **Implement** ahead of Parent and Worker:

| Destination | Kind | Execution | Plan gate |
|---|---|---|---|
| Implement | `worker.implementKind`, default `implementer` | inherits parent model/thinking | discharged at launch by the approving decision |
| Worker | chosen from the kind list | chosen model and thinking | left armed |
| Parent | — | — | — |

Implement seeds the task editor with `Implement approved plan <ref>: <goal>` and still routes through the one launch-confirmation card, which names the approval that discharged the gate. A discharged gate is recorded in `task.md`, not merely dropped: the worker executes the approved plan, publishes its steps with `docket_todos`, and must call `docket_wait` before editing an unnamed file, growing scope, changing dependencies, running anything destructive, or abandoning a step that turns out to be wrong. Only a reviewed handoff can discharge a gate; `planAuthorized` without a source deliverable is ignored.

**Plan coverage.** When a ready deliverable carries handoff provenance, Docket parses the byte-exact `source-deliverable.md` written at launch and compares the files the plan named against the change set. The verdict card's Evidence section and Report print `plan <ref> · N steps · X/Y planned files touched · … off-plan · … untouched`, colored as a warning when either drift figure is non-zero. This is derived at card-open time from data already on disk: no new storage, no decision type, and no model context.

Legacy bundles remain listable, loadable, previewable, unloadable, and deletable for compatibility. They are never converted or written by the new save path, and their artifacts remain explicitly referenceable or injectable.

This deliberately complements pi:

- use `/tree` to move conversation state,
- use `/fork` or `/clone` to split sessions,
- use `/compact` for lossy summary,
- use `/docket save` for durable deliverables,
- use `/docket load` when a deliverable becomes relevant.

## Workers

`/docket spawn <task>` starts a background pi worker as one ordinary window in a shared tmux session named `docket-workers`. The session is a worker substrate; Pi continues to own session topology.

Workers have:

- hidden workspace, often a detached git worktree,
- task file,
- `status.json`,
- `artifacts.json`,
- immutable `workers/<id>/deliverables/v<N>.json` sidecars,
- append-only `events.ndjson`,
- protocol tools for parent communication.

Worker artifacts never enter model context automatically. Parent updates from workers are metadata only (dock state, progress, readiness). Full evidence stays on disk until you open Report, load, or attach. Loading a worker mounts evidence and marks it `loaded` alongside its existing lifecycle state; a ready worker remains ready and still needs a verdict.

Each worker gets a small pre-flight brief in `task.md`: kind, workspace, decision rights, and any plan gate. A plan gate means the worker can do read-only discovery, then must call `docket_wait` with its plan before first mutation. Bundled `patcher` uses this by default.

Kinds state intent and authority only. Read-only kinds share parent directory; writable kinds get isolated workspace. Model and thinking inherit current parent state unless `--model` / `--thinking` overrides them. Exact `provider/model` must exist in Pi's available registry; invalid execution aborts. Interactive changed spend asks for confirmation, while bare same-parent spawn stays low-friction. Noninteractive mode never waits for UI. Launch details and status always show canonical model and effective thinking.

Context precedence is handoff forced-fresh / `--fresh`, then `--seed`, `worker.parentSeedPolicy`, legacy kind `parent_seed`, then fresh. `--fresh` wins if both flags appear. See [configuration](./configuration.md#per-spawn-execution) for full precedence and legacy migration.

When two workers edit the same path, Docket surfaces an `overlap w<N>: <path>` hint in the dock/dashboard and asks for confirmation before promoting a conflicting change set. It does not lock files or auto-merge workers; the parent remains the mediator.

The dock also shows passive warnings. `silent 6m` means a running worker has not emitted a tool/todo event lately. `waiting 31m` means a parent question has aged. `1 message queued · not taken yet` means you already replied and the worker has not picked it up. Docket does not auto-kill or auto-respawn for any of them. It tells you to peek, reply, reject, or stop.

### Replying to a worker

`/docket tell w<N> <text>` writes one durable Message into `workers/<id>/inbox/`. The worker's own runtime claims it, records that it took it, and hands the body to its session through pi's delivery timing — so a reply lands after the worker's current tool calls and before its next model call instead of racing whatever it was typing.

Nothing claims more than it observed. The chip reads `queued` when the message is written, and updates itself to `delivered` once the worker takes it and `read` once a worker turn actually holds it. Press ctrl+o on the chip for the full message and its delivery timeline.

```text
/docket tell w1 focus only on src/auth        # steers the current turn
/docket tell w1 --after run the full suite    # waits for the worker to finish first
/docket tell w1 --q q2 yes, update them       # answers one specific question
```

A reply bound to a question resolves that question and leaves any other open — a worker with two questions and one answer stays blocked on the second. With exactly one question open the binding is inferred. An unbound reply is a redirection: the worker resumes and re-asks anything still blocking it.

A message addressed to a worker that has died stays in its inbox and is delivered when you `/docket respawn` it. The dock shows `undeliverable` while no runtime can take it.

Workers started by a Docket build older than the mailbox still receive replies as terminal keystrokes. That path cannot confirm receipt, so it reports `sent to terminal · receipt unconfirmed` rather than borrowing the language of a delivered message.

### When a worker asks you something

`docket_wait` is the question that always reaches you. It blocks the worker, opens a verdict card, and is where anything about permission, scope, risk, or an irreversible step belongs.

`docket_consult` is for the other kind of question — which file the project settled on, what a sibling worker concluded, whether a convention was already decided. It blocks the worker the same way, but its audience is the parent session rather than you. The dock shows it as `consulting` in accent rather than `needs input` in warning, because the two states mean different things: one of them says you are the blocker and the other does not.

**It is off by default.** With `messaging.autoAnswer` unset, a consult presents exactly like an ordinary question and you answer it from the same card with the same verbs. Turning it on is you authorizing a standing policy, and it is the only setting in Docket that lets worker text reach your model context — the parent agent has to read the question to answer it.

With it on, the parent agent answers or declines, and the exchange appears in your transcript as one tool call:

```text
  ✉ w1 consulted · answered by parent agent                         ctrl+o
```

Expanding shows the question, the answer, and that no human reviewed it. The worker receives it framed `[docket · from parent agent]`, never `[docket · from you]` — a worker that mistakes a model's guess for your decision will build on it with authority the decision never had.

The agent can always decline. `docket_escalate` hands the consult back to you as a normal question, and so does the `messaging.consultWindowSeconds` window expiring. Either way the card tells you it was escalated and why, so a question that reached you late does not read like one that was always yours. Every auto-answer is written to `decisions.ndjson` with `actor: "parent-agent"`, so `/docket log decisions` never conflates it with something you decided.

### When a worker shares something

`docket_note` lets a worker tell you something without stopping: an interface changed, a task assumption was wrong, a constraint turned up. It never blocks the worker and never enters your model context — the notice becomes a review item you can open, chip, or ignore, and the dock adds one word to its summary line (`2 shared`) rather than a row.

A worker may name the workers it thinks should hear a notice. That is a suggestion recorded alongside it; nothing is sent anywhere without you. Workers cannot address each other directly, and the parent remains the only router.

### Telling several workers at once

```text
/docket broadcast auth middleware now takes a context arg
```

Docket does not ask who should receive it. It scores every running worker against evidence it already holds — paths the message names, paths each worker has touched, files an approved plan declared, identifiers, task-word overlap — and opens one card:

```text
  📣 broadcast

     auth middleware now takes a context arg

  affected
   ▸ ▪ w1   patcher      fix the failing auth test        touches src/auth/middleware.ts
     ▪ w4   implementer  add rate limiting                plan names src/auth/middleware.ts

  maybe
     · w3   scout        map session call sites           mentions authcontext

     +2 unrelated                                    tab to show

  ⏎ send to selected · space toggle · a all · b bulletin · esc keep local
```

Enter sends to what Docket proposed. Every row carries the worker's task, never its index alone. Nothing leaves the card without a keypress.

A broadcast **does not interrupt**. It enters each worker's context without triggering a turn, so a worker mid-edit keeps working and a worker blocked on a question stays blocked on it — a broadcast is information, never direction, and it never answers something a worker is waiting on. Several pending broadcasts arrive as one block.

From a notice in the docket, Enter opens the same card with the notice as the message. Workers the notice addressed are preselected and tagged `addressed by w2` — the worker expresses intent, you keep the decision.

Claims from a worker carry their standing automatically, because "code is ready" means different things depending on where the code is:

```text
w2 · deliverable:… (v2) approved · promoted     safe to build on
w2 · in worktree, not promoted                  a constraint, not code you can call
w2 · notice, unreviewed                         nobody has checked it
```

### The project journal

When nothing scores as affected, Docket does not hand you a grid of checkboxes and call that a choice — it offers the journal instead:

```text
  no clear recipients · post to bulletin instead?
  every worker reads it at its next gate           ⏎ post · esc discard
```

The journal holds two things: standing decisions and constraints, and the changes that have actually landed. Workers are told to read it before their first edit and whenever a plan gate opens, and a newer entry supersedes an older one it contradicts. It lives at `~/.pi/agent/docket/bulletins/<project>.md` rather than in the repo, so workers in isolated worktrees all read the same current file instead of a snapshot taken when they started. `b` posts there from the broadcast card at any time.

The markdown is generated from `bulletins/<project>.ndjson` in full on every append. Editing it changes nothing.

### A promotion tells the workers it invalidates

Promoting a worker's change set appends a `promoted` entry naming the files that landed. Nothing else is required of you — a promotion is the one worker output that already carries your approval, so forwarding it needs neither a confirmation nor any model tokens.

Any worker that read, edited, or has an approved plan naming one of those files now shows a dock sub-line:

```text
  ● w3·scout  map every session store call site           2m · f8 verdict
      base moved · 1 file it works on landed since it started
```

It is muted, not amber: nobody is blocked, and nothing was interrupted. The worker keeps working and finds out at the next gate it was already going to stop at — where the journal tells it plainly that its isolated workspace still holds the version from *before* the change landed, and that it should say so in its outcome rather than rebuilding on a stale copy.

If the worker had already finished, the fact follows its deliverable onto the verdict card instead, in warning colour, because that is the moment it bears on:

```text
  ○  w3 · map every session store call site    ready · not running · 4m
     v1 · d7
     produced before src/auth/middleware.ts landed · re-check before promoting
```

Staleness only ever comes from the evidence a broadcast is scored against — a named path, a touched path, an approved plan's files. Task-text overlap is enough to *propose* a recipient to you; it is not enough to tell a worker its ground has shifted.

### Settled workers fold away

Each surface answers one question. The dock answers **is anything waiting on me** — so it carries only rows something is still owed on. `f8` answers **what is the whole fleet doing**, `/docket` answers **what needs a decision**, and `/docket verdict` resolves them one at a time.

A worker is **settled** when its decision is behind it: you accepted or dismissed it on the verdict card (`reviewedAt` is stamped, the state derives as `reviewed`), or its process ended without ever making a claim (`stopped`). Settled rows leave the dock and are replaced by a single line standing for all of them:

```text
    4 settled · f8
```

Press `f8` and they are one keypress away — the dashboard shows `+4 settled · tab to show`, and `tab` opens the band as its own group beneath every row that still needs something. Nothing is hidden by time here; `worker.dockIdleHideMinutes` still governs when an ended worker leaves `f8` too, and `worker.pruneAfterHours` when its directory is pruned.

One message the worker never took un-settles its row and brings it back to the dock: there you already acted and nothing has happened yet, which is exactly what the dock exists to show. A recorded verdict also outranks the row's warnings — a settled row reads `reviewed` rather than an overlap warning, and never carries `base moved`, because neither can change a decision already made. If the worker produces another generation the staleness returns on the verdict card, which is where it acts.

Dock rows are laid out in fixed columns — worker, state, task, detail, age, chip — so separators line up down the screen instead of landing wherever the previous cell ended. Under width pressure the detail column gives ground first, then the state word and the chip; the task text and the worker's kind give ground last, because those are what identify the row.

Reviewed state clears automatically on new activity: telling the worker, respawning it, or any new protocol transition (`docket_wait`/`docket_done`/`docket_fail`) re-surfaces it. Replying to a `needs_input` question, retrying a failed worker, or sending a chat-back-for-revision does not mark a worker reviewed — only terminal verdicts (`accept`/`reject` on ready, `reject` on failed) do.

### Colored diffs in review

The verdict card colors `+N` green and `-M` red in both the change-set stat line and the per-file lines, so additions and deletions read at a glance. Press `d` on a change-set verdict to open the full diff in a colored viewer: added lines green, removed lines red, `@@` hunk headers accent, `diff --git`/`index`/`---`/`+++` metadata muted, context dim. The viewer uses pi's editor diff palette (`toolDiffAdded`/`toolDiffRemoved`/`toolDiffContext`), so a Docket diff looks like an in-editor diff.

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

- `default`: general worker, edits allowed when task asks.
- `scout`: fast read-only recon.
- `patcher`: plan-gated edits in a worker worktree, then proposes a change set.
- `architect`: read-only planning; publishes an approvable plan as `docket_done outcome: proposal`.
- `implementer`: executes an approved plan received through Use → Implement.

Examples:

```bash
/docket spawn --as scout find route handlers that touch auth cookies
/docket spawn --as patcher rename AccountService in src only
/docket spawn --as architect plan rate limiting for the public API
```

Custom kinds live in:

- `~/.pi/agent/docket/worker-kinds/*.md`
- `<project>/.pi/docket/worker-kinds/*.md`

See [docs/configuration.md](./configuration.md#worker-kinds).

### Worker protocol

Workers use tools, not shell commands:

| Tool | Purpose |
|---|---|
| `docket_todos` | Publish small progress board. Informational; `docket_done` is completion. |
| `docket_wait` | Ask parent for input and pause. |
| `docket_done` | Mark useful output ready for review. |
| `docket_fail` | Mark cannot continue with no useful partial output. |

Worker-side `/docket wait`, `/docket done`, and `/docket fail` are fallback prompt commands only. Worker creation remains human-only.

For plan-gated work, the worker uses `docket_wait` as the gate. The verdict card shows the plan options and recommendation, then your choice is sent back as plain parent input.

## tmux

Docket uses tmux as the worker process and visibility layer, not as the decision log. Every worker is a normal pi process running in one window inside one shared session:

```bash
tmux attach -t docket-workers
```

`/docket attach` is deliberate terminal control. If Pi is already running inside tmux, Docket runs `tmux switch-client -t docket-workers` (or `docket-workers:w2`) so you move directly to the worker session. From a worker, `/docket attach parent` switches back to the parent tmux target recorded at spawn. Outside tmux, it copies the equivalent `tmux attach` command. Attaching is for direct inspection or emergency debugging; normal coordination should go through `/docket tell`, `/docket verdict`, and the worker protocol tools.

### How Docket uses tmux

- **Spawn**: the first worker creates `docket-workers` with `new-session -d -s`; later workers use `new-window -d`. Windows are named `w<N>`, and Docket records tmux's stable `#{window_id}` (`@7`, `@8`, etc.) so renamed windows still resolve.
- **Reply**: tmux is no longer the reply path. `/docket tell` writes a Message to the worker's inbox and the worker's own runtime delivers it (see [Replying to a worker](#replying-to-a-worker)). Keystrokes are kept only for workers whose runtime predates the mailbox: one-line sends use `send-keys -l` plus `Enter`, multiline sends use `load-buffer -` and `paste-buffer -p -d`, and shared-session payloads start with `[docket]` so worker input stays recognizable.
- **Peek**: `/docket workers` uses `capture-pane -p` to render a bounded selected-worker pane snapshot inside the dashboard. It does not attach, focus the pane, or add anything to model context.
- **Post-mortem capture**: worker windows run with `remain-on-exit on`. If the worker process exits, Docket probes the recorded worker pane, captures its bounded tail, writes `pane-tail.txt`, then kills the stale window. A companion may add panes, but it cannot redirect Docket's tell, peek, or harvest target.
- **Adapter seam**: a companion may register one `globalThis.__docket.registerTmuxAdapter(adapter)` callback. Docket invokes it after spawn or respawn IDs are persisted with the worker/window/pane metadata; adapter failures are warned and isolated from the worker lifecycle.
- **Messaging seam**: `globalThis.__docket.onMessage(handler)` observes messages moving between the parent and its workers — metadata only, no bodies. `globalThis.__docket.registerBroadcastAdvisor(advisor)` lets a companion propose a broadcast recipient Docket's own evidence missed; a suggestion can only reach `maybe`, never the preselected `affected` band, and cannot demote, remove, or invent a recipient. Advisors get 250 ms and are dropped on throw, hang, or malformed output. Sending, attribution, the permission line, and the human confirmation are not extension points. See [architecture.md](./architecture.md#extension-surface).
- **Legacy layouts**: old `layout` declarations are recognized only to emit a migration diagnostic and are ignored. Core Docket does not create split panes, pipe terminal output, or write tmux status content.

Silence warnings do not poll `capture-pane`. Docket reads the worker's `events.ndjson`; if nothing useful appears for a few minutes, the dock shows `silent Nm`. Use peek when you want scrollback. Use attach when you need full terminal control.

Rule of thumb: tmux handles live processes, scrollback, and direct visibility. Docket stores status, artifacts, verdicts, and decision debt on disk. Workers should not run write-side tmux commands themselves because the parent owns the shared session lifecycle.

### Peek without attaching

Most of the time you don't need full terminal control. In the workers dashboard (`/docket workers`), press `p` on a worker row to see the last lines of its live tmux pane rendered inside the dashboard. It refreshes about once a second, is strictly read-only, and costs zero model context. Use peek for "is it grinding or stuck on a prompt?" Use attach/switch only when you need to type in that terminal. Press `p` again or `Esc` to close.

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
