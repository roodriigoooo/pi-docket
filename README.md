# Trail for Pi

Trail is a Pi extension for treating session artifacts as first-class objects. Browse commands, errors, files, code blocks, prompts, model responses, and checkpoints; reference or inject artifacts into prompts; and create compact checkpoints for fresh-session continuation.

Trail is not history search. It is a session artifact navigator and context handoff tool.

## Install

From GitHub while Trail is moving fast:

```bash
pi install git:github.com/rosastre/pi-trail
```

Pinned GitHub release:

```bash
pi install git:github.com/rosastre/pi-trail@v0.1.0
```

From npm after publish:

```bash
pi install npm:@rosastre/trail
```

## Development

Run from repo without installing:

```bash
pi --no-extensions -e ./extensions/trail.ts
```

Smoke test:

```bash
pi --no-extensions -e ./extensions/trail.ts --mode json --no-session "/trail help"
```

Type check:

```bash
npm install
npm run check
```

Dry-run package contents:

```bash
npm run pack:dry
```

## Commands

- `/trail` — open artifact navigator
- `/trail search <query>` — search artifact docs with ripgrep, then browse matches
- `/trail checkpoint [--handoff|--compact|--debug|--review] [--once] [--raw] [note]` — create editable summarized checkpoint
- `/trail continue <id|last>` — start fresh session with checkpoint loaded into editor
- `/trail resume [id|last]` — alias for continue
- `/trail list` — list checkpoints
- `/trail ref <artifact-id-or-ref>` — inject compact artifact reference
- `/trail inject <artifact-id-or-ref>` — alias for `ref`
- `/trail inject-full <artifact-id-or-ref>` — inject full artifact text
- `/trail copy <artifact-id-or-ref>` — copy artifact to clipboard

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
- `~/.pi/agent/trail/index.json`

`--once` checkpoints are deleted from disk and index after successful `/trail continue` / `/trail resume`.

## Security

Pi extensions run with full system permissions. Review source before installing third-party packages.
