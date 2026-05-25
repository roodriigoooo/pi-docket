<p align="center">
  <img src="./assets/trail_logo.jpeg" alt="Trail logo" width="220" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@roodriigoooo/trail"><img src="https://img.shields.io/npm/v/@roodriigoooo/trail?color=cb3837&label=npm&logo=npm" alt="npm version" /></a>
</p>

# trail for pi

trail is a small review queue for work done inside pi.

my goal with it is pretty simple: when i am working with agents, i do not want to keep scrolling through a long transcript to find the few things that actually matter. a worker may finish with useful recommendations, a command may fail in a way i should not lose, or a patch may be waiting for review. trail tries to pull those moments out and show them as cards.

it is not meant to be a transcript browser, a memory system, or a full task manager. it is more like an inbox for agent work: what happened, what needs me, and what can i do with it.

## the basic loop

```text
  spawn / ask          capture            review                 act
  /trail spawn   ->  artifacts +     ->  /trail (inbox)   ->   Enter   continue
  /trail            status.json        decision cards       c       reply
                                                            Space   dismiss
                                                            a       attach
                                                            /trail checkpoint
                                                                    delegate
```

roughly:

1. **spawn or ask** — use `/trail spawn <task>` to run a background pi worker in tmux, or keep working in the current session.
2. **capture** — trail snapshots file edits, failed commands, worker results, checkpoints, and other useful events.
3. **review** — `/trail` opens an inbox with only the things that seem to need attention.
4. **act** — open, continue, attach, dismiss, or checkpoint.

there are more commands, but this is the part i care about most. everything else is support for this loop.

## why i made it

some situations kept repeating:

- a worker finished with three good recommendations and i had to dig through a transcript to find them.
- a command failed, then got buried under a bunch of successful commands.
- i wanted to restart with a cleaner session without losing what i had already learned.
- i had multiple workers running and could not tell which one was waiting on me.
- i wanted to hand off a debugging session to future me, including the dead ends.

claude code's `/compact` was one reference point, but trail is almost the opposite shape. instead of compressing everything into a summary, it keeps the useful artifacts around and asks: which of these need a decision?

## install

```bash
pi install git:github.com/roodriigoooo/trail
```

open the inbox:

```bash
/trail
```

spawn a worker:

```bash
/trail spawn inspect the auth middleware token expiry edge case
```

when the worker finishes, open `/trail` again. review the card. continue, attach, or mark it done.

## what shows up in the inbox

trail is intentionally picky. not every event becomes a card.

cards usually come from one of these situations:

- **needs decision** — a worker called `trail_wait` and is paused for your reply.
- **ready for review** — a worker called `trail_done`, or an assistant answer is worth reviewing.
- **patch proposed** — a worker edited files and you have not reviewed them yet.
- **failed / blocked** — a worker called `trail_fail`, an error was captured, or a command failed.
- **checkpoint available** — a checkpoint was created and can be continued from.

things that are just evidence stay in the log. things that probably need a decision go to the inbox.

## what does not show up

this part matters because otherwise the inbox becomes another transcript.

these stay out by design:

- normal assistant file edits in the current session. they are in `/trail log` instead.
- successful commands.
- worker chatter, file reads, greps, and intermediate steps.
- prompts you typed yourself.
- anything you already marked done with `Space`.

## decision cards

an inbox row expands into a card:

```text
▸ Worker w1 finished — README improvements review        [ready]

  • short workflow-oriented table of contents
  • fewer commands in README
  • GIFs for core flows

  [Enter Review answer]  [c Continue]  [a Attach]  [y Copy]  [Space Done]
  worker w1 · 31s ago · @status
```

card pieces:

- headline: plain english version of what happened.
- status chip: `ready`, `needs reply`, `failed`, `changed`, etc.
- bullets: usually parsed from the worker's `Recommended:` block.
- actions: only the keys that make sense for that card.
- footer: provenance and artifact id.

## workers

`/trail spawn <task>` starts a pi worker. the worker lands in a tmux window inside a single shared session called `trail-workers`, with a hidden workspace, a task file, an append-only event log, and a small status protocol.

### worker kinds

every worker has a *kind*. trail ships three:

- **`default`** — general-purpose, universal guardrails, edits allowed.
- **`scout`** — fast read-only recon. no worktree, small artifact cap, short time budget.
- **`patcher`** — edits in a worker worktree and proposes a change set. can dispatch a child `scout` via `trail_spawn_child`.

pick a kind with `--as`:

```bash
/trail spawn --as scout grep for callers of getUser()
/trail spawn --as patcher rename UserService → AccountService across src/
```

`/trail kinds` lists what's registered. drop your own markdown files into `~/.pi/agent/trail/worker-kinds/*.md` or `<project>/.pi/trail/worker-kinds/*.md` — the body is appended to the universal guardrails, the frontmatter tunes posture (read-only, worktree, model, seed, can_spawn, layout, …). full field list and a worked `reviewer` example in [docs/configuration.md#worker-kinds](./docs/configuration.md#worker-kinds).

bundled kinds live in [`extensions/worker-kinds/`](./extensions/worker-kinds/) — use them as a template. other pi extensions can contribute kinds at runtime via `globalThis.__trail.registerWorkerKind(...)` (see [docs/architecture.md](./docs/architecture.md#extension-surface)).

### child workers

a worker whose kind has `can_spawn` set sees a `trail_spawn_child` tool. the child:

- lands as a sibling window in `trail-workers`
- records `parentWorkerId` + `depth` in its status
- returns its `trail_done` to the parent *worker*, not to the human user

depth and fleet are both capped (`worker.maxSpawnDepth` default 2; `worker.maxActive` default 8). `/trail delete w<N>` cascades to children.



every worker is a window in the same session, not its own session. that one decision shapes a lot of what follows. one tmux server hosts the whole fleet, so spawning a fifth worker doesn't spin up a fifth server. one `tmux attach -t trail-workers` puts you in front of all of them; you switch panes to switch workers. and one `set-hook pane-died` notification covers every worker we care about.

while workers are running, trail shows a compact dock above your prompt:

```text
trail · feat/foo ±2 · 1 waiting · 2 ready
●  w1  ready          improve readme         3 recs · 1 file changed · 4/4 todos
●  w2  needs reply    audit migration order  needs reply
●  w3  failed         apply migration        error
```

each row is one window in `trail-workers`. idle rows fade. only rows that need a decision get colour and a `← reply / inspect / review` chip on the right. if every worker shares the parent's model, the model badge stays hidden; if any worker is on a different model, the badge appears next to its short label.

`/trail workers` opens the worker dashboard. `/trail w<N>` shows one worker:

```text
trail · w1 · ready  Reviewed README for command accuracy
  Task: Improve main README
  Progress: 4/4 todos complete
  Changes: none

  Outcome
    Suggested README improvements focused on command accuracy, onboarding,
    and navigation.

  Recommendations
    1. Sync README commands with current behavior
    2. Add a short quickstart near the top
    3. Add a compact workflow-oriented table of contents

  Useful references
    @w1.r24/answer  ToC recommendation
    @w1.c25/code    Markdown code block
```

worker artifacts do not enter model context automatically. they stay on disk until you attach or inject them.

### attaching

`/trail attach` copies `tmux attach -t trail-workers` to your clipboard. `/trail attach w2` copies the same thing with a trailing `select-window -t w2` so you land directly on that worker's pane. once attached, you see what each worker is actually doing in real time. detach with `prefix-d`, like any tmux session.

### talking to a worker

`/trail tell w<N> [text]` sends a reply. under the hood it's `tmux send-keys -t trail-workers:w<N> -l '[trail] <text>'` followed by a separate `Enter`. the `-l` is literal mode: tmux skips key-table interpretation, so quotes and special characters in your message can't accidentally trigger shortcuts. the `[trail]` prefix is a one-line tell that the input came from the parent — if you happen to be attached to the worker's pane while trail injects a message, you can see which keystrokes are yours and which are not.

### event stream

each worker appends one JSON line per significant event (state change, todo update, tool call) to `workers/<id>/events.ndjson`. it's append-only, one event per line, rotated at 5 MB. the parent watches the workers root with `fs.watch` and tails each worker's event log from where it last stopped reading. this is why the dock feels live without polling, and why ten idle workers don't cost you a tenth of a CPU.

the unix part of this is intentional. a flat NDJSON file survives a parent restart, can be grep'd or tailed from another terminal, and doesn't need a daemon to receive messages. `fs.watch` is just inotify (or its kqueue/FSEvents cousin). `tmux` is a small C program that already speaks PTYs. session JSONLs are just append-only logs of conversations. nothing in trail's worker plumbing is a network service or a JSON-RPC layer; it is the boring composition of small tools that have been good at their jobs since before any of this was about LLMs.

### prompt cache seeding

by default, `/trail spawn` copies your current pi session's JSONL into the worker's session dir before the worker starts. the worker resumes from that prefix instead of starting blank, so the assistant has your earlier discoveries already in context. the big wins are two: the provider's prompt cache hits on the shared prefix (much cheaper first call), and the worker doesn't have to re-walk the codebase the parent just walked.

pass `--fresh` if you want a worker that knows nothing about the parent session:

```bash
/trail spawn --fresh do an independent review of src/auth.ts
```

### worker protocol

workers run with guardrails appended to their system prompt. the contract lives in [`extensions/worker-guardrails.md`](./extensions/worker-guardrails.md).

short version:

| tool | when to call |
|---|---|
| `trail_todos` | multi-step work. replaces the visible todo board. |
| `trail_wait` | ambiguity, blocked auth, irreversible action, or contradiction. |
| `trail_done` | finished with useful output. includes `outcome`, `evidence`, and recommendations. vague/no-evidence work is rejected back to `trail_wait`. |
| `trail_fail` | cannot continue and no useful partial output remains. |

workers run in hidden workspaces seeded from your current repo state. if a worker edits files, trail surfaces one change-set card with summary, diffstat, and actions: promote, diff, revise, or dismiss. promoting applies the whole change set after a clean preflight; trail does not merge anything silently.

if a worker calls `/trail wait ...` through bash by mistake, trail tries to catch it and record the intent. the tool protocol is still the real path.

### what a finished worker tells the parent

when a worker hits `ready`, trail appends a short summary message to the parent pi session — outcome line, one-sentence summary, and up to five recommended bullets. the full artifacts (file dumps, code blocks, evidence excerpts) stay on disk; `/trail load w<N>` mounts them when you want the detail.

two things follow from that:

- **the parent assistant sees it on the next turn.** ask "what did w1 find?" and the answer is already in context. no manual `/trail inject`.
- **any worker spawned afterwards inherits it via session seeding.** w3 spawned after w1 and w2 finished will see their summaries in its seeded prefix, so sibling findings cross-pollinate without a dedicated sharing channel.

this preserves the "decision queue" philosophy: only the short conclusion auto-embeds, the bulk of the artifacts stay behind the inbox card so the parent context doesn't bloat from many workers. opt out with `worker.autoEmbedSummary: false` in `.pi/trail.json` if you want the pure ledger behavior.

## checkpoints

a checkpoint is a frozen **bundle** of session artifacts plus a small **orientation header**. it is the bundle first — not a summary. useful when the session is noisy, context is getting full, or you want to restart clean without losing what you learned.

```bash
/trail checkpoint finish the checkpoint store refactor
/trail continue last
```

when you `continue`, the fresh session **mounts** the bundle at zero token cost and sees only the orientation header (git state, files touched, errors, your note). the artifacts stay on disk until you chip one with `/trail ref`. this is trail keeping artifacts around instead of compressing them into context — the same philosophy as the inbox.

because nothing is auto-summarized, the **note** carries the judgement: write the decisions and next steps you'd want future-you to have. the editor opens on the pre-filled header so you can fill in `## Decisions` and `## Next steps` before saving.

flags:

- `--once` — soft-consume after first `/trail continue` or `/trail load`.
- `--summarize` — add a model-written prose summary on top of the bundle header (opt-in; off by default).
- `--model <provider/model>` — summarize with a specific model (implies `--summarize`).
- `--max-output <tokens>` — cap summary length (implies `--summarize`).

checkpoints are plain markdown with a sidecar `artifacts.json`. you can edit the markdown before continuing. checkpoints saved by older versions still read and continue fine.

## `/trail log`

`/trail log` is the forensic view. it groups events by episode:

```text
Worker w1 · README review · 6 items
   f  read README.md                   12m ago  @f1
   f  edit README.md                   11m ago  @f2
   $  npm test                          9m ago  @c1
   ✦  trail_done summary                8m ago  @r1

Current session · 12 items
   f  read extensions/trail.ts          5m ago  @f10
   ...
```

use `/trail log` when you need to reconstruct what happened. use `/trail` when you need to decide what to do next.

## commands

primary commands:

- `/trail` — open the inbox.
- `/trail spawn [--fresh] [--as <kind>] <task>` — launch a background worker. seeds the parent session by default. `--as` picks a worker kind (see [worker kinds](#worker-kinds)).
- `/trail tell w<N> [text]` — reply to a worker. omit text to open an input prompt.
- `/trail w<N>` — show one worker mini-report.
- `/trail attach [w<N>]` — copy the `tmux attach` incantation for the shared worker session.
- `/trail checkpoint [flags] [note]` — create a handoff checkpoint.
- `/trail continue [id|last]` — start from a checkpoint.

`/trail help` shows only these six. `/trail help advanced` lists the rest.

secondary commands:

- `/trail answers [query]` — filter inbox to answers.
- `/trail log` — audit timeline grouped by episode.
- `/trail search <query>` — ranked artifact search.
- `/trail workers` — worker dashboard.
- `/trail kinds` — list registered worker kinds.
- `/trail respawn <w<N>|all>` — relaunch a worker whose tmux window died.
- `/trail list [--include-consumed] [--workers]` — list checkpoints or workers.
- `/trail delete [id|last|w<N>]` — delete checkpoint or worker. for workers, cascades to children dispatched via `trail_spawn_child`.

advanced commands:

- `/trail load [id|last|w<N>] [--include-consumed]` — mount artifacts into the navigator without spending tokens.
- `/trail unload <id|w<N>|all>` — unmount loaded artifacts.
- `/trail ref <artifact-id-or-ref>` — attach a compact reference chip.
- `/trail inject <artifact-id-or-ref>` — alias for `ref`.
- `/trail inject-full <artifact-id-or-ref>` — attach full artifact text.
- `/trail copy <artifact-id-or-ref>` — copy to clipboard.
- `/trail wait` / `/trail done` / `/trail fail` — worker-side fallbacks. protocol tools are preferred.

short aliases: `/trail s <query>`, `/trail r [id|last]`, `/trail ckpt`, `/trail ask w<N>`.

## keys

in `/trail` the footer shows only `↑↓ move · / search · ? more · Esc close`. card actions live inside the selected card, contextual to its state. press `?` for the full keymap, including the worker dashboard and inspect views.

primary keys:

- `↑↓` / `j/k` — move.
- `Enter` — primary action for selected card.
- `c` — continue or reply.
- `Space` — mark done / restore.
- `a` — attach compact reference chip.
- `/` — search.
- `tab` / `1` / `2` / `3` — cycle inbox, answers, log.
- `q` / `Esc` — close.

see [docs/checkpoint-guidelines.md](./docs/checkpoint-guidelines.md) for checkpoint quality notes.

## configuration

trail reads `~/.pi/agent/trail.json` (global) and `<project>/.pi/trail.json` (project, overrides global). both optional.

minimal example:

```json
{
  "worker": {
    "maxActive": 8,
    "defaultKind": "scout"
  },
  "summarizer": {
    "enabled": true,
    "model": "openai/gpt-5.2"
  }
}
```

full key reference, summarizer options, worker fleet knobs, and worker-kind frontmatter live in [docs/configuration.md](./docs/configuration.md).

## storage

checkpoints live under `~/.pi/agent/trail/checkpoints/`, workers under `~/.pi/agent/trail/workers/<id>/`. every worker is one window in a single tmux session named `trail-workers`; the parent reacts to `events.ndjson` writes via `fs.watch` instead of polling, and `status.json` / `artifacts.json` are mtime-cached.

`--once` checkpoints are soft-consumed after first use and retained for `consumedRetentionDays` so accidental cancels are recoverable. `/trail load` rehydrates checkpoint or worker artifacts without spending model-context tokens.

full paths and module ownership in [docs/architecture.md](./docs/architecture.md#storage-layout).

## development

run from repo without installing:

```bash
pi --no-extensions -e ./extensions/trail.ts
```

smoke test:

```bash
pi --no-extensions -e ./extensions/trail.ts --mode json --no-session "/trail help"
```

type check:

```bash
npm ci
npm run check
```

run tests:

```bash
npm test
```

dry-run package contents:

```bash
npm run pack:dry
```

stress test the parent under 8 workers — runbook in [`docs/stress-test.md`](./docs/stress-test.md). on the 0.2.2 release with default config, the parent idles at 0 % CPU and stays under 1 % CPU on average with 8 active workers.

## credits

this project comes from trying to understand and improve my own workflow with agents. pi gives extensions enough surface area to build this kind of thing, and trail is an experiment on top of that.

## security

pi extensions run with full system permissions. review source before installing third-party packages.
