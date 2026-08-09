# Docket

Docket is a decision queue for work done inside a Pi coding session. It pulls moments that need human judgment out of long agent work and shows them as cards. It is explicitly *not* a transcript browser, a memory system, a summarizer, or a session manager.

Pi owns session topology (`/tree`, `/fork`, `/clone`, `/compact`, `/new`, `/resume`). Docket owns attention, evidence, and explicit worker-parent coordination.

## Language

**Artifact**:
A structured object derived from session activity — a file edit, failed command, error, prompt, response, code block, worker status, or saved legacy-bundle/deliverable record.
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

**Message**:
One addressed, identified, durable unit moving between the parent and one Worker. Parent-bound messages travel the existing status/event path; worker-bound messages are written to that Worker's **Inbox** and claimed by its runtime. A Message is not an artifact class: it is evidence in the event stream and a file in the worker directory.
_Avoid_: ping, notification, chat, tell payload.

**Inbox**:
The durable per-worker mailbox at `workers/<id>/inbox/`. The parent writes; only that Worker's runtime claims. It survives a worker's death, so a message addressed to a worker that crashed is delivered after respawn.
_Avoid_: queue, channel, socket, buffer.

**Delivery state**:
What has actually been observed about one Message: `queued` (written, nothing else known), `delivered` (the worker's runtime took it), `read` (the worker's agent began a turn holding it), `undeliverable` (projected — queued, and the worker will not run again). Never inferred from a transport's exit status.
_Avoid_: sent, ok, acknowledged, received.

**Consult**:
A worker question addressed to the *parent agent* rather than the human, raised with `docket_consult`. It blocks the worker exactly like a question, and it is the only path that spends parent model context — so it is off by default. Not a separate worker state: a consult is a Question whose audience is the parent agent, which is why escalation is a field change and not a lifecycle move.
_Avoid_: auto-answer, delegation, agent reply.

**Question backlog**:
More than one open Question on the same Worker. Answered oldest first, because a Worker asks in the order it got stuck and anything it asked afterwards is usually downstream of the first answer it never got. Every surface states the count — the card marks which one it is answering, the dock row says how many — since a backlog nobody named reads as one question returning rephrased. Blocking ends the Worker's turn, so a backlog now only forms from questions a Worker genuinely holds at once, not from restatements.
_Avoid_: queue, repeat question, loop.

**Escalation**:
Handing a Consult back to the human, either because the parent agent declined or because the consult outlived its window. The question keeps its id and its place, so a reply still binds to it; only the audience changes.
_Avoid_: timeout, failure, fallback.

**Notice**:
Something a Worker shares with the parent without blocking, raised with `docket_note`. It is a Message in the worker's outbox and a review item in the parent, never a session message — a custom message participates in model context, and a notice is worker-authored content the human did not ask for. It may name suggested recipients; only the human sends it anywhere.
_Avoid_: log line, update, broadcast.

**Broadcast**:
One Message the human sends to several Workers at once, whether they wrote it or a Worker's Notice prompted it. Recipients are proposed from evidence Docket already holds and confirmed by a keypress; the message arrives without interrupting and never redirects the worker it reaches. There is no second concept for forwarding.
_Avoid_: relay, forward, fan-out, gossip.

**Bulletin**:
The standing project note every Worker re-reads before its first edit and at each plan gate. It lives outside the working copy, so workers in isolated worktrees all read the same current file. It is what Docket proposes when it cannot tell who is affected.
_Avoid_: broadcast log, shared memory, notes file.

**Standing**:
What a forwarded Worker claim is worth right now — `approved · promoted`, `in worktree, not promoted`, or `notice, unreviewed` — attached automatically to a Broadcast. Content is never restricted; provenance is what makes it safe to carry.
_Avoid_: confidence, trust level, status.

**Worker Kind**:
Task intent and authority declared by markdown: description, read-only posture, plan gate, decision rights, output guidance, and soft limits. Kind does not choose model, thinking, context, workspace, or tmux layout.
_Avoid_: execution preset, model profile, agent class.

**Worker Execution**:
One resolved launch policy: canonical model, effective thinking, parent-context choice, and workspace. Per-spawn choices are explicit; otherwise model/thinking inherit current parent state, context defaults fresh, and workspace derives from kind intent. Tmux layout is not part of core policy.
_Avoid_: kind, hidden defaults, routing profile.

**Worker Deliverable**:
Immutable primary output frozen when a worker's accepted `docket_done` reaches `ready`. Full body, refs, and optional patch live in `deliverables/v<N>.json`; status keeps its existing lifecycle/result projection plus the current `{ id, version, ref }` pointer.
_Avoid_: latest answer, worker result, live output.

**Deliverable Version**:
One accepted ready generation of a Worker Deliverable. `v1` never changes when a revision produces `v2`.
_Avoid_: edit, overwrite, current output.

**Plan deliverable**:
A Worker Deliverable that proposes work instead of carrying it: no frozen change set, and either `proposal` outcome or a body following the plan contract (Goal, Constraints, numbered Steps with `files:` clauses, Verification, Risks). It is a shape and a presentation, never a separate artifact class or store.
_Avoid_: plan artifact, plan record, spec object.

**Implement handoff**:
The Use destination offered only for an approved Plan deliverable. It selects the configured implement kind, seeds the task from the plan's goal, inherits parent execution, and carries the plan as the byte-exact sidecar. Still human-started and still confirmed.
_Avoid_: auto-implement, execute plan, run plan.

**Plan gate discharge**:
A plan gate resolved at launch because the human approved that exact Deliverable Version and started the worker to execute it. The gate is recorded as satisfied in `task.md` with the approving decision, and re-opens for anything the plan does not cover. Only a reviewed handoff can discharge one.
_Avoid_: skipped gate, disabled gate, trusted worker.

**Plan coverage**:
A derived comparison between the files an approved plan named and the files the resulting change set touched, shown on the verdict card and in Report. Read from the launch sidecar at card-open time; it stores nothing and records no decision.
_Avoid_: plan compliance, conformance check, plan lint.

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

**Deliverable**:
A durable immutable body saved with `/docket save`. A deliverable carries an outcome, evidence, recommendations, refs, optional frozen change set, source provenance, exact approval, and ordered generation-bound review notes. It does not move the Pi session.
_Avoid_: checkpoint, resume, summary, handoff doc.

**Legacy bundle**:
An older checkpoint-path artifact package. It remains listable, loadable, previewable, referenceable, injectable, unloadable, and deletable, but Docket never creates or converts one on the new-write path.
_Avoid_: checkpoint in user-facing copy.

**Parent authorship**:
The explicit interactive flow that edits the full selected artifact, chooses Proposal, Findings, or Completed, and creates a synthetic human approval. The returned bytes remain exact.
_Avoid_: inferred approval, automatic conversion.

**Mount**:
Pulling a deliverable into the navigator under a `d<N>` slot, or a legacy bundle under a `c<N>` slot, at **zero model-context tokens**. Nothing is chipped merely by listing, previewing, or loading.
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
Two Workers changed the same path in their isolated workspaces. Path-level, cheap, and recomputed on every dock render.
_Avoid_: conflict resolver, merge queue.

**Overlap grade**:
What a Worker overlap is actually worth, derived once when the human opens a promotion: `same file` (their changed line ranges do not meet), `adjacent` (within a few lines), `contested` (ranges intersect, or both create the file). Read from patches already frozen on disk, in the pre-image coordinates both Workers branched from. Where both sides have a patch, git is asked whether the other's still applies once this one lands — that is observed, not graded. A confirmation is owed unless separation was observed: an overlap Docket could not grade still asks, because "we could not tell" is not "they are apart".
_Avoid_: conflict severity, merge risk, auto-resolve.

**Overlap view**:
Both Workers' hunks for the paths they contest, each section headed by the Worker and its task. Reading only — two sections for one path is the situation, not a patch anyone applies. Reachable with `o` from the verdict card and from the promote confirmation. Its exit is one question about who yields, answered by sending nothing or by a revision request to one named Worker through the ordinary `tell` channel. It records no verdict and merges nothing.
_Avoid_: three-way merge, resolve, conflict editor.

**Decision ledger**:
The append-only record of every verdict you resolve, written to `decisions.ndjson`. Ready judgments include decision id and exact deliverable id/version/ref plus verb, review note or option, risk, and visible evidence refs. Read it with `/docket log decisions`.
_Avoid_: history, audit log, transcript.

**Decision debt**:
A terminal worker pruned with no verdict ever recorded against it. It aged out before anyone decided. Surfaced as "N workers evicted unreviewed this week" so unreviewed work stays visible instead of disappearing on prune.
_Avoid_: backlog, stale worker, orphan.

**Report**:
A user-opened, zero-context view of a ready worker's structured completion data and evidence metadata (full summary, recommendations, checks, changed files, refs). It is not a transcript, model summary, or context injection; closing it returns to the unresolved verdict without recording a decision.
_Avoid_: attach, inject, summary message, transcript dump.

**Project journal**:
The append-only project-level record every Worker re-reads at its gates: standing decisions (`standing`), Worker notices you chose to publish (`note`), and changes that have landed (`promoted`). It lives outside every worktree so all Workers read the same current file. The markdown a Worker reads is regenerated in full from the ndjson behind it; it is a view and is never read back as truth. Supersedes the **Bulletin**, which is now one entry kind within it.
_Avoid_: changelog, feed, inbox, broadcast log.

**Stale base**:
A derived fact that a Worker is building on files that have since landed under it. Scored from the same evidence a **Broadcast** is — a named path, a touched path, an approved plan's files — and only at `affected` strength. It is a modifier, not a lifecycle state: it rides alongside whatever the Worker is doing. It never wakes the Worker, never spends parent context, and never alters a workspace; the Worker reads it at a gate it already stops at, and the human sees it on the verdict card before approving a diff.
_Avoid_: conflict, drift, out of date, rebase needed.

**Liveness**:
Whether a Worker's process is still there, observed separately from what its work amounts to. `gone` is written by the side that saw it leave — session end, the exit trap, `kill`, a pane confirmed dead, or a heartbeat older than the gone window. Absence of proof is `unknown`, never `live`. A Worker can be **ready and gone**: its deliverable still stands, and nothing will read another message until it is respawned. Rendered as a hollow `○` in place of the filled dot.
_Avoid_: dead, offline, disconnected, healthy.

**Stopped**:
A Worker whose process ended without ever calling `docket_done`. It has evidence but no claim, so it is openable and never counted as attention: no colour, no chip, no `Outcome` section. Distinct from `failed` (it reported a failure) and from `ready` (it reported a result).
_Avoid_: cancelled, aborted, empty, done.

**Silence warning**:
A passive dock hint for a running worker with no recent tool/todo event, shown as `silent Nm`. It is not a kill switch. Peek or attach if you need live scrollback.
_Avoid_: deadman, timeout, auto-kill.

**Settled**:
A Worker whose decision is behind it — `reviewed` or `stopped`. It leaves the dock, which answers "is anything waiting on me", and lives in the `f8` dashboard, which answers "what is the whole fleet doing", behind one keypress. Not a lifecycle state and not a time-based hide: it is derived from the states that already exist. A Message the Worker never took un-settles it, because there the human acted and nothing has happened yet.
_Avoid_: archived, closed, done, hidden, dismissed.

**Save vs Load**:
**Save** writes an immutable deliverable from an approved exact worker generation or explicit parent authorship. **Load** mounts a deliverable or legacy bundle into the current Docket navigator. Neither appends a Pi session marker or replaces Pi's session commands.
_Avoid_: continue, resume, restore.

## Relationships

- A human starts each independent **Worker**. Workers expose only progress/wait/done/fail protocol tools and cannot create Workers.
- A **Worker Kind** states intent and authority; resolved **Worker Execution** states launch spend and isolation.
- A **Worker** starts from a **Pre-flight brief** and may be constrained by **Decision rights** or a **Plan gate**.
- A **Worker** produces **Artifacts** and one primary **Worker Deliverable** per accepted ready generation; supporting artifacts remain evidence.
- An **Approval** judges one **Deliverable Version**. **Use / Handoff** is separate and remains human-started.
- A **Plan deliverable** is a Worker Deliverable, not a new type; only an approved one offers the **Implement handoff**, and only that handoff produces a **Plan gate discharge**.
- **Plan coverage** compares an approved plan against the change set that claims to execute it. It is evidence on the verdict card, never a gate or a verdict of its own.
- A **Deliverable** freezes exact body bytes plus structured result data, source provenance, approval, and review history.
- **Save** = copy an approved worker generation or author selected content + write one immutable record.
- **Load** = **Mount** the deliverable under a `d<N>` slot at zero model-context cost.
- **Use** = explicitly queue the exact full body for the next parent submission or start a fresh confirmed worker.
- A resolved verdict appends to the **Decision ledger**; a terminal **Worker** pruned with no verdict becomes **Decision debt**.
- A **Message** carries one instruction or answer to a Worker, or one question from it. Every edge is Worker ↔ parent; there is no Worker → Worker channel.
- **Delivery state** is written only by the side that observed it. A reply naming a question resolves that question alone; an unbound reply is a redirection. A **Question backlog** drains oldest first, and every surface says how much is left.
- **Liveness** and lifecycle state are two facts, never folded into one. A Worker's exit is recorded as its own field and never overwrites what the Worker reported.
- A Message to a Worker that is **gone** is `undeliverable` on every surface that mentions it — starting with the chip the human was looking at when they sent it — and delivers on respawn.
- A promotion appends to the **Project journal** with no further authorization, because promotion is already a human act. Nothing else propagates automatically.
- **Stale base** is derived through the Broadcast scorer. There is one notion of "affected" in Docket, and it is not duplicated for a second caller.
- Each surface answers one question: the dock "is anything waiting on me", `f8` "what is the whole fleet doing", `/docket` "what needs a decision", `/docket verdict` resolves them. A **Settled** Worker therefore leaves the dock and stays in `f8`, and a recorded verdict outranks every warning on its row — neither an overlap nor a **Stale base** can change a decision already made.
- A **Consult** is answerable by the parent agent only while the human has enabled it; otherwise it is an ordinary Question. Either way the worker is told who answered.
- A **Notice** never changes a Worker's state and never enters parent model context.
- A **Broadcast** is proposed by Docket, confirmed by the human, and delivered without interrupting. It carries **Standing** and never answers a question a Worker is blocked on.
- Every Message edge is Worker ↔ parent. A Worker may name intended recipients on a Notice; only the human sends it.
- A **Progress board** is status visibility, not a decision; stale progress does not block `docket_done`.
- **Worker overlap** is surfaced to the parent before promotion; the parent remains the mediator. Its **Overlap grade** decides whether a confirmation is owed, and the confirmation states what promoting does to the other Worker — a **Stale base** the promotion is about to create.

## Example dialogue

> **Dev:** "When I `/docket load last`, does the assistant see file contents?"
> **Maintainer:** "No — Docket mounts a deliverable at zero tokens. The model sees nothing until you explicitly Use → Parent or chip an artifact with `/docket ref` or `/docket inject-full`."
> **Dev:** "Then how do I continue from older work?"
> **Maintainer:** "Use Pi for session movement: `/tree`, `/fork`, `/clone`, `/resume`, or `/compact`. Use Docket to carry evidence and decisions across those moves."

## Flagged ambiguities

- "checkpoint" made Docket sound like a session-resume feature. Resolved: canonical term is **Deliverable**; old bundles are compatibility-only.
- "continue" duplicated Pi's session vocabulary. Resolved: Docket has **Save**, **Load**, and explicit **Use**; Pi owns continuation.
- "plan" risked becoming a second artifact class beside Deliverable, forking versioning, approval, and storage for no new capability. Resolved: a plan is a **Plan deliverable** — a shape and a presentation — and the first-class addition is the *transition* (**Implement handoff**, **Plan gate discharge**, **Plan coverage**), not a new object.
- "tell" described a keystroke push as if it were a delivery, so every surface above it inherited an unverified claim. Resolved: **Message** with an observed **Delivery state**; the terminal transport remains for pre-mailbox workers and is labelled unconfirmed wherever it is reported.
- "plan mode" could have meant Docket restricting the parent's own tools. Resolved: out of scope. Pi owns session and tool policy; Docket owns the resulting artifact, its approval, and its handoff.
