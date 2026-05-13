# Trail

Session artifacts as first-class objects for Pi.

## Commands

- `/trail` — open review inbox
- `/trail memory [query]` — browse assistant and worker answers
- `/trail catalog` — browse everything captured
- `/trail search <query>` — search artifact docs with ripgrep, then browse matches
- `/trail checkpoint [--handoff|--compact|--debug|--review] [--once] [--raw] [note]` — create editable summarized checkpoint
- `/trail continue [id|last]` — choose or start from a checkpoint in a fresh session
- `/trail resume [id|last]` — alias for continue
- `/trail load [id|last|w<N>] [--include-consumed]` — advanced: mount checkpoint or worker artifacts without spending model-context tokens
- `/trail unload <id|w<N>|all>` — drop a loaded checkpoint or worker from the session
- `/trail delete [id|last|w<N>]` — permanently delete a checkpoint or worker
- `/trail list [--include-consumed]` — list checkpoints
- `/trail spawn <task>` — spawn a tmux-backed Pi worker session for parallel investigation
- `/trail ask w<N> <reply>` — reply to a waiting worker from the parent session
- `/trail wait <question>` — worker-side: ask the parent session for input
- `/trail done [summary]` — worker-side: mark worker output ready
- `/trail fail <reason>` — worker-side: mark worker failed
- `/trail workers` — open worker inbox power/debug view
- `/trail ref <artifact-id-or-ref>` — inject compact artifact reference
- `/trail inject <artifact-id-or-ref>` — alias for `ref`
- `/trail inject-full <artifact-id-or-ref>` — inject full artifact text
- `/trail copy <artifact-id>` — copy artifact to clipboard

Short aliases: `/trail w`, `/trail m`, `/trail cat`, `/trail s <query>`, `/trail r [id|last]`, `/trail ckpt`.

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
- `l` — review selected worker's artifacts in Trail
- `a` — copy tmux attach command
- `r` — open Memory for selected worker answers
- `x` — dismiss selected inbox row locally
- `?` — show full shortcut help
- `q` or `esc` — close

## Navigator keys

Default `/trail` view is Review: unresolved items first, recent items only when all clear. Preview is off by default.

- `j/k` or arrows — move
- `g/G` — top/bottom
- `/` — search Trail
- `tab` — cycle Review → Memory → Catalog
- `w` — Review
- `m` — Memory
- `A` — Catalog
- `f` — cycle artifact kind filter
- `s` — cycle source when needed (`current`, loaded checkpoints, workers)
- `enter` — primary action (reply to waiting worker, review diff, inspect failure, view answer, open file)
- `o` — open current file for file artifacts
- `a`, `i`, or `r` — attach compact artifact reference chip (`r` replies when the selected row is a worker question)
- `I` — attach full artifact text chip
- `y` — copy selected artifact
- `p` — pin/unpin item in Review
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
