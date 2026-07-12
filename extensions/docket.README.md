# Docket extension

Docket exposes one slash command:

```text
/docket
```

Promise: **delegate safely without losing control.**

Primary subcommands:

- `/docket` — open decision docket.
- `/docket spawn [--fresh] [--as <kind>] <task>` — launch an explicit worker in the `docket-workers` tmux session (user-initiated only).
- `/docket tell w<N> [text]` — send parent input to worker.
- `/docket save [--once] [--summarize] [note]` — save selected evidence as bundle and label current Pi tree leaf.
- `/docket load [id|last|w<N>]` — mount bundle or worker artifacts at zero model-context cost.

Focused spawn examples:

```text
/docket spawn --as scout map auth call sites
/docket spawn --as patcher fix failing auth test
```

Advanced subcommands (attach, verdict, workers lens, search, …) live in `/docket help advanced`.

Removed public aliases from the old Trail era are intentional: no `/trail`, no `checkpoint`, no `continue`, no `resume`, no `ckpt`, no `r`, no `s`, no `v`, no `ask`, no `result`, no `use`, no bare `inject` alias.

## Worker topology

Every worker is one window in a single tmux session named `docket-workers`. Parent → worker stdin uses `tmux send-keys -l` so user text is literal and does not trigger tmux keybindings.

Workers emit append-only NDJSON events to `workers/<id>/events.ndjson`. The parent watches the worker root with `fs.watch`, reads status/artifact files with mtime caching, and renders the dock without polling idle workers. Automatic parent updates are metadata only — worker summaries never enter the parent transcript until you open Report or attach evidence. `docket_todos` is a progress board, not a completion gate; `docket_done` is authoritative.

## Worker protocol

Workers coordinate with the parent through tools:

- `docket_todos`
- `docket_wait`
- `docket_done`
- `docket_fail`
- `docket_spawn_child`

Worker-side `/docket wait`, `/docket done`, and `/docket fail` are fallback prompt commands only.

## Save vs load

`/docket save` writes a deterministic orientation markdown file plus `<id>.artifacts.json`. It preserves evidence; it does not move the Pi session.

`/docket load` mounts bundle or worker artifacts into the current Docket navigator. Artifacts cost zero model-context tokens until attached with `/docket ref` or `/docket inject-full`. Loading a worker marks it `loaded` in the dock without resolving its verdict debt; only a verdict records judgment.

Use Pi's `/tree`, `/fork`, `/clone`, `/compact`, `/new`, and `/resume` for session topology.
