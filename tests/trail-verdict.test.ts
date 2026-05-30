import test from "node:test";
import assert from "node:assert/strict";
import { diffBar, verdictVerbs, workerVerdictPayload } from "../extensions/trail.js";
import type { WorkerStatus } from "../extensions/worker-store.js";
import type { Artifact } from "../extensions/types.js";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 1,
		tmuxSession: "trail-workers:w1",
		task: "inspect auth",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "ready",
		...partial,
	};
}

const changeSet: Artifact = {
	id: "changes",
	displayId: "changes",
	ref: "worker-changes:worker-1:0",
	kind: "response",
	title: "w1 change set · 2 files",
	subtitle: "inspect auth",
	body: "diff omitted",
	timestamp: 1,
	meta: {
		workerChangeSet: true,
		changedFiles: [
			{ path: "src/auth.ts", additions: 8, deletions: 2 },
			{ path: "test/auth.test.ts", additions: 4, deletions: 1 },
		],
		hunkCount: 3,
	},
};

test("verdictVerbs adapts labels and semantics by state", () => {
	assert.deepEqual(verdictVerbs("needs_input", false).map((verb) => [verb.label, verb.description]), [
		["Accept", "approve · worker continues"],
		["Reject", "redirect · stays alive"],
		["Reject & stop", "kill worker + remove workspace"],
		["Chat", "type a reply"],
	]);
	assert.equal(verdictVerbs("failed", false)[0]?.label, "Retry");
	assert.match(verdictVerbs("ready", true)[0]?.description ?? "", /promote diff/);
	assert.match(verdictVerbs("ready", false)[0]?.description ?? "", /acknowledge/);
});

test("diffBar clamps width and proportions", () => {
	assert.equal(diffBar(0, 0, 4), "░░░░");
	assert.equal(diffBar(3, 1, 4), "███░");
	assert.equal(diffBar(1, 99, 4), "█░░░");
	assert.equal(diffBar(99, 1, 4), "███░");
	assert.equal(diffBar(1, 0, 0), "█");
});

test("workerVerdictPayload uses status fields for questions and failures", () => {
	const waiting = worker({ state: "needs_input", question: "Proceed with migration?" });
	assert.deepEqual(workerVerdictPayload(waiting).lines, ["Proceed with migration?"]);

	const failed = worker({ state: "failed", lastError: "npm test exited 1" });
	assert.deepEqual(workerVerdictPayload(failed).lines, ["npm test exited 1"]);
});

test("workerVerdictPayload summarizes deterministic change set metadata", () => {
	const payload = workerVerdictPayload(worker({ state: "ready" }), changeSet);
	assert.equal(payload.hasChangeSet, true);
	assert.equal(payload.additions, 12);
	assert.equal(payload.deletions, 3);
	assert.equal(payload.hunkCount, 3);
	assert.deepEqual(payload.lines, ["src/auth.ts   +8/-2", "test/auth.test.ts   +4/-1"]);
});
