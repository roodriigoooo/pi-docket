<p align="center">
  <img src="./assets/trail_logo.jpeg" alt="Trail logo" width="220" />
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

## checkpoints

checkpoints are for handoff. they are useful when the session is noisy, context is getting full, or you want to continue from a smaller summary.

```bash
/trail checkpoint --handoff finish the checkpoint store refactor
/trail continue last
```

modes:

| mode | picks | use for |
|---|---|---|
| `--handoff` | decisions, files changed, dead ends, next steps | passing work to a new session or another model |
| `--compact` | minimal recent state | continuing without the full conversation |
| `--debug` | errors, failed commands, repro steps | reproducing a bug in a clean session |
| `--review` | files changed, code blocks, commands | walking a reviewer through what happened |

flags:

- `--once` — soft-consume after first `/trail continue` or `/trail load`.
- `--raw` — skip model summarization and keep artifact excerpts as written.
- `--model <provider/model>` — summarize with a specific model.
- `--max-output <tokens>` — cap summary length.

checkpoints are plain markdown with a sidecar `artifacts.json`. you can edit the markdown before continuing.

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
- `/trail spawn [--fresh] <task>` — launch a background worker. seeds the parent session by default.
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
- `/trail list [--include-consumed] [--workers]` — list checkpoints or workers.
- `/trail delete [id|last|w<N>]` — delete checkpoint or worker.

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

in `/trail`:

the footer shows only `↑↓ move · / search · ? more · Esc close`. card actions live inside the selected card itself, contextual to its state.

- `↑↓` / `j/k` — move.
- `Enter` — primary action for selected card.
- `c` — continue or reply.
- `Space` — mark done / restore.
- `a` — attach compact reference chip.
- `y` — copy selected artifact.
- `/` — search.
- `s` — switch source (only visible when carryover sources exist).
- `tab` / `1` / `2` / `3` — cycle inbox, answers, log.
- `?` — show advanced shortcuts (including `P d c y o I p v f t x g G`).
- `q` / `Esc` — close.

advanced keys shown with `?`:

- `o` open file.
- `I` inject full chip.
- `p` pin.
- `v` preview.
- `f` cycle artifact kind.
- `t` tell.
- `x` mark done.
- `g/G` top/bottom.

in `/trail workers`:

- `↑↓` / `j/k` — move.
- `Enter` — open selected worker.
- `c` — continue or tell selected worker.
- `a` — copy `tmux attach -t trail-workers \; select-window -t w<N>`.
- `l` — load selected worker refs.
- `?` — show advanced shortcuts.
- `q` / `Esc` — close.

inspect views:

- `j/k` line.
- `J/K` five lines.
- `d/u` and `Ctrl+D/U` half-page.
- `Space` / `Ctrl+F` / `PageDown` page.
- `b` / `Ctrl+B` / `PageUp` page back.
- `g/G` top/bottom.
- `q` close.

checkpoint review and resume have their own small keymaps. see [docs/checkpoint-guidelines.md](./docs/checkpoint-guidelines.md) for checkpoint quality notes.

## configuration

trail reads config from:

1. `~/.pi/agent/trail.json`
2. `<project>/.pi/trail.json`

example:

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
    "guardrailsPath": "~/.pi/agent/trail/my-worker-rules.md"
  }
}
```

`worker.guardrailsPath` can point to a custom guardrail file. absolute paths and cwd-relative paths both work. if unset, trail uses `extensions/worker-guardrails.md` from this package.

## storage

checkpoints live in:

- `~/.pi/agent/trail/checkpoints/<id>.md`
- `~/.pi/agent/trail/checkpoints/<id>.artifacts.json`
- `~/.pi/agent/trail/index.json`
- `~/.pi/agent/trail/events.ndjson`

workers live in:

- `~/.pi/agent/trail/workers/<id>/task.md`
- `~/.pi/agent/trail/workers/<id>/status.json`
- `~/.pi/agent/trail/workers/<id>/artifacts.json`
- `~/.pi/agent/trail/workers/<id>/events.ndjson`
- `~/.pi/agent/trail/workers/<id>/session/` (seeded pi session jsonl)
- `~/.pi/agent/trail/workers/<id>/workspace/` (detached git worktree)

every worker is one window in a single tmux session named `trail-workers`. the parent watches the workers root with `fs.watch` and tails each worker's `events.ndjson` from a held offset. `status.json` and `artifacts.json` are cached by mtime; if neither has been touched since the last read, the parent doesn't reparse them. the heartbeat that used to rewrite `artifacts.json` every 15 seconds now signs the artifact list and skips the write when nothing has changed.

checkpoint state is event-backed through `events.ndjson` (at the trail root, not per-worker), with `index.json` kept as a compatibility snapshot. worker artifact snapshots are refreshed by the worker heartbeat and mounted into the parent session as sources like `w1`, `w2`, etc.

`--once` checkpoints are soft-consumed after use. the index entry gets `consumedAt`, default lists hide it, and the files stay on disk for `consumedRetentionDays` so accidental cancels are recoverable. `/trail unload <id>` cancels a pending consume. `/trail delete` purges immediately. use `--include-consumed` to see soft-consumed entries.

file-path references inside a checkpoint point to project files, so they survive checkpoint consume. artifact-level refs need the sidecar `artifacts.json` to still exist. `/trail load` rehydrates those refs without spending model-context tokens.

worker artifacts work similarly, but come from `workers/<id>/artifacts.json`. `/trail load w<N>` mounts them. `/trail delete w<N>` kills and purges the worker. `/trail unload w<N>` only unmounts it from the current session.

## example checkpoint markdown

`~/.pi/agent/trail/checkpoints/20260502-184212Z.md`

```md
# Trail checkpoint 20260502-184212Z

mode: handoff
summary: llm
cwd: /Users/me/project
created: 2026-05-02T18:42:12.000Z
note: finish checkpoint store refactor
artifacts: /Users/me/.pi/agent/trail/checkpoints/20260502-184212Z.artifacts.json

## Summary
Checkpoint store now writes durable markdown plus sidecar artifact JSON.

## Decisions / constraints
- Keep checkpoints compact; do not preserve full transcript.
- Store exact artifact refs so fresh sessions can ask for source context.

## Current state
- `extensions/checkpoint-store.ts` handles save, list, find, read, consume.
- `--once` checkpoints are soft-consumed after use; markdown and sidecar artifacts are retained until the consumed retention window expires.

## Next steps
- Add tests for partial checkpoint id lookup.
- Run `npm run check`.

## Avoid repeating
- Do not move checkpoint files into project cwd; storage belongs under Pi agent dir.

## References
- [file:f12] `extensions/checkpoint-store.ts`
- [command:c4] `npm run check`
```

sidecar artifact example:

```json
[
  {
    "id": "f12",
    "displayId": "f12",
    "ref": "file:abc123:0",
    "kind": "file",
    "title": "edit extensions/checkpoint-store.ts",
    "subtitle": "+ save checkpoint markdown and sidecar artifacts",
    "body": "export function createCheckpointStore(): CheckpointStore { ... }",
    "timestamp": 1777747332000,
    "meta": {
      "path": "extensions/checkpoint-store.ts"
    }
  },
  {
    "id": "c4",
    "displayId": "c4",
    "ref": "command:def456:0",
    "kind": "command",
    "title": "npm run check",
    "subtitle": "exit 0",
    "body": "tsc --noEmit"
  }
]
```

## trail vs `/compact`

`/compact` and trail solve related but different problems. `/compact` compresses the current conversation. trail preserves specific artifacts and surfaces decisions.

| feature | `/compact` | trail |
|---|---|---|
| compress current conversation | yes | yes, optionally |
| review what needs a decision | no | yes |
| select exact artifacts to preserve | limited | yes |
| preserve exact commands/errors/files | not guaranteed | yes |
| save durable checkpoints | not the main model | yes |
| resume in another session/model/tool | limited | yes |
| edit handoff before reuse | not the core workflow | yes |
| track dead ends / already tried | not guaranteed | yes |
| run background investigations | no | yes |

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

stress test the parent under 8 workers — runbook in [`scripts/stress-test.md`](./scripts/stress-test.md). on the 0.2.2 release with default config, the parent idles at 0 % CPU and stays under 1 % CPU on average with 8 active workers.

## credits

this project comes from trying to understand and improve my own workflow with agents. pi gives extensions enough surface area to build this kind of thing, and trail is an experiment on top of that.

## security

pi extensions run with full system permissions. review source before installing third-party packages.
