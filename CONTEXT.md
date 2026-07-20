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
A human-started background Pi process running as one independent window in the shared `docket-workers` tmux session. Generates artifacts that may become review items. Workers cannot create other Workers.
_Avoid_: job, agent, subprocess, child worker.

**Worker Kind**:
Task intent and authority declared by markdown: description, read-only posture, plan gate, decision rights, output guidance, and soft limits. Kind does not normally choose model, thinking, context, workspace, or tmux layout.
_Avoid_: execution preset, model profile, agent class.

**Worker Execution**:
One resolved launch policy: canonical model, effective thinking, parent-context choice, workspace, and compatibility-only layout. Per-spawn choices are explicit; otherwise model/thinking inherit current parent state, context defaults fresh, and workspace derives from kind intent.
_Avoid_: kind, hidden defaults, routing profile.

**Worker Deliverable**:
Immutable primary output frozen when a worker's accepted `docket_done` reaches `ready`. Full body, refs, and optional patch live in `deliverables/v<N>.json`; status keeps its existing lifecycle/result projection plus the current `{ id, version, ref }` pointer.
_Avoid_: latest answer, worker result, live output.

**Deliverable Version**:
One accepted ready generation of a Worker Deliverable. `v1` never changes when a revision produces `v2`.
_Avoid_: edit, overwrite, current output.

**Approval**:
A generation-bound verdict accepting one exact Deliverable Version. It never injects context or starts work; patch promotion remains an explicit verdict action.
_Avoid_: use, handoff, auto-promote.

**Review Note**:
A multiline human revision request bound to one Deliverable Version and written to the Decision ledger. It never edits immutable deliverable body.
_Avoid_: annotation, patch to result.

**Use / Handoff**:
A separate human action available after Approval. Use → Parent queues one full immutable-deliverable chip for next human prompt. Use → Worker starts one fresh worker with reviewed sidecar input. Neither action records another verdict or changes worker lifecycle.
_Avoid_: approve and send, auto-chain, inject on ready.

**Handoff Provenance**:
Structured source deliverable ref/version, source Worker, approving decision, timestamp, and destination sidecar path carried into a handoff worker and its later Deliverable.
_Avoid_: transcript seed, inherited authority.

**Pre-flight brief**:
The top section of a worker's `task.md`: task, kind, workspace, decision rights, plan gate, and optional reviewed handoff source. It gives the worker authority boundaries before it starts.
_Avoid_: prompt summary, system prompt, hidden policy.

**Decision rights**:
The concrete actions a worker is allowed to take for this task or kind. Example: read-only discovery, local checks, or scoped edits after approval.
_Avoid_: permissions, role, capabilities.

**Plan gate**:
An opt-in worker rule that allows read-only discovery, then requires `docket_wait` before the first edit or mutating command. The parent approves or redirects through the verdict card.
_Avoid_: approval workflow, checkpoint, blocker.

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

**Terminal tail**:
The last lines of a worker's tmux pane, captured by the parent after the worker process died. Saved as `pane-tail.txt` in the worker directory; surfaced as a `command` artifact in review and on the failed verdict card.
_Avoid_: crash log, dump.

**Peek**:
A read-only snapshot of a worker's live tmux pane rendered inside the parent TUI (press `p` in the workers dashboard). Observation without attaching; never enters model context.
_Avoid_: attach, monitor, tail.

**Progress board**:
The small ordered checklist a Worker publishes with `docket_todos`. It is parent visibility only; `docket_done` is the completion signal.
_Avoid_: task manager, acceptance gate.

**Worker overlap**:
A warning that two Workers edited the same path in their isolated workspaces. Docket surfaces overlap and asks before promotion; it does not lock files or auto-merge.
_Avoid_: conflict resolver, merge queue.

**Decision ledger**:
The append-only record of every verdict you resolve, written to `decisions.ndjson`. Ready judgments include decision id and exact deliverable id/version/ref plus verb, review note or option, risk, and visible evidence refs. Read it with `/docket log decisions`.
_Avoid_: history, audit log, transcript.

**Decision debt**:
A terminal worker pruned with no verdict ever recorded against it. It aged out before anyone decided. Surfaced as "N workers evicted unreviewed this week" so unreviewed work stays visible instead of disappearing on prune.
_Avoid_: backlog, stale worker, orphan.

**Report**:
A user-opened, zero-context view of a ready worker's structured completion data and evidence metadata (full summary, recommendations, checks, changed files, refs). It is not a transcript, model summary, or context injection; closing it returns to the unresolved verdict without recording a decision.
_Avoid_: attach, inject, summary message, transcript dump.

**Silence warning**:
A passive dock hint for a running worker with no recent tool/todo event, shown as `silent Nm`. It is not a kill switch. Peek or attach if you need live scrollback.
_Avoid_: deadman, timeout, auto-kill.

**Save vs Load**:
**Save** creates an evidence bundle and labels the current Pi tree leaf. **Load** mounts a bundle or worker artifacts into the current Docket navigator. Neither replaces Pi's session commands.
_Avoid_: continue, resume, restore.

## Relationships

- A human starts each independent **Worker**. Workers expose only progress/wait/done/fail protocol tools and cannot create Workers.
- A **Worker Kind** states intent and authority; resolved **Worker Execution** states launch spend and isolation.
- A **Worker** starts from a **Pre-flight brief** and may be constrained by **Decision rights** or a **Plan gate**.
- A **Worker** produces **Artifacts** and one primary **Worker Deliverable** per accepted ready generation; supporting artifacts remain evidence.
- An **Approval** judges one **Deliverable Version**. **Use / Handoff** is separate and remains human-started.
- An **Evidence bundle** freezes selected **Artifacts** plus an **Orientation header**.
- **Save** = choose artifacts + write bundle + label current Pi tree leaf.
- **Load** = **Mount** the bundle into the current session.
- A model summary is optional `--summarize` polish on top of a bundle, never the bundle's definition.
- A resolved verdict appends to the **Decision ledger**; a terminal **Worker** pruned with no verdict becomes **Decision debt**.
- A **Progress board** is status visibility, not a decision; stale progress does not block `docket_done`.
- **Worker overlap** is surfaced to the parent before promotion; the parent remains the mediator.

## Example dialogue

> **Dev:** "When I `/docket load last`, does the assistant see file contents?"
> **Maintainer:** "No — Docket mounts bundle artifacts at zero tokens. The model sees nothing until you chip an artifact with `/docket ref` or `/docket inject-full`."
> **Dev:** "Then how do I continue from older work?"
> **Maintainer:** "Use Pi for session movement: `/tree`, `/fork`, `/clone`, `/resume`, or `/compact`. Use Docket to carry evidence and decisions across those moves."

## Flagged ambiguities

- "checkpoint" made Docket sound like a session-resume feature. Resolved: canonical term is **Evidence bundle**.
- "continue" duplicated Pi's session vocabulary. Resolved: Docket has **Save** and **Load**; Pi owns continuation.
