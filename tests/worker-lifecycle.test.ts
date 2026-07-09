import test from "node:test";
import assert from "node:assert/strict";
import type { WorkerStatus } from "../extensions/background-work.js";
import {
	deriveWorkerLifecycleState,
	heartbeatTransition,
	isPaneHarvestEligible,
	isRespawnEligible,
	parentReplyAcceptedTransition,
	processExitedTransition,
	pruneDisposition,
	protocolTransition,
	respawnFailedTransition,
	verdictResolvedTransition,
} from "../extensions/worker-lifecycle.js";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 1,
		tmuxSession: "docket-workers:w1",
		task: "test",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "active",
		...partial,
	};
}

test("heartbeat preserves terminal attention and reviewed state", () => {
	for (const state of ["needs_input", "ready", "failed", "error", "ended"] as const) {
		const current = worker({ state, reviewedAt: "2026-01-02T00:00:00.000Z" });
		const patch = heartbeatTransition({ pid: 42, artifactCount: 3 })(current)!;
		assert.equal(patch.state, state);
		assert.equal("reviewedAt" in patch, false);
	}
});

test("protocol and reply transitions resurface reviewed workers, heartbeat does not", () => {
	const reviewed = worker({ state: "ready", reviewedAt: "2026-01-02T00:00:00.000Z" });
	assert.equal(heartbeatTransition({ pid: 1, artifactCount: 0 })(reviewed)?.reviewedAt, undefined);
	assert.equal(protocolTransition("ready", "new result")(reviewed)?.reviewedAt, undefined);
	assert.equal(parentReplyAcceptedTransition(worker({ state: "needs_input" }))(worker({ state: "needs_input", reviewedAt: "x" }))?.reviewedAt, undefined);
});

test("a parent reply cannot overwrite a newer terminal protocol result", () => {
	const before = worker({ state: "needs_input", question: "ship?" });
	const afterDone = worker({ state: "ready", summary: "done" });
	assert.equal(parentReplyAcceptedTransition(before)(afterDone), undefined);
});

test("exit, harvest, respawn and retention policies agree on terminal states", () => {
	assert.equal(processExitedTransition(0)(worker({ state: "active" }))?.state, "ended");
	assert.equal(processExitedTransition(1)(worker({ state: "ready" })), undefined);
	assert.equal(isPaneHarvestEligible(worker({ state: "failed" })), true);
	assert.equal(isPaneHarvestEligible(worker({ state: "ready" })), false);
	assert.equal(isRespawnEligible(worker({ state: "failed" })), true);
	assert.equal(isRespawnEligible(worker({ state: "ready" })), false);
	const reviewed = worker({ state: "ready", reviewedAt: "2026-01-01T00:00:00.000Z" });
	assert.equal(deriveWorkerLifecycleState(reviewed), "reviewed");
	assert.equal(pruneDisposition(reviewed, Date.parse("2026-01-02T00:00:00.000Z"), 1, false), "prune-with-debt");
	assert.equal(pruneDisposition(reviewed, Date.parse("2026-01-02T00:00:00.000Z"), 1, true), "prune");
	assert.equal(respawnFailedTransition("launch failed")(worker({ state: "active" })), undefined);
	assert.equal(verdictResolvedTransition("2026-01-03T00:00:00.000Z")(worker({ state: "failed" }))?.reviewedAt, "2026-01-03T00:00:00.000Z");
});
