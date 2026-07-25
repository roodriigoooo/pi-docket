# Docket extension

Docket exposes one slash command:

```text
/docket
```

Promise: **delegate safely without losing control.**

Primary subcommands:

- `/docket` — open decision docket.
- `/docket spawn [--model <provider/model>] [--thinking <level>] [--seed|--fresh] [--as <kind>] [--worktree] [--] <task>` — launch explicit worker in `docket-workers` (human-started only).
- `/docket tell w<N> [text]` — send parent input to worker.
- `/docket save [--from <artifact-ref|w<N>>]` — save an approved exact worker generation or author a deliverable interactively.
- `/docket load [deliverable:<id>:<version>|last|w<N>]` — mount a deliverable or worker artifacts at zero model-context cost.

Focused spawn examples:

```text
/docket spawn --as scout map auth call sites
/docket spawn --as patcher fix failing auth test
/docket spawn --model anthropic/claude-sonnet-4-6 --thinking high audit auth
```

Advanced subcommands (attach, verdict, workers lens, search, …) live in `/docket help advanced`.

Removed public aliases from the old Trail era are intentional: no `/trail`, no public checkpoint write command, no `continue`, no `resume`, no `ckpt`, no `r`, no `v`, no `ask`, no `result`, no bare `inject` alias. Contextual `s Save` and `u Use` are available in the navigator and verdict card.

## Worker substrate

Every worker is one independent ordinary window in single tmux session `docket-workers`. Docket records the stable worker pane and uses it for tell, peek, and harvesting; companions may add panes without redirecting those operations. Parent → worker stdin uses literal `send-keys` or bracketed paste so user text is preserved. Attach is the advanced troubleshooting escape hatch.

Kinds declare intent and authority. Execution resolves once per spawn: model/thinking inherit parent unless explicitly overridden, context defaults fresh, and workspace is shared for read-only kinds or isolated for writable kinds. Changed spend and legacy kind execution ask for confirmation in interactive mode. Noninteractive mode validates, announces, and launches without waiting.

Workers emit append-only NDJSON events to `workers/<id>/events.ndjson`. The parent watches the worker root with `fs.watch`, reads status/artifact files with mtime caching, and renders the dock without polling idle workers. Automatic parent updates are metadata only — worker summaries never enter the parent transcript until you open Report or attach evidence. `docket_todos` is a progress board, not a completion gate; `docket_done` is authoritative.

## Worker protocol

Workers coordinate with the parent through tools:

- `docket_todos`
- `docket_wait`
- `docket_done`
- `docket_fail`

Worker-side `/docket wait`, `/docket done`, and `/docket fail` are fallback prompt commands only.

## Deliverables: save vs load

`/docket save --from w<N>` copies the exact approved Worker Deliverable generation. `/docket save --from <artifact-ref>` edits selected bytes and asks for Proposal, Findings, or Completed. Bare `/docket save` opens the interactive source picker. Saves never append a Pi session marker or label the session leaf.

`/docket load` mounts a stored deliverable under a `d<N>` slot at zero model-context cost. Listing, previewing, and loading never queue a chip or start work. `u Use` sends the exact body to Parent on the next human submission or starts a fresh, confirmed Worker handoff. Existing bundles remain read-only compatibility data.

Use Pi's `/tree`, `/fork`, `/clone`, `/compact`, `/new`, and `/resume` for session topology.
