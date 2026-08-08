# ADR-0008: Make worker messaging a durable, attributed channel

## Status

accepted

## Context

Docket's stated ownership is "attention, evidence, and explicit worker-parent coordination." The first two are well served. The third is not: Docket has one and a half channels, and the halves are not the same shape.

**Worker → parent is a real channel.** A worker publishes through `status.json` and `events.ndjson`: structured, disk-backed, watched with `fs.watch`, mtime-cached, survives a parent restart. `WorkerQuestion` already carries an id, a timestamp, optional `risk`, `options`, and `recommend`. The parent projects it into a dock row and a verdict card at zero model-context cost.

**Parent → worker is not a channel.** It is keystroke injection into a PTY (`worker-store.ts:562` → `sendKeysToWindow`). The consequences are specific, not stylistic:

1. **The acknowledgement is false.** `sendInput` treats a zero exit status from `tmux send-keys` as proof of receipt and immediately applies `parentReplyAcceptedTransition`, clearing `needs_input` (`worker-store.ts:568-571`). The worker is recorded as answered before it has observed a single byte. `worker-commands.ts` then announces `told w<N>`. Every layer above inherits a claim no layer below verified.
2. **Messages have no identity.** A tell produces no id, so nothing can be threaded, acknowledged, deduplicated, replayed, or audited. `events.ndjson` — the spine of every live surface — is one-directional; the parent's own sends never appear in it.
3. **Answers cannot bind to questions.** `formatWorkerTell` inlines every pending question into the reply text, and the reply clears all of them. With two open questions and one answer, the second is silently marked resolved.
4. **Timing is unmanaged.** Keystrokes race the worker's editor state. A message sent mid-turn can split a bracketed paste, land in a partially composed buffer, or submit at a moment the worker's agent loop did not choose.
5. **A dead or restarted worker loses everything addressed to it.** There is no queue, so there is nothing to redeliver.

Meanwhile the worker's only voice is `docket_wait`, which halts it. In a single-worker session that is correct and sufficient. In a fleet it converts every ambiguity into a stall, and it gives a worker no way to report something the rest of the fleet needs to know without also stopping.

The result is that parallel work degrades into parallel isolation. Two workers discover the same fact independently; a decision made in one worker's session never reaches the four workers it invalidates; the human becomes the only transport, at exactly the moment the human is least able to be one.

Fixing this touches two invariants, and the risk is that a coordination layer erodes them silently:

- **Metadata-only parent flow.** `worker-parent-flow.ts` hard-returns `undefined` so worker content never enters the parent transcript automatically. Any mechanism where the parent *agent* answers a worker must read that worker's words, which spends parent context.
- **Human decides.** Any mechanism where one worker's claim reaches another worker inserts an unreviewed premise into work the human has not inspected.

Neither invariant should be weakened by accident, and neither should be defended so rigidly that the fleet stays mute.

## Decision

Introduce **Message** as the unit of worker-parent coordination, delivered over a durable mailbox, with a permission line drawn exactly on the model-context boundary. Add no artifact class, no second store, and no new session topology.

### 1. A Message is durable, identified, and observed

A Message is one addressed unit moving between the parent and one worker. Parent-bound messages continue to use the existing status/event path. Worker-bound messages get the channel they never had:

```
workers/<id>/inbox/msg-<epochMs>-<rand>.json
```

The parent writes; the worker's Docket runtime watches its own inbox, delivers the body into its session through pi's native `sendUserMessage(text, { deliverAs })`, and rewrites the file with the observed delivery state. Both sides append `message` events to `events.ndjson`, which makes the event stream bidirectional and gives every live surface a single source of truth it already knows how to read.

`deliverAs` is not decoration. It is the reason this transport replaces keystrokes:

| Mode | Lands | Used for |
|---|---|---|
| `steer` | after the current turn's tool calls, before the next LLM call | replies and directives — the default |
| `followUp` | once the worker's agent has no more tool calls | messages that must not interrupt a run |
| `nextTurn` | queued for the next prompt, interrupts nothing | broadcasts (P2) |

Delivery state is **observed, never assumed**:

| State | Meaning |
|---|---|
| `queued` | written to the inbox; nothing else is known |
| `delivered` | the worker's runtime read the file and handed it to its session |
| `read` | the worker's agent began a turn holding it |
| `undeliverable` | the worker is terminal and no runtime will consume it |

`tmux send-keys` is retained as the fallback transport for workers whose runtime predates the mailbox, and for direct-to-pane escape hatches. Fallback sends are labelled as best-effort in every surface that reports them, because that is what they are. The tmux boundary of ADR-0006 is unaffected: the mailbox lives in the worker directory, not the pane, and a companion adapter still cannot redirect it.

Because a message is a file in the worker directory, a message addressed to a worker whose process died survives the death and is delivered on respawn. That falls out of the design rather than being built.

Replies bind to what they answer. A message carrying `replyTo: <questionId>` resolves that question and no other; remaining questions stay open, stay visible, and keep the worker in `needs_input`.

**A Message is not an Artifact class.** ADR-0005 and ADR-0007 record the cost of duplicating an object's vocabulary; messages are evidence in the event stream and files in the worker directory, surfaced through pi's existing rendering. Nothing about immutability, versioning, approval, or the decision ledger forks.

### 2. The permission line is the model-context boundary

Which messages may flow without per-message human authorization is not a matter of taste. It follows the invariant that already exists:

| Message | Direction | Authorization | Rationale |
|---|---|---|---|
| **question** (`docket_wait`) | worker → parent | none required | metadata only — produces a card and a dock row, spends no parent context |
| **notice** (`docket_note`) | worker → parent | none required | metadata only — produces a chip, spends no parent context |
| **consult** | worker → parent | explicit opt-in, off by default | the parent agent must read the question, which spends parent context |
| **directive**, **answer** | parent → worker | human-initiated by construction | there is no automatic path |
| **broadcast** | parent → workers | human-confirmed per send | fan-out carries one worker's claim into another's premises |

The free lane is free *precisely because it remains metadata-only*. `worker-parent-flow.ts` keeps returning `undefined`; a question or a notice reaches the human as a surface, never as transcript. The gate on consult is therefore not a policy preference layered on top of the architecture — it is the architecture, made visible at the point where a mechanism would otherwise cross it.

### 3. Consult: blocking, fast, escalating, attributed, off by default

`docket_consult` is for questions the parent agent can answer from its own context — which file the project settled on, what a sibling worker concluded, whether a convention was already decided. It does not replace `docket_wait`, which remains the only path for anything irreversible, authority-changing, or scope-changing.

- **It blocks.** A non-blocking consult is incoherent: the worker races its own answer, and preventing it from passing the dependent step would require a gate machine Docket does not need. The worker enters `consulting` — a state distinct from `needs_input`, because "waiting on the parent agent" and "waiting on you" are different facts and must read differently in the dock.
- **It is fast, or it stops being a consult.** The parent answers within a bounded window. On timeout the consult escalates to an ordinary human question card, and the worker is told it was escalated. Blocking costs nothing when the answer arrives in seconds, and the failure mode is the behaviour Docket already has.
- **It degrades cleanly.** With the opt-in off, a consult is presented to the human as a question. The feature therefore has no failure mode worse than current Docket.
- **The parent agent can decline.** It answers or it escalates. It is never forced to produce an answer it does not have, because an invented answer is worse than a delayed one.
- **Attribution is carried into the worker.** The worker sees `[docket · parent agent]`, never `[docket · from you]`. A worker that mistakes a model's guess for a human decision will build on it with authority the decision never had. This is the single most consequential rule in this ADR.
- **It is recorded.** The exchange appends to `decisions.ndjson` with `actor: "parent-agent"`, so `/docket log decisions` answers "who decided this" and not merely "what was decided".

The exchange surfaces in the parent as a **pi tool call**, rendered by Docket — collapsed to one line, expanded with the platform's own control. Docket does not invent a chip format where pi already has one.

### 4. Broadcast: human-confirmed, evidence-scored, provenance-carrying

**Broadcast** is the single noun for one message reaching several workers, whether the human wrote it or a worker's notice prompted it. There is no second concept for forwarding.

- **Recipients are proposed from evidence Docket already computes**, not typed by the human. Edited-path overlap (`worker-conflicts.ts`), files named by an approved plan (`plan-contract.ts`), identifier matches against worker artifacts, and task-text overlap, in that order of strength. Candidates resolve into **affected** (preselected, with the reason shown), **maybe** (listed, unselected, with the reason shown), and **unrelated** (folded away).
- **The human is never asked to resolve an identifier.** Every row carries the worker's task text and its kind. `w3` is never the only handle offered, because a human returning to a session cannot be expected to remember which index is doing which job.
- **Uncertainty degrades to the calm path.** When nothing scores as affected, Docket proposes the **bulletin** — a standing project note every worker re-reads at its next gate — rather than presenting a checkbox grid and calling that a choice. Zero interrupts, the information still lands, and it survives worker restarts.
- **Content is not restricted; provenance is carried.** "Code is ready" is a legitimate broadcast. Docket appends what it knows about the claim's standing — `deliverable v2 · approved · promoted`, or `in worktree, not promoted`, or `notice, unreviewed` — so the receiving worker can weigh it. Truthfulness is achieved by rendering a fact, not by forbidding a sentence.
- **Human confirmation plus attribution is the safety property.** A broadcast is not sent without a human keypress, and it arrives labelled with its origin worker and standing. Given both, requiring the source to be an approved deliverable would buy little and cost the speed that motivates the feature.
- **Addressed broadcast** replaces a worker-to-worker edge. A notice may name intended recipients; those are preselected and tagged as addressed. The human still confirms. The worker gets to express intent instead of shouting, and the topology does not change.

### 5. Topology is unchanged

Every edge remains worker ↔ parent. There is no worker-to-worker channel, no message routing that bypasses the parent, and no change to ADR-0004's flat, human-started worker model. The parent is the only router, which is what keeps the decision ledger linear and the human in the position Docket exists to keep them in.

## Consequences

Delivery becomes a fact rather than an assumption. Every surface that reports on a message reports what was observed, and the states are distinguishable, so a queued message to a busy worker and a delivered message to an idle one no longer look identical. The false acknowledgement in `sendInput` is removed rather than papered over.

Multi-question workers become answerable. Binding a reply to a question id turns the verdict card from a form that clears everything into one that resolves one decision at a time, which is what the card claimed to be.

The parent gains a bounded, opt-in way to answer on the human's behalf, and pays for it in exactly one place — parent model context — with the cost visible, attributed, logged, and revocable. The metadata-only rule survives intact for every path the human did not enable.

The fleet gains a way to share a fact without the human acting as transport, at the cost of one keypress and with the origin and standing of every claim attached to it.

The costs are real and worth naming. There is a new durable file class in the worker directory to write, watch, and prune. There is a capability negotiation between parent and worker runtimes for as long as pre-mailbox workers may still be running. Consult introduces a per-worker blocking state whose latency is now Docket's responsibility. Broadcast scoring is a heuristic, and a heuristic that proposes badly will be trusted for a while before it is corrected — which is why every proposal shows its reason, and why the human confirms.

Rejected alternatives: making the parent poll worker panes for structure (fragile, and it re-couples core operations to layout, against ADR-0006); giving workers a direct addressing channel (breaks the flat topology and the linear ledger); making consult non-blocking (unenforceable); and restricting broadcast content to reviewed material (slower, and solved better by carrying provenance).
