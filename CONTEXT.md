# Docket

Docket is a decision queue for work done inside a Pi coding session. It pulls moments that need human judgment out of long agent work and shows them as cards. It is explicitly *not* a transcript browser, a memory system, a summarizer, or a session manager.

Pi owns session topology (`/tree`, `/fork`, `/clone`, `/compact`, `/new`, `/resume`). Docket owns attention, evidence, and explicit worker-parent coordination.

## Language

**Artifact**:
A structured object derived from session activity — a file edit, failed command, error, prompt, response, code block, worker status, or saved bundle marker.
_Avoid_: event, item, record.

**Review item**:
An artifact the attention queue has ranked as needing a decision. Only review items reach the docket; plain evidence stays in the log.
_Avoid_: task, todo, notification.

**Docket**:
The decision surface containing review items. A docket is for judgment, not browsing all history.
_Avoid_: trail, transcript, memory.

**Worker**:
A background Pi process running as one window in the shared `docket-workers` tmux session. Generates artifacts that may become review items.
_Avoid_: job, agent, subprocess.

**Evidence bundle**:
A frozen, durable selection of artifacts saved with `/docket save`. It consists of a small markdown orientation file plus a deterministic `<id>.artifacts.json` sidecar. A bundle preserves evidence; it does not move the Pi session.
_Avoid_: checkpoint, resume, summary, handoff doc.

**Bundle sidecar**:
The `<id>.artifacts.json` file — deterministic artifact data written with no model call.
_Avoid_: payload, blob.

**Orientation header**:
The small deterministic markdown block a bundle carries: note, git state, files touched, errors, and refs to mounted artifacts. It is evidence orientation, not model summary.
_Avoid_: summary, preamble, checkpoint prose.

**Note**:
The human-authored intent on a bundle: decisions made and next steps. The note carries judgment a summarizer would otherwise guess.
_Avoid_: description, comment, label.

**Mount**:
Pulling a bundle's artifacts into the navigator under a slot id (`c1`, `c2`) at **zero model-context tokens**. Artifacts stay on disk until explicitly chipped with `/docket ref` or `/docket inject-full`.
_Avoid_: load into context, inject, import.

**Save vs Load**:
**Save** creates an evidence bundle and labels the current Pi tree leaf. **Load** mounts a bundle or worker artifacts into the current Docket navigator. Neither replaces Pi's session commands.
_Avoid_: continue, resume, restore.

## Relationships

- A **Worker** produces **Artifacts**; the attention queue promotes some to **Review items**.
- An **Evidence bundle** freezes selected **Artifacts** plus an **Orientation header**.
- **Save** = choose artifacts + write bundle + label current Pi tree leaf.
- **Load** = **Mount** the bundle into the current session.
- A model summary is optional `--summarize` polish on top of a bundle, never the bundle's definition.

## Example dialogue

> **Dev:** "When I `/docket load last`, does the assistant see file contents?"
> **Maintainer:** "No — Docket mounts bundle artifacts at zero tokens. The model sees nothing until you chip an artifact with `/docket ref` or `/docket inject-full`."
> **Dev:** "Then how do I continue from older work?"
> **Maintainer:** "Use Pi for session movement: `/tree`, `/fork`, `/clone`, `/resume`, or `/compact`. Use Docket to carry evidence and decisions across those moves."

## Flagged ambiguities

- "checkpoint" made Docket sound like a session-resume feature. Resolved: canonical term is **Evidence bundle**.
- "continue" duplicated Pi's session vocabulary. Resolved: Docket has **Save** and **Load**; Pi owns continuation.
