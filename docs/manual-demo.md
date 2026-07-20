# Manual demo: Shipyard release guard

This is a local, disposable visual test for Docket's normal worker loop plus versioned Deliverables and explicit handoffs.

It creates only `.docket-demo/`, which is ignored. It also sets `PI_CODING_AGENT_DIR` inside that directory, so it cannot read or alter your normal Docket workers, decisions, bundles, or sessions.

## What this proves

| Area | Observable result |
|---|---|
| Worker lifecycle | Spawn, dashboard, peek, tell, waiting, failure, retry/stop. |
| Deliverables | Every accepted `docket_done` creates immutable `deliverables/v<N>.json`. |
| Proposal review | One primary Markdown proposal opens in Report; revision notes produce a later version. |
| Patch review | Diff, Hunk/built-in fallback, conflict warning, and promotion use frozen patch bytes. |
| Approval | Approval changes no parent context and starts no work. |
| Use → Parent | One approved body becomes a chip for the next submitted parent prompt only. |
| Use → Worker | One human-confirmed fresh worker gets byte-exact reviewed input and provenance. |
| Bundles | Save/load remains separate from worker verdict and model context. |

## Prerequisites

- Node 22+, `git`, `tmux`, and an interactive `pi` with at least one configured model.
- Run from this repository checkout.
- Optional: `hunk` (`npm i -g hunkdiff`) for interactive Hunk review. Without it, Docket must open its built-in diff viewer.

## Create isolated fixture

Run this once from repository root. It is safe to rerun; it replaces only `.docket-demo/`.

```bash
ROOT="$(git rev-parse --show-toplevel)"
DEMO="$ROOT/.docket-demo"
APP="$DEMO/shipyard"

if tmux has-session -t docket-workers 2>/dev/null; then
  echo "Refusing: tmux session docket-workers already exists. Stop or isolate it first." >&2
  exit 1
fi

rm -rf "$DEMO"
mkdir -p "$APP/src" "$APP/test"

cat > "$APP/package.json" <<'EOF'
{
  "name": "shipyard-release-guard",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF

cat > "$APP/README.md" <<'EOF'
# Shipyard release guard

Shipyard selects a release region. Disabled regions must never receive a release,
even during an emergency. Unknown regions are operator errors.
EOF

cat > "$APP/src/release-plan.js" <<'EOF'
const REGIONS = {
  "us-east-1": { enabled: true, maintenance: false },
  "eu-west-1": { enabled: true, maintenance: true },
  "ap-south-1": { enabled: false, maintenance: false },
};

export function chooseReleaseRegion(requestedRegion, emergency = false) {
  const region = REGIONS[requestedRegion];
  if (!region) throw new Error(`Unknown release region: ${requestedRegion}`);

  // Intentional defect for Docket's worker-review demo:
  // emergency currently bypasses the disabled-region safeguard.
  if (!region.enabled && !emergency) {
    return { region: "us-east-1", reason: "disabled-region-fallback" };
  }

  if (region.maintenance && !emergency) {
    return { region: "us-east-1", reason: "maintenance-fallback" };
  }

  return { region: requestedRegion, reason: "requested-region" };
}
EOF

cat > "$APP/test/release-plan.test.js" <<'EOF'
import assert from "node:assert/strict";
import test from "node:test";
import { chooseReleaseRegion } from "../src/release-plan.js";

test("uses requested enabled region", () => {
  assert.deepEqual(chooseReleaseRegion("us-east-1"), {
    region: "us-east-1",
    reason: "requested-region",
  });
});

test("falls back from a disabled region during normal release", () => {
  assert.deepEqual(chooseReleaseRegion("ap-south-1"), {
    region: "us-east-1",
    reason: "disabled-region-fallback",
  });
});

test("never selects disabled region during emergency release", () => {
  assert.deepEqual(chooseReleaseRegion("ap-south-1", true), {
    region: "us-east-1",
    reason: "disabled-region-fallback",
  });
});

test("rejects unknown regions", () => {
  assert.throws(() => chooseReleaseRegion("moon-1"), /Unknown release region/);
});
EOF

git -C "$APP" init -q
git -C "$APP" config user.name "Docket demo"
git -C "$APP" config user.email "docket-demo@example.invalid"
git -C "$APP" add .
git -C "$APP" commit -q -m "chore: seed shipyard release guard"

export PI_CODING_AGENT_DIR="$DEMO/pi-agent"
cd "$APP"
npm test # expected: one failing emergency-release test
```

Keep `ROOT`, `DEMO`, `APP`, and `PI_CODING_AGENT_DIR` in same shell for rest of demo.

Start isolated parent Pi session:

```bash
pi --no-extensions -e "$ROOT/extensions/docket.ts"
```

Docket passes `PI_CODING_AGENT_DIR` explicitly into each tmux worker command. If you update Docket after spawning a worker, delete that worker and restart parent Pi before retrying; an already-running worker keeps its original launch environment.

## Scenario

**Shipyard** needs a release guard repaired. An expensive planner first proposes exact invariant and tests. Human reviews it, asks one revision, approves that exact version, then explicitly hands it to a fresh implementation worker. Human reviews frozen patch and promotes only after tests pass.

## Walkthrough

### 1. Baseline and worker visibility

Inside parent Pi:

```text
/docket help
/docket spawn --as scout Investigate Shipyard release selection. Read README.md, src/release-plan.js, and test/release-plan.test.js. Do not edit files. Explain why disabled ap-south-1 can be selected during an emergency. Produce a Markdown proposal with invariant, minimal implementation approach, and exact tests. Finish with docket_done using outcome proposal.
```

Expected:

1. `f8` shows one active worker.
2. Select worker, press `p`; pane shows live work without attaching.
3. Optionally steer it: `/docket tell w1 Keep scope limited to release selection and tests.`
4. Worker reaches `ready`; its row/card names one primary Deliverable, not several competing responses.

### 2. Proposal, Report, and immutable revision

1. Open ready worker verdict from `f8` or `/docket verdict w1`.
2. Press `r` for Report. Confirm full Markdown proposal, evidence, refs, and `v1`/Deliverable ref appear.
3. Choose **Request revision**. Enter:

   ```text
   State exact precedence between disabled and maintenance regions. Name every test case. Keep this a proposal; do not edit files.
   ```

4. Wait for new `docket_done`, then reopen Report. Confirm current card is `v2`; old `v1` body remains on disk.

Outside Pi:

```bash
find "$PI_CODING_AGENT_DIR/docket/workers" -path '*/deliverables/v*.json' -print
```

Open both files if present. `v1.json` must not change after `v2.json` exists.

### 3. Approval does nothing until Use

1. On current proposal card choose **Approve**.
2. Confirm worker becomes reviewed. No chip appears, no parent turn runs, no worker starts.
3. Reopen reviewed card. It now offers quiet `u Use`.
4. Press `u`, choose **Parent**.
5. Confirm one full chip appears above editor. Do not submit yet.
6. Confirm no parent response happened merely from approval or Use.
7. Either submit this prompt now, or leave chip queued for optional generation-binding check in 4a:

   ```text
   State approved Shipyard invariant in one sentence. Do not edit files or start workers.
   ```

   Expected: parent sees approved proposal only on this submitted prompt; chip clears after submit.

### 4. Use → Worker handoff

1. Reopen approved planner result and press `u` again.
2. Choose **Worker**.
3. Enter task:

   ```text
   Implement approved Shipyard proposal. Disabled regions must always fall back, including emergencies. Preserve maintenance fallback for non-emergency releases. Update tests and run npm test.
   ```

4. Select model and thinking level. Confirm screen must show task, chosen model, thinking, source Deliverable ref, and fresh-worker warning.
5. Confirm spawn. New worker starts independently; parent transcript is not seeded.
6. Inspect newest worker directory outside Pi:

   ```bash
   DEST="$(ls -td "$PI_CODING_AGENT_DIR/docket/workers"/*/ | head -n 1)"
   sed -n '1,120p' "$DEST/task.md"
   sed -n '1,20p' "$DEST/source-deliverable.md"
   ```

   Expected: `task.md` names reviewed source ref/version and `source-deliverable.md`; source body is present as task input.

Verify byte-exact source body and provenance:

```bash
node --input-type=module - "$PI_CODING_AGENT_DIR/docket/workers" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(root, entry.name);
  const statusFile = path.join(dir, "status.json");
  if (!fs.existsSync(statusFile)) continue;
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  const handoff = status.sourceHandoff;
  if (!handoff) continue;
  const sourceFile = path.join(root, handoff.sourceWorkerId, "deliverables", `v${handoff.sourceVersion}.json`);
  const source = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  const sidecar = fs.readFileSync(path.join(dir, "source-deliverable.md"), "utf8");
  console.log(`${entry.name}: ${sidecar === source.body ? "OK exact body" : "MISMATCH"}`);
  console.log(`  ${handoff.sourceRef} approved by ${handoff.approvingDecisionId}`);
}
NODE
```

Expected: `OK exact body`. After implementation worker finishes, its Report must include `Handoff source: ...` provenance.

### 4a. Optional generation-binding check

After both Use paths above, but before submitting any queued Parent chip, tell planner worker:

```text
/docket tell w1 Add one non-code v3 clarification to the proposal, then call docket_done with outcome proposal.
```

Expected:

1. Planner publishes `v3`; `v1` and `v2` sidecars remain unchanged.
2. Current `v3` verdict does **not** offer `u Use` until `v3` itself is approved.
3. Previously queued `v2` Parent chip remains queued and expands its already-approved body on next submit. It must not silently become `v3`.

### 5. Frozen patch review and promotion

1. Use `f8` to inspect implementation worker. If plan-gated, answer its `docket_wait` card before edits.
2. On ready result press `r`; confirm Deliverable version, test evidence, changed files, and handoff source.
3. Press `d` for full frozen diff. Edit worker workspace after this point only if deliberately testing frozen behavior; displayed patch must remain same Deliverable patch.
4. Press `h`:
   - With Hunk installed: review patch and optionally send comments.
   - Without Hunk: confirm install hint and built-in diff fallback.
5. For revision path, choose **Request revision** and require one extra test. New accepted done becomes next version; inspect `deliverables/v<N>.json` again.
6. For promotion path, choose **Promote** on current reviewed patch. Confirm Docket applies frozen patch only.
7. Outside Pi, verify parent workspace:

   ```bash
   cd "$APP"
   npm test
   git diff -- src/release-plan.js test/release-plan.test.js
   ```

Expected: all tests pass; only intended files differ from baseline.

### 6. General Docket checks

Run these after core scenario:

| Check | Action | Expected |
|---|---|---|
| Waiting path | Spawn scout with instruction to call `docket_wait` before deciding between two release policies. | Options/risk show on verdict; choosing option sends text only to worker. |
| Failure path | Spawn scout: `Run node missing-release-control.js, do not create files, then call docket_fail with exact error.` | Failed card and terminal-tail/peek evidence; Retry/Dismiss work. |
| Bundles | `/docket save shipyard release review`, then `/docket load last`. | Load mounts evidence at zero model context; chip only enters next submitted prompt. |
| Overlap | Start two patchers both assigned `src/release-plan.js`; stop before promotion. | Dashboard shows overlap warning; Docket asks before conflicting promotion. |
| Worker isolation | `/docket workers`, `p`, `/docket attach w<N>`, then `/docket attach parent` from worker. | Peek is read-only; attach/switch works without automatic context transfer. |

## Cleanup

Exit Pi, then remove only isolated demo state:

```bash
rm -rf "$DEMO"
```

If a demo worker remains visible in tmux, use `/docket delete w<N>` first or run `tmux kill-session -t docket-workers` only after confirming no non-demo Docket session exists.
