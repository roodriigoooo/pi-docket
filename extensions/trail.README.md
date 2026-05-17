# Trail

Session artifacts as first-class objects for Pi.

## Commands

- `/trail` — open inbox
- `/trail answers [query]` — browse assistant and worker answers
- `/trail all` — browse everything captured
- `/trail search <query>` — search artifact docs with ripgrep, then browse matches
- `/trail checkpoint [--handoff|--compact|--debug|--review] [--once] [--raw] [note]` — create editable summarized checkpoint
- `/trail continue [id|last]` — choose or start from a checkpoint in a fresh session
- `/trail resume [id|last]` — alias for continue
- `/trail load [id|last|w<N>] [--include-consumed]` — advanced: mount checkpoint or worker artifacts without spending model-context tokens
- `/trail unload <id|w<N>|all>` — drop a loaded checkpoint or worker from the session
- `/trail delete [id|last|w<N>]` — permanently delete a checkpoint or worker
- `/trail list [--include-consumed] [--workers]` — list checkpoints or workers
- `/trail spawn [--worktree|-w] <task>` — spawn a tmux-backed Pi worker session; `--worktree` isolates edits
- `/trail w<N>` / `/trail result w<N>` — show a worker result panel above the prompt
- `/trail use w<N>` — attach the worker result to the next prompt as a compact Trail ref
- `/trail ask w<N> [text]` — alias for tell
- `/trail tell w<N> [text]` — send input or follow-up to a worker; no text opens a prompt
- `/trail wait <question>` — worker-side Pi prompt fallback: ask the parent session for input
- `/trail done [summary]` — worker-side Pi prompt fallback: mark worker output ready
- `/trail fail <reason>` — worker-side Pi prompt fallback: mark worker failed
- `/trail workers` — open navigable worker inbox
- `/trail ref <artifact-id-or-ref>` — inject compact artifact reference
- `/trail inject <artifact-id-or-ref>` — alias for `ref`
- `/trail inject-full <artifact-id-or-ref>` — inject full artifact text
- `/trail copy <artifact-id>` — copy artifact to clipboard

Short aliases: `/trail s <query>`, `/trail r [id|last]`, `/trail ckpt`.

Worker status appears in an expanded activity stack above the prompt while workers are starting, active, waiting, ready, ready/open-todos, failed, idle, or stale. Every visible worker gets its own row, sorted by attention, with wrapped status/result text and its progress board when present. Starting/thinking workers animate at low FPS with chips like `w1[o  ]` and `w1(o_o)`; static states use `w2(?_?)`, `w3(^_^)`, `w4(x_x)`, and `w5(-_-)`. Use `/trail w<N>` to expand an answer-first result panel above the prompt, `/trail use w<N>` to attach that result to the next message, and `/trail ask w<N> [text]` for follow-up. `/trail workers` opens the navigable worker inbox for reading worker answers/progress and choosing follow-up actions. Worker sessions should use protocol tools (`trail_wait`, `trail_done`, and `trail_fail`) for parent coordination. Workers may call `trail_todos` to publish a short ordered progress board shown in the dock, `/trail w<N>`, and `/trail workers`; if `trail_done` runs while todos remain open, Trail shows the separate `ready/open todos` state. This is a lightweight Trail visibility layer, not a full task-list replacement. Worker-side `/trail wait`, `/trail done`, and `/trail fail` are Pi prompt fallbacks, not bash commands. Accidental direct bash calls like `/trail wait ...` are intercepted inside worker sessions. Workers default to read-only investigation unless explicitly asked to edit; use `/trail spawn --worktree <task>` for isolated parallel editing. Trail removes the worktree when deleting that worker, but does not auto-merge worker edits.

## Checkpoint resume keys

- `j/k` or arrows — move
- `enter` — continue / load (or delete in delete mode)
- `p` — preview checkpoint markdown
- `e` — edit then continue (resume mode only)
- `d` — delete selected checkpoint after confirmation (resume / delete modes)
- `q` or `esc` — close

## Parallel work inbox keys

- `j/k` or arrows — move
- `tab` — cycle worker filter (`all`, `w1`, `w2`, ...)
- `f` — cycle artifact kind filter
- `enter` — peek selected artifact
- `t` — tell selected worker
- `a` — open Answers for selected worker
- `c` — copy tmux attach command
- `l` — load selected worker refs (debug)
- `x` — dismiss selected inbox row locally
- `?` — show full shortcut help
- `q` or `esc` — close

## Navigator keys

Default `/trail` view is Inbox: unresolved items first, recent items only when all clear. Preview is off by default.

- `j/k` or arrows — move
- `g/G` — top/bottom
- `/` — search Trail
- `tab` — cycle Inbox → Answers → All
- `1` — Inbox
- `2` — Answers
- `3` — All
- `f` — cycle artifact kind filter
- `s` — cycle source when needed (`current`, loaded checkpoints, workers)
- `enter` — primary action (tell waiting worker, review diff, inspect failure, view answer, open file)
- `o` — open current file for file artifacts
- `t` — tell selected worker
- `a` or `i` — attach compact artifact reference chip
- `I` — attach full artifact text chip
- `y` — copy selected artifact
- `p` — pin/unpin item in Inbox
- `x` — mark item done / restore it to the queue
- `c` — create handoff checkpoint
- `v` — toggle preview
- `?` — show full shortcut help
- `q` or `esc` — close

## Inspect view keys

- `j/k` or arrows — scroll
- `d/u` — half-page down/up
- `g/G` — top/bottom
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

Default checkpoints use configured/active model to distill artifacts into compact markdown. Use `--raw` to keep artifact excerpts instead.

`--once` checkpoints are **soft-consumed** at the end of the session in which they were used (`/trail continue`, `/trail resume`, or `/trail load`). The index entry is marked `consumedAt` and hidden from default listings, but the markdown and `artifacts.json` files stay on disk for `consumedRetentionDays` (default 7) so accidental cancels are recoverable. `/trail unload <id>` cancels the pending consume contract for the current session. `/trail delete` always purges immediately. Pass `--include-consumed` to `list` / `load` to see soft-consumed entries.

File-path references inside an injected checkpoint always survive consume — they point to your project's disk paths, not Trail storage. Only artifact-level lookups (`/trail ref c1.f12`, etc.) require the original `artifacts.json` to still exist.

## Loading vs continuing

- `/trail continue` spawns a fresh session and injects the checkpoint markdown into its context.
- `/trail load` stays in the current session and pulls a prior checkpoint's artifacts into the navigator only — **zero bytes** are added to the model's context until you explicitly chip an artifact with `/trail ref` or `/trail inject-full`. Loaded artifacts appear under a slot id (`c1`, `c2`, …) and use `<slot>.<displayId>` (e.g. `c1.f12`) so they never collide with current-session ids.

Trail shows short display IDs like `f12` in the navigator and stores stable references like `file:<entry-id>:0` in checkpoints and sidecars.
