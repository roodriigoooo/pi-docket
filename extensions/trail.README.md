# Trail

Session artifacts as first-class objects for Pi.

## Commands

- `/trail` — open working set
- `/trail recall [query]` — recall assistant and worker answers
- `/trail search <query>` — search artifact docs with ripgrep, then browse matches
- `/trail checkpoint [--handoff|--compact|--debug|--review] [--once] [--raw] [note]` — create editable summarized checkpoint
- `/trail continue [id|last]` — choose or start from a checkpoint in a fresh session
- `/trail resume [id|last]` — alias for continue
- `/trail load [id|last] [--include-consumed]` — load a prior checkpoint's artifacts into the navigator without spending any model-context tokens
- `/trail unload <id|all>` — drop a loaded checkpoint from the session
- `/trail delete [id|last]` — permanently delete a checkpoint (bypasses soft-consume)
- `/trail list [--include-consumed]` — list checkpoints
- `/trail ref <artifact-id-or-ref>` — inject compact artifact reference
- `/trail inject <artifact-id-or-ref>` — alias for `ref`
- `/trail inject-full <artifact-id-or-ref>` — inject full artifact text
- `/trail copy <artifact-id>` — copy artifact to clipboard

## Checkpoint resume keys

- `j/k` or arrows — move
- `enter` — continue / load (or delete in delete mode)
- `p` — preview checkpoint markdown
- `e` — edit then continue (resume mode only)
- `d` — delete selected checkpoint after confirmation (resume / delete modes)
- `q` or `esc` — close

## Navigator keys

Default `/trail` view is a working set: next items, pinned items, and done items. Preview is off by default.

- `j/k` or arrows — move
- `g/G` — top/bottom
- `/` — toggle Recall (assistant/worker answers)
- `w` — working set
- `a` — all artifacts
- `tab` — cycle artifact kind filter
- `s` — cycle source (current / all / loaded slots like `c1`, `c2`, `w1`, `w2`)
- `enter` — primary action (review diff, inspect failure, view answer, open file)
- `o` — open current file for file artifacts
- `i` or `r` — attach compact artifact reference chip
- `I` — attach full artifact text chip
- `y` — copy selected artifact
- `p` — pin/unpin item in working set
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
