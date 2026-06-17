import test from "node:test";
import assert from "node:assert/strict";
import type { WorkerStatus } from "../extensions/background-work.js";
import type { Artifact } from "../extensions/types.js";
import { countWorkerRecommendations, projectWorkerArtifactReview, projectWorkerReview } from "../extensions/worker-review.js";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 1,
		tmuxSession: "docket-workers:w1",
		task: "review auth flow",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "ready",
		...partial,
	};
}

const status: Artifact = {
	id: "w1.status",
	displayId: "w1.status",
	ref: "worker-status:worker-1:0",
	kind: "response",
	title: "w1 ready",
	subtitle: "review auth flow",
	body: "worker: w1\nstate: ready\nmessage:\nstatus summary",
	meta: { workerId: "worker-1", workerStatus: "ready", workerLabel: "w1", summary: "status summary" },
};

test("projectWorkerReview prefers latest answer but keeps status semantics", () => {
	const response: Artifact = { id: "r1", displayId: "r1", ref: "response:1", kind: "response", title: "final answer", subtitle: "", body: "Final body", timestamp: 2 };
	const review = projectWorkerReview(worker({ summary: "worker summary" }), [status, response], 0);

	assert.equal(review.label, "w1");
	assert.equal(review.state, "ready");
	assert.equal(review.summary, "worker summary");
	assert.equal(review.result?.displayId, "r1");
	assert.equal(review.resultIsStatus, false);
	assert.match(review.summarySource ?? "", /final answer/);
});

test("projectWorkerReview surfaces active questions as primary summary", () => {
	const review = projectWorkerReview(worker({
		state: "needs_input",
		questions: [{ id: "q1", text: "Which migration order should I use?", createdAt: "2026-01-01T00:01:00.000Z" }],
	}), [status], 0);

	assert.equal(review.state, "needs_input");
	assert.equal(review.summary, "1. Which migration order should I use?");
	assert.equal(review.questions.length, 1);
});

test("recommendation parsing supports bullets and numeric summaries", () => {
	assert.equal(countWorkerRecommendations("Found 3 suggestions after reading README."), 3);
	assert.deepEqual(projectWorkerReview(worker({ summary: "Recommended:\n- do one\n- do two" }), [], 0).recommendations, ["do one", "do two"]);
});

test("projectWorkerArtifactReview extracts worker status summary and bullets", () => {
	const review = projectWorkerArtifactReview(status);

	assert.equal(review.status, "ready");
	assert.equal(review.label, "w1");
	assert.equal(review.summary, "status summary");
	assert.deepEqual(projectWorkerArtifactReview({
		...status,
		meta: { ...status.meta, summary: "Recommended:\n- keep evidence explicit\n- avoid auto-spawn" },
	}).recommendations, ["keep evidence explicit", "avoid auto-spawn"]);
});
