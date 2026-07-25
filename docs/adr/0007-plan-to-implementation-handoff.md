# ADR-0007: Carry an approved plan into implementation

## Status

accepted

## Context

Planning first, then implementing, is a routine two-worker loop, and Docket handled it badly at exactly the seam between the two.

There were two ways to produce a plan and only one of them produced anything durable. A plan-gated worker presenting its plan through `docket_wait` left it in `question.text`: ephemeral, unversioned, unapprovable in a generation-bound way, and impossible to hand off. A worker publishing through `docket_done` with `outcome: proposal` produced a real Worker Deliverable. The built-in plan-gated `default` kind pushed users toward the first path, and nothing said so.

The handoff itself was kind-blind. `Use → Worker` resolved model, thinking, context, and workspace but never a kind, so every handoff worker landed on `worker.defaultKind` or the builtin `default` — plan-gated. Approving a plan and handing it off therefore produced a worker that immediately called `docket_wait` to ask for approval of a plan. The human answered the same question twice.

Nothing connected the two decisions afterwards. The implementation deliverable carried `sourceHandoff`, and Report printed one line of provenance, but no surface compared what the approved plan said with what the diff did.

The obvious-looking fix — make Plan a first-class artifact class — would fork Deliverable. Immutability, versioning, generation-bound approval, review notes, provenance, zero-token mounting, and the decision ledger all already exist there, and ADR-0001 → ADR-0005 records the cost of the last object that duplicated that vocabulary: bundles had to be demoted to compatibility-only data.

## Decision

A plan is a Worker Deliverable that proposes work rather than carrying it. Add no artifact class, store, slot prefix, decision verb, or top-level command. Make the *transition* first-class instead:

- **Plan contract** (`extensions/plan-contract.ts`, pure): Goal, Constraints, numbered Steps each optionally declaring `files:`, Verification, Risks. Markdown headings and bare `Plan:` label lines both parse. A body with no numbered step does not parse, and every consumer degrades to ordinary proposal behavior. The contract is a shape, never a schema, and is never validated at publish time.
- **Two bundled kinds.** `architect` is read-only, so it derives a shared workspace and costs no worktree; it is told to publish plans through `docket_done outcome: proposal`, never through `docket_wait`, and to write the whole plan in the same response that calls `docket_done` because only that body is frozen. `implementer` keeps `plan_gate: true` and scopes its rights to the files the approved plan names.
- **Implement handoff.** `Use` on an approved plan offers `Implement` ahead of `Parent` and `Worker`. It resolves the kind from `worker.implementKind` (default `implementer`), seeds the task from the plan's goal, and inherits parent execution, so the plan path costs one select, one prefilled editor, and the existing launch confirmation. `Worker` gains an explicit kind select and otherwise keeps choosing model and thinking by hand.
- **Plan gate discharge, not gate removal.** A gate is discharged only when a reviewed handoff supplies the plan and the human chose Implement. `task.md` then states which approval and which decision discharged it, instructs the worker to publish the plan's steps with `docket_todos`, and re-arms the gate for unnamed files, destructive or external writes, dependency changes, scope growth, and any step that proves wrong. `planAuthorized` without a source deliverable is ignored at both the command and store layers.
- **Plan coverage.** When a ready deliverable carries handoff provenance, the byte-exact launch sidecar is parsed at card-open time and the files the plan named are compared with the change set. The verdict card and Report show steps, planned-files-touched, off-plan, and untouched, colored as a warning when either drift figure is non-zero.

Docket does not restrict the parent's own tools during planning. Pi owns session and tool policy; a plan-mode extension composes with this because Docket only needs the resulting artifact.

## Consequences

Approval and use stay separate (ADR-0003): approving a plan starts nothing, and Implement remains a human action against one exact version. Generation-bound approval means a stale plan version cannot be implemented after a revision was requested.

The redundant second gate is gone without weakening the first: a worker that leaves the approved plan still has to stop and ask, and the ledger still shows which approval authorized the launch.

Plan coverage turns two disconnected decisions into one reviewable chain, at zero storage and zero model-context cost, because it is derived from data already on disk.

The cost is a shape convention that only pays off when plans follow it. That failure is soft everywhere: an unparseable plan still hands off, still discharges its gate, and still reviews — it just shows no coverage line and reads as a proposal.
