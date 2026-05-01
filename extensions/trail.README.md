# Trail

Session artifacts as first-class objects for Pi.

## Commands

- `/trail` — open Vim-like artifact navigator
- `/trail search <query>` — search artifact docs with ripgrep, then browse matches
- `/trail checkpoint [--handoff|--compact|--debug|--review] [--once] [--raw] [note]` — create editable summarized checkpoint
- `/trail continue [id|last]` — choose or start from a checkpoint in a fresh session
- `/trail resume [id|last]` — alias for continue
- `/trail list` — list checkpoints
- `/trail ref <artifact-id-or-ref>` — inject compact artifact reference
- `/trail inject <artifact-id-or-ref>` — alias for `ref`
- `/trail inject-full <artifact-id-or-ref>` — inject full artifact text
- `/trail copy <artifact-id>` — copy artifact to clipboard

## Navigator keys

- `j/k` or arrows — move
- `g/G` — top/bottom
- `tab` — cycle artifact type
- `enter` — inspect selected artifact; file artifacts open current full file contents
- `i` or `r` — inject compact artifact reference
- `I` — inject full artifact text
- `y` — copy selected artifact
- `c` — create handoff checkpoint
- `v` — toggle detail
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

Default checkpoints use configured/active model to distill artifacts into compact markdown. Use `--raw` to keep artifact excerpts instead. `--once` checkpoints are deleted from disk and index after successful `/trail continue` / `/trail resume`.

Trail shows short display IDs like `f12` in the navigator and stores stable references like `file:<entry-id>:0` in checkpoints and sidecars.
