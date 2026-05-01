# Trail Architecture

Trail is a Pi extension for session artifacts and fresh-session checkpoints.

## Domain language

**Artifact**: structured object derived from session activity, such as a command, file operation, prompt, response, code block, error, or checkpoint.

**Artifact Catalog**: Module that owns artifact extraction, identity, lookup, references, full text, inspection, search, and checkpoint payloads.

**Reference**: compact prompt-safe pointer to an artifact that preserves intent without injecting full artifact text.

**Checkpoint**: distilled continuation package that can seed a fresh Pi session without carrying full prior context.

**Checkpoint Lifecycle**: Module that owns creating a checkpoint from selected artifacts, including drafting, review, persistence, and session labeling.

**Navigator**: interactive Trail view for browsing, inspecting, referencing, copying, and checkpointing artifacts.

## Current modules

### Artifact Catalog

Interface:

- `list()`
- `find(idOrRef)`
- `reference(artifact)`
- `fullText(artifact)`
- `inspect(artifact)`
- `search(query)`
- `selectForCheckpoint(mode, limit)`
- `checkpointPayload(artifacts, mode)`

Leverage:
- Callers do not inspect `meta.args` directly.
- Stable artifact refs survive beyond current navigator display IDs.
- Checkpoints, search, reference injection, and inspect share one artifact truth.

### Checkpoint Lifecycle

Interface:

- `create(args)`

Owned flow:
1. Parse checkpoint options.
2. Select artifacts.
3. Draft summarized or raw markdown.
4. Let user review/edit when UI exists.
5. Persist checkpoint markdown and sidecar artifacts.
6. Append Trail checkpoint entry and label session leaf.

## Planned deepening opportunities

### Checkpoint Store Module

Own index, markdown, sidecar persistence, lookup, list, and consume-on-use deletion.

### Summarizer Module

Own prompt construction, model selection, auth, token policy, and output parsing.

### Trail Command Grammar Module

Parse `/trail` raw args into intent objects with validation and help sync.

### Navigator Action Module

Separate movement/filter/action state transitions from TUI rendering.

### Search Index Module

Own artifact search documents, ranking, and ripgrep Adapter.
