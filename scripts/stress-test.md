# 8-worker stress test protocol

Measure parent CPU and RSS while 8 workers run, so we know the dock + event-stream cost is real.

## Why this matters

The work in `feat/dock-perf-and-calm-ui` replaced a 500 ms polling loop with `fs.watch` + an mtime cache, deduped heartbeats, and folded N tmux servers into one. The promised win is "parent stays near idle even with 5+ workers." This protocol turns that promise into a number.

## Prereqs

- `tmux` installed.
- `pi` (the coding agent CLI) installed and on `$PATH`.
- This branch (or `main` after merge) is what `pi` will pick up. From this repo:
  ```bash
  pi --no-extensions -e ./extensions/trail.ts
  ```
  Run that to enter a pi session with the local Trail build.

## Procedure

1. **Start a parent pi session.** In one terminal:
   ```bash
   pi --no-extensions -e ./extensions/trail.ts
   ```
2. **Capture parent PID.** In a second terminal:
   ```bash
   pgrep -lf "pi.*extensions/trail.ts" | head -1
   ```
   Note the PID. Call it `$PARENT`.
3. **Baseline (no workers).** In the second terminal:
   ```bash
   node scripts/sample-process.mjs $PARENT 60 5 | tee /tmp/trail-stress-baseline.log
   ```
   60 s baseline. Parent should be near 0 % CPU.
4. **Spawn 8 workers.** In the parent pi session, run eight `/trail spawn` commands. Use realistic short tasks (read-only is fine — we want activity, not output quality). Stagger them so they don't all hit `agent_start` at the same instant:
   ```text
   /trail spawn list TypeScript imports in extensions/trail.ts
   /trail spawn count lines in extensions/background-work.ts
   /trail spawn list test files under tests/
   /trail spawn grep TODO in extensions
   /trail spawn list exports of extensions/worker-store.ts
   /trail spawn list exports of extensions/checkpoint-store.ts
   /trail spawn list exports of extensions/trail-navigator.ts
   /trail spawn list exports of extensions/worker-events.ts
   ```
5. **Sample under load.** Once all 8 dock rows appear and at least half are actively running, in the second terminal:
   ```bash
   node scripts/sample-process.mjs $PARENT 300 5 | tee /tmp/trail-stress-load.log
   ```
   5 minutes, 5 s interval = 60 samples.
6. **Idle hold.** When workers finish (rows show `ready` / `ended`), sample another minute:
   ```bash
   node scripts/sample-process.mjs $PARENT 60 5 | tee /tmp/trail-stress-postload.log
   ```
   Auto-eviction won't fire yet (default `dockIdleHideMinutes` is 30) but the dock should be steady.
7. **Cleanup.** In the parent session, `/trail delete w1` … `/trail delete w8` (or wait for the 24h prune).

## What to record

Paste these summary lines into `docs/stress-test-results.md`:

- baseline: `cpu avg=…  max=…  rss avg=… MB  max=… MB`
- load (8 active workers): `cpu avg=…  max=…  rss avg=… MB  max=… MB`
- post-load (8 ended workers, dock still rendering them): `cpu avg=…  max=…  rss avg=…  max=…`
- node + os version
- whether `fs.watch` recursive worked (mac default) or fell back to polling

## Expectation

Pre-refactor baseline (500 ms timer + N reads × N workers × 2 Hz) at 5 workers was visibly sluggish — CPU was the user-perceived signal. Post-refactor, the parent should idle at < 2 % CPU even with 8 workers, with brief spikes during dock refresh ticks (debounced 150 ms). RSS should grow only with worker count × event-buffer cap (16 events × 8 workers = trivial).

Numbers should match those rough bounds. If they don't, file an issue with the three log files attached.
