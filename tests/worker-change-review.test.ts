import test from "node:test";
import assert from "node:assert/strict";
import type { WorkerStatus } from "../extensions/background-work.js";
import type { Artifact } from "../extensions/types.js";
import { reviewWorkerChangeSet, type WorkerChangeReviewDeps } from "../extensions/worker-change-review.js";

const worker: WorkerStatus = {
	id: "worker-1",
	index: 1,
	tmuxSession: "docket-workers:w1",
	task: "review patch",
	cwd: "/repo",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	state: "ready",
};

const changeSet: Artifact = {
	id: "changes",
	displayId: "changes",
	ref: "worker-changes:worker-1:0",
	kind: "response",
	title: "w1 change set",
	subtitle: "review patch",
	body: "worker: w1\n\nPatch:\ndiff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new",
	timestamp: 1,
	meta: { workerChangeSet: true, workerId: "worker-1" },
};

function harness(overrides: Partial<WorkerChangeReviewDeps> = {}) {
	const calls: string[] = [];
	const deps: WorkerChangeReviewDeps = {
		showBuiltinDiff: async (reviewWorker, reviewedChangeSet) => { calls.push(`builtin:${reviewWorker.id}:${reviewedChangeSet.ref}`); },
		reviewInHunk: async (reviewWorker, reviewedChangeSet) => {
			calls.push(`hunk:${reviewWorker.id}:${reviewedChangeSet.body}`);
			return { available: true, comments: [] };
		},
		chooseAction: async () => "ignore",
		sendToWorker: async (reviewWorker, text) => { calls.push(`send:${reviewWorker.id}:${text}`); },
		copyText: async (text) => { calls.push(`copy:${text}`); return true; },
		notify: (text, level) => { calls.push(`notify:${level}:${text}`); },
		...overrides,
	};
	return { deps, calls };
}

test("builtin review receives the exact deterministic change set", async () => {
	const { deps, calls } = harness();

	const outcome = await reviewWorkerChangeSet(deps, worker, changeSet, { preferred: "builtin" });

	assert.deepEqual(outcome, { kind: "returned" });
	assert.deepEqual(calls, ["builtin:worker-1:worker-changes:worker-1:0"]);
});

test("Hunk review receives the exact deterministic change set", async () => {
	const { deps, calls } = harness();

	await reviewWorkerChangeSet(deps, worker, changeSet, { preferred: "hunk" });

	assert.equal(calls[0], `hunk:worker-1:${changeSet.body}`);
});

test("missing or failed Hunk falls back to builtin diff", async () => {
	for (const result of [
		{ available: false as const, comments: [] as [], message: "Hunk not found" },
		{ available: true as const, comments: [] as [], message: "Hunk review failed" },
	]) {
		const { deps, calls } = harness({ reviewInHunk: async () => result });

		const outcome = await reviewWorkerChangeSet(deps, worker, changeSet, { preferred: "hunk" });

		assert.deepEqual(outcome, { kind: "returned" });
		assert.deepEqual(calls, [`notify:warning:${result.message}`, "builtin:worker-1:worker-changes:worker-1:0"]);
	}
});

test("send delivers comments only to the reviewed worker", async () => {
	const { deps, calls } = harness({
		reviewInHunk: async () => ({ available: true, comments: [{ filePath: "x", newLine: 2, summary: "tighten this" }] }),
		chooseAction: async () => "send",
	});

	const outcome = await reviewWorkerChangeSet(deps, worker, changeSet, { preferred: "hunk" });

	assert.deepEqual(outcome, { kind: "comments-sent", commentCount: 1 });
	assert.match(calls[0] ?? "", /^send:worker-1:revise from Hunk review \(1 comment\):/);
});

test("failed Hunk comment delivery records no sent outcome", async () => {
	const { deps } = harness({
		reviewInHunk: async () => ({ available: true, comments: [{ filePath: "x", summary: "tighten this" }] }),
		chooseAction: async () => "send",
		sendToWorker: async () => false,
	});

	const outcome = await reviewWorkerChangeSet(deps, worker, changeSet, { preferred: "hunk" });

	assert.deepEqual(outcome, { kind: "returned" });
});

test("copy and ignore return to the verdict card without delivery", async () => {
	for (const action of ["copy", "ignore"] as const) {
		const { deps, calls } = harness({
			reviewInHunk: async () => ({ available: true, comments: [{ filePath: "x", summary: "tighten this" }] }),
			chooseAction: async () => action,
		});

		const outcome = await reviewWorkerChangeSet(deps, worker, changeSet, { preferred: "hunk" });

		assert.deepEqual(outcome, { kind: "returned" });
		assert.equal(calls.some((call) => call.startsWith("send:")), false);
		assert.equal(calls.some((call) => call.startsWith("copy:")), action === "copy");
	}
});

test("no comments returns cleanly without delivery", async () => {
	const { deps, calls } = harness();

	const outcome = await reviewWorkerChangeSet(deps, worker, changeSet, { preferred: "hunk" });

	assert.deepEqual(outcome, { kind: "returned" });
	assert.deepEqual(calls.slice(1), ["notify:info:Hunk review completed with no comments."]);
});
