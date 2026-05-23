# 8-worker stress test

Measure parent CPU + RSS while 8 workers run. Confirms the dock + event-stream cost stays near idle.

## Why this matters

The shared tmux session + `fs.watch` + mtime cache + heartbeat dedup replace a 500 ms polling loop and N tmux servers. This protocol turns the promised win into a number.

## Prereqs

- `tmux` installed.
- `pi` on `$PATH`.
- Local build of Trail:
  ```bash
  pi --no-extensions -e ./extensions/trail.ts
  ```

## Procedure

1. **Start parent.** Terminal 1:
   ```bash
   pi --no-extensions -e ./extensions/trail.ts
   ```
2. **Capture parent PID.** Terminal 2:
   ```bash
   PARENT=$(pgrep -lf "pi.*extensions/trail.ts" | awk 'NR==1{print $1}')
   echo "$PARENT"
   ```
3. **Baseline (60 s, no workers).** Terminal 2:
   ```bash
   for i in $(seq 1 12); do
     ps -o %cpu=,rss= -p "$PARENT"
     sleep 5
   done | tee /tmp/trail-stress-baseline.log
   ```
4. **Spawn 8 workers.** In the parent pi session, run eight `/trail spawn` commands with short read-only tasks. Stagger them so they don't all start at the same instant:
   ```text
   /trail spawn --as scout list TypeScript imports in extensions/trail.ts
   /trail spawn --as scout count lines in extensions/background-work.ts
   /trail spawn --as scout list test files under tests/
   /trail spawn --as scout grep TODO in extensions
   /trail spawn --as scout list exports of extensions/worker-store.ts
   /trail spawn --as scout list exports of extensions/checkpoint-store.ts
   /trail spawn --as scout list exports of extensions/trail-navigator.ts
   /trail spawn --as scout list exports of extensions/worker-events.ts
   ```
5. **Sample under load (5 min).** Terminal 2:
   ```bash
   for i in $(seq 1 60); do
     ps -o %cpu=,rss= -p "$PARENT"
     sleep 5
   done | tee /tmp/trail-stress-load.log
   ```
6. **Idle hold (1 min).** After workers finish:
   ```bash
   for i in $(seq 1 12); do
     ps -o %cpu=,rss= -p "$PARENT"
     sleep 5
   done | tee /tmp/trail-stress-postload.log
   ```
7. **Cleanup.** In the parent: `/trail delete w1` … `/trail delete w8`, or wait for the 24 h prune.

## What to record

| Phase | cpu avg | cpu max | rss avg | rss max |
|---|---|---|---|---|
| baseline | … | … | … | … |
| load (8 active) | … | … | … | … |
| post-load (8 ended) | … | … | … | … |

Plus: node + os version, whether `fs.watch` recursive worked or fell back to polling.

## Expectation

Post-refactor, parent should idle at < 2 % CPU even with 8 active workers, with brief spikes during dock refresh ticks (debounced 150 ms after each `events.ndjson` append). RSS should climb only with worker count × event-buffer cap (16 events × N workers ≈ trivial).

If numbers don't match, file an issue with the three log files attached.
