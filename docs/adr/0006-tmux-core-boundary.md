# ADR-0006: Keep tmux behind a narrow core boundary

## Status

accepted

## Context

Docket needs tmux for durable worker PTYs, visibility, literal input, bounded inspection, attach/return, and post-mortem tails. Optional split panes, terminal pipes, status-line rendering, and pane logs made those core operations depend on operator layout choices and gave companions no safe extension seam.

## Decision

Core Docket creates one ordinary window per worker in one shared session, enables remain-on-exit, and persists both the stable tmux window ID and the worker pane ID. Tell, multiline paste, peek, dead-pane probing, and harvesting target the recorded pane first; window/name fallback is retained only for legacy status without a pane ID. Attach/return intentionally selects the ordinary worker window as the troubleshooting trapdoor. Companion-created panes cannot redirect input or evidence capture.

The extension surface exposes one exclusive `globalThis.__docket.registerTmuxAdapter(adapter)` registration. After spawn and respawn IDs are persisted, Docket dispatches the adapter with worker/window/pane metadata and the events file without awaiting it. Adapter exceptions are warned and isolated; slow or stalled adapters cannot delay, roll back, or fail a worker launch. `onWorkerEvent` remains the ongoing fleet-activity seam.

Legacy layout declarations are recognized only to emit `layout ignored; operator layouts moved out of core.` Removed tmux configuration keys are diagnosed once and ignored. Core no longer creates split windows, uses `pipe-pane`, writes `status-right`, or creates `pane.log`.

## Consequences

Worker lifecycle reliability and target selection belong to Docket. Operator dashboards and advanced layouts can be implemented as companions without becoming hidden lifecycle dependencies. Attach and direct tmux inspection remain discoverable troubleshooting escapes, while normal coordination stays in Docket's visible worker surface.
