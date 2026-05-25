# Trail

Trail is a review queue for work done inside a Pi coding session. It pulls the few moments that need a human decision out of a long transcript and shows them as cards. It is explicitly *not* a transcript browser, a memory system, or a summarizer — it keeps useful work around and asks "which of these need a decision?"

## Language

**Artifact**:
A structured object derived from session activity — a file edit, failed command, error, prompt, response, code block, or checkpoint marker.
_Avoid_: event, item, record.

**Review item**:
An artifact the attention queue has ranked as needing a decision. Only review items reach the inbox; plain evidence stays in the log.
_Avoid_: task, todo, notification.

**Worker**:
A background Pi process running as one window in the shared `trail-workers` tmux session. Generates the artifacts that become review items.
_Avoid_: job, agent, subprocess.

**Checkpoint**:
A frozen, durable **bundle** of catalog artifacts, restartable into a fresh session or the current navigator. A checkpoint is the artifact bundle first; any prose summary is optional polish, never its definition.
_Avoid_: snapshot, save, summary, handoff doc.

**Bundle**:
The `<id>.artifacts.json` sidecar — the spine of a checkpoint. Deterministic, written with no model call.
_Avoid_: payload, blob.

**Orientation header**:
The small deterministic block a checkpoint carries: resuming-note, git state, files touched, errors, and a pointer to the mounted bundle. It is what `continue` injects into a fresh session — not the artifact contents.
_Avoid_: summary, preamble, frontmatter.

**Note**:
The human-authored handoff intent on a checkpoint: decisions made and next steps. Under the bundle-first design the note carries the judgement a summarizer would otherwise have to guess.
_Avoid_: description, comment, label.

**Mount**:
Pulling a bundle's artifacts into the navigator under a slot id (`c1`, `c2`) at **zero model-context tokens**. Artifacts stay on disk until explicitly chipped with a reference.
_Avoid_: load into context, inject, import.

**Continue vs Load**:
**Load** mounts a bundle into the *current* session's navigator. **Continue** opens a *fresh* session, mounts the bundle, and injects only the orientation header. Continue composes Load.
_Avoid_: resume (alias only), open, restore.

## Relationships

- A **Worker** produces **Artifacts**; the attention queue promotes some to **Review items**.
- A **Checkpoint** is a frozen selection of **Artifacts** stored as a **Bundle** plus an **Orientation header**.
- **Continue** = fresh session + **Mount** the bundle + inject the **Orientation header**.
- **Load** = **Mount** the bundle into the current session.
- A model summary is an optional `--summarize` layer *on top of* a checkpoint, never the checkpoint itself.

## Example dialogue

> **Dev:** "When I `continue` a checkpoint, does the assistant see the file contents?"
> **Maintainer:** "No — it sees the **orientation header** and a **mounted** bundle. The artifacts are zero-token until you chip one. That's the point: Trail keeps artifacts around, it doesn't compress them into context."
> **Dev:** "Then where do the decisions and next steps come from?"
> **Maintainer:** "The **note**. A human states them. The summarizer used to guess them — that's why it's opt-in now, not the default."

## Flagged ambiguities

- "checkpoint" was used to mean both the prose summary and the artifact bundle. Resolved: a **Checkpoint** is the **Bundle** first; prose is optional `--summarize` output.
- "load" vs "continue" were blurred. Resolved: both **Mount**; only **Continue** opens a fresh session.
