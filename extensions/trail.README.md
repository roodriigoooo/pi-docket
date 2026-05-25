# Trail

Session artifacts as first-class objects for Pi.

## Commands

Primary (shown in `/trail help`):

- `/trail` — open the inbox
- `/trail spawn [--fresh] <task>` — spawn a worker as a window in the shared `trail-workers` tmux session. seeds the parent session JSONL by default; `--fresh` opts out
- `/trail tell w<N> [text]` — send input or follow-up via `tmux send-keys -l`. no text opens a prompt
- `/trail w<N>` / `/trail result w<N>` — show a worker result panel above the prompt
- `/trail attach [w<N>]` — copy the `tmux attach -t trail-workers` incantation; with `w<N>`, lands directly on that worker's pane
- `/trail checkpoint [--once] [--summarize] [note]` — freeze an editable artifact bundle + orientation header
- `/trail continue [id|last]` — start from a checkpoint in a fresh session; mounts the bundle at zero token cost

Advanced (shown in `/trail help advanced`):

- `/trail answers [query]` — browse assistant and worker answers
- `/trail log` — audit timeline grouped by episode
- `/trail search <query>` — search artifact docs with ripgrep, then browse matches
- `/trail use w<N>` — attach the worker result to the next prompt as a compact Trail ref
- `/trail ask w<N> [text]` — alias for tell
- `/trail resume [id|last]` — alias for continue
- `/trail load [id|last|w<N>] [--include-consumed]` — mount checkpoint or worker artifacts without spending model-context tokens
- `/trail unload <id|w<N>|all>` — drop a loaded checkpoint or worker from the session
- `/trail delete [id|last|w<N>]` — kill window + purge worker, or delete checkpoint
- `/trail list [--include-consumed] [--workers]` — list checkpoints or workers
- `/trail workers` — open the worker dashboard
- `/trail ref <artifact-id-or-ref>` — inject compact artifact reference
- `/trail inject <artifact-id-or-ref>` — alias for `ref`
- `/trail inject-full <artifact-id-or-ref>` — inject full artifact text
- `/trail copy <artifact-id>` — copy artifact to clipboard
- `/trail wait <question>` — worker-side Pi prompt fallback: ask the parent session for input
- `/trail done [summary]` — worker-side Pi prompt fallback: mark worker output ready
- `/trail fail <reason>` — worker-side Pi prompt fallback: mark worker failed

Short aliases: `/trail s <query>`, `/trail r [id|last]`, `/trail ckpt`.

## Worker topology

Every worker is one window in a single tmux session named `trail-workers`. First `/trail spawn` creates the session (`tmux new-session -d -s trail-workers -n w<N>`). Subsequent spawns add windows (`tmux new-window -t trail-workers: -n w<N>`). One server hosts the fleet, one `tmux attach` puts you in front of all of them, one `kill-window` retires a worker. `/trail attach` copies the attach command; `/trail attach w<N>` adds `\; select-window -t w<N>`.

Parent → worker stdin uses `tmux send-keys -t trail-workers:w<N> -l '[trail] <text>'` followed by a separate `Enter` send. The `-l` flag is literal mode (tmux skips key-table interpretation), and the `[trail]` prefix lets an attached user see which keystrokes are parent-injected versus their own typing.

Workers emit append-only NDJSON events to `workers/<id>/events.ndjson` (state transitions, todo updates, tool calls). The parent watches the workers root with `fs.watch` and tails each event log from a held offset. `status.json` and `artifacts.json` are cached by mtime; if neither has been touched, the parent doesn't reparse. The 15 s heartbeat that used to rewrite `artifacts.json` unconditionally now hashes the artifact list and skips the write when nothing has changed.

If the shared tmux session dies unexpectedly, the parent detects it on its next dock tick (via `tmux has-session -t trail-workers`) and patches every still-active worker to `state: error`.

## Worker dock

Worker status appears in a compact dock above the prompt. One row per worker, sorted by attention/recency. Idle rows dim. Attention rows (`needs_input`, `failed`, `ready`, `ready_open_todos`) get a state colour plus a `← reply / inspect / review` chip on the right. A model badge (e.g. `w1[sonnet-4-6]`) appears only when a worker is on a different model than the parent or workers vary among themselves.

`/trail workers` opens the navigable worker inbox: rows stay collapsed, and only the selected worker gets a compact preview plus actions. Use `/trail w<N>` to expand an answer-first result panel above the prompt, `/trail use w<N>` to attach that result to the next message, and `/trail ask w<N> [text]` for follow-up. Worker sessions should use protocol tools (`trail_wait`, `trail_done`, and `trail_fail`) for parent coordination. Workers may call `trail_todos` to publish a short ordered progress board shown in the dock, `/trail w<N>`, and `/trail workers`; if `trail_done` runs while todos remain open, Trail shows the separate `ready/open todos` state. This is a lightweight Trail visibility layer, not a full task-list replacement. Worker-side `/trail wait`, `/trail done`, and `/trail fail` are Pi prompt fallbacks, not bash commands. Accidental direct bash calls like `/trail wait ...` are intercepted inside worker sessions. Workers run in hidden workspaces seeded from the parent's current repo state. If they edit files, Trail surfaces one change-set card; press `P` to promote the whole set, `Enter`/`d` to inspect the diff, or `c` to ask for revision.

## Prompt cache seeding

By default, `/trail spawn` copies the parent's pi session JSONL into the worker's session dir via `SessionManager.forkFrom`, then launches the worker with `--continue`. The worker resumes from the parent's prefix so the provider's prompt cache hits the shared prefix on the worker's first call, and the worker inherits the parent's discoveries. Use `--fresh` to opt out. If the parent hasn't yet flushed its JSONL (pi defers persistence until the first assistant turn), seeding falls back gracefully.

## Checkpoint resume keys

- `j/k` or arrows — move
- `enter` — continue / load (or delete in delete mode)
- `p` — preview checkpoint markdown
- `e` — edit then continue (resume mode only)
- `d` — delete selected checkpoint after confirmation (resume / delete modes)
- `q` or `esc` — close

## Parallel work inbox keys

Primary:
- `↑↓` / `j/k` — move
- `Enter` — open selected worker details
- `c` — continue/tell selected worker
- `a` — copy `tmux attach -t trail-workers \; select-window -t w<N>`
- `l` — load selected worker refs
- `?` — show advanced shortcuts
- `q` or `Esc` — close

Advanced (revealed by `?`):
- `tab` switch worker · `t` tell alias · `x` stop/delete worker (destructive)

## Navigator keys

Default `/trail` view is Inbox: unresolved items first, recent items only when all clear. The footer carries only `↑↓ move · / search · ? more · Esc close`; card actions live inside the selected card itself.

Primary:
- `↑↓` / `j/k` — move
- `Enter` — review primary action (tell waiting worker, review diff, inspect failure, view answer, open file)
- `P` — promote selected worker change set when available
- `d` — inspect selected diff/artifact
- `c` — continue conversation with the selected worker (falls back to handoff checkpoint when nothing is worker-bound)
- `Space` — mark item done / restore it
- `a` — attach compact reference chip
- `y` — copy selected artifact
- `/` — search Trail
- `s` — switch source (always visible above the list when multiple sources exist)
- `tab` / `1` / `2` / `3` — cycle Inbox → Answers → Log
- `?` — show advanced shortcuts
- `q` or `Esc` — close

Advanced (revealed by `?`):
- `o` open file · `I` inject full chip · `p` pin · `v` preview · `f` cycle artifact kind · `t` tell (alias for `c`) · `x` done (alias for `Space`) · `g/G` top/bottom

## Inspect view keys

- `j/k` or arrows — scroll vertically
- `h/l` or arrows — scroll horizontally
- `d/u` — half-page down/up
- `g/G` — top/bottom
- `0` — reset horizontal scroll
- `q` or `esc` — close

## Captured artifact kinds

- commands: command, cwd, status, output
- errors: failed tool calls and failed model responses
- files: read/write/edit/grep/find/ls operations with path + args
- code: fenced code blocks from model responses
- prompts: user prompts
- responses: model text responses
- checkpoints: Trail checkpoint markers

## Configuration

Trail merges config from:

1. `~/.pi/agent/trail.json`
2. `<project>/.pi/trail.json`

Example:

```json
{
  "maxArtifacts": 300,
  "maxBodyChars": 6000,
  "checkpointArtifacts": 24,
  "summarizer": {
    "enabled": true,
    "provider": "openai",
    "model": "gpt-5.2",
    "maxOutputTokens": 1200,
    "maxInputChars": 36000,
    "timeoutMs": 120000
  }
}
```

## Storage

Checkpoints live in:

- `~/.pi/agent/trail/checkpoints/<id>.md`
- `~/.pi/agent/trail/checkpoints/<id>.artifacts.json`
- index: `~/.pi/agent/trail/index.json`

A checkpoint is the artifact bundle (`<id>.artifacts.json`) plus a deterministic orientation header in `<id>.md` — no model call by default. Pass `--summarize` to add model-written prose on top.

`--once` checkpoints are **soft-consumed** at the end of the session in which they were used (`/trail continue`, `/trail resume`, or `/trail load`). The index entry is marked `consumedAt` and hidden from default listings, but the markdown and `artifacts.json` files stay on disk for `consumedRetentionDays` (default 7) so accidental cancels are recoverable. `/trail unload <id>` cancels the pending consume contract for the current session. `/trail delete` always purges immediately. Pass `--include-consumed` to `list` / `load` to see soft-consumed entries.

File-path references inside an injected checkpoint always survive consume — they point to your project's disk paths, not Trail storage. Only artifact-level lookups (`/trail ref c1.f12`, etc.) require the original `artifacts.json` to still exist.

## Loading vs continuing

Continue composes load — both **mount** the bundle into the navigator at zero token cost:

- `/trail load` stays in the current session and mounts a prior checkpoint's artifacts into the navigator only — **zero bytes** are added to the model's context until you explicitly chip an artifact with `/trail ref` or `/trail inject-full`. Loaded artifacts appear under a slot id (`c1`, `c2`, …) and use `<slot>.<displayId>` (e.g. `c1.f12`) so they never collide with current-session ids.
- `/trail continue` spawns a fresh session, mounts the bundle the same way, and injects only the orientation header. The artifacts are chippable from turn 1 but cost nothing until chipped.

Trail shows short display IDs like `f12` in the navigator and stores stable references like `file:<entry-id>:0` in checkpoints and sidecars.
