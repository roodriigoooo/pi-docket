# Bundle-first checkpoints

Superseded by [ADR-0005](./0005-durable-deliverable-store.md). This file remains historical: its bundle/orientation/checkpoint lifecycle is retained only for compatibility reads, not for new writes or public save/use flows.

A checkpoint is a frozen **artifact bundle** (`<id>.artifacts.json`) plus a small deterministic **orientation header** — not a model-written summary. The old `continue` path opened a fresh session, **mounted** the bundle at zero model-context tokens, and injected only the header (git, files touched, errors, the human-authored note); artifacts were chipped on demand. The model summarizer became an opt-in `--summarize` layer, off the default path. The four modes (`handoff/compact/debug/review`) were dropped in favour of one default selection (errors + files + recent decisions) that the interactive selector prunes.

## Status

superseded

## Considered options

- **Summary-first (previous default):** the summarizer ran on every checkpoint and `continue` injected its prose. Rejected: it contradicts Docket's stated thesis ("it keeps the useful artifacts around" rather than "compressing everything into a summary"), pays a model call per checkpoint, bloats the fresh session's context, and lets the model *invent* decisions/next-steps — the one thing its own system prompt warned against.
- **Keep four modes:** rejected once the summarizer left the hot path — the modes reduced to thin kind-orderings that the interactive selector already supersedes.

## Consequences

- The **note** is now load-bearing: decisions and next steps are human-authored, not model-guessed. Checkpoint quality tracks what the human writes.
- `continue` no longer puts artifact *contents* in context on turn 1 — only the orientation header. Resuming work needs a chip or a question first. This is deliberate and matches the zero-token philosophy that `load` already embodied.
- `continue` now composes `load` (both mount); they stop being separate restore paths.
- The summarizer module, provider/model config, and the `CheckpointMode` branch stay in-tree but become optional/back-compat surface, not the spine.
