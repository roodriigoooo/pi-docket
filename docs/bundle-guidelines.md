# Deliverable guidelines

Docket deliverables preserve approved work for a later decision. They are not transcript archives and they do not replace Pi's session commands.

Use Pi for session movement:

- `/tree`
- `/fork`
- `/clone`
- `/compact`
- `/new`
- `/resume`

Use Docket deliverables for durable work:

- `/docket save --from w<N>` — copy the exact approved Worker Deliverable generation.
- `/docket save --from <artifact-ref>` — edit selected artifact content and author an outcome.
- `/docket save` — open the interactive source picker and author a parent deliverable.
- `/docket load` — mount a record at zero model-context cost.
- `u Use` — queue the exact body for the parent or start a fresh, human-confirmed worker.
- `/docket ref` / `/docket inject-full` — attach explicitly selected artifacts or deliverable bodies only when needed.

## Principles

- Preserve decision-critical evidence: the exact body, outcome, findings, evidence statements, artifact references, recommendations, and optional frozen change set.
- Keep worker saves generation-bound. Only an exact approved terminal generation may be saved; stale, rejected, ready-only, missing, or corrupt generations must fail without replacing data.
- Treat parent authorship as explicit human approval. Select the outcome interactively, preserve edited bytes exactly, and require non-empty content.
- Separate facts from hypotheses. Do not present guesses, unknowns, or stale plans as decisions.
- Prefer artifact references over duplicated prose when the reference itself is sufficient.
- Keep handoff provenance: source session/cwd and the exact approval decision belong in the record, not in a new Pi session marker.
- Loading, listing, and previewing are zero-context inspection. They never queue a chip or start work.

## Immutable shape

Records live at `~/.pi/agent/docket/deliverables/<safe-id>/v<N>.json`. A worker-backed record retains the Worker Deliverable pointer and worker generation facts; a parent-authored v1 receives a timestamp-plus-entropy identity and synthetic human-authorship approval. Public references are `deliverable:<id>:<version>`.

The store uses a per-deliverable lock and atomic version claim. A claimed version is never overwritten, including when its file is corrupt. Re-saving the same worker generation is idempotent; concurrent saves claim the version safely.

## Legacy bundles

Old checkpoint/bundle files remain readable for list, load, preview, unload, and delete. They are never converted, and the new save path never writes checkpoint directories, the legacy index, or the legacy event log. Legacy bundle artifacts remain explicitly referenceable and injectable, but they cannot use the reviewed-deliverable handoff action.
