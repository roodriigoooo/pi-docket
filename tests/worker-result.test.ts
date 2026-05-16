import test from "node:test";
import assert from "node:assert/strict";
import { workerResultArtifact, workerResultHeadline, workerResultText } from "../extensions/worker-result.js";
import type { Artifact } from "../extensions/types.js";
import type { WorkerStatus } from "../extensions/worker-store.js";

const worker: WorkerStatus = {
	id: "worker-1",
	index: 1,
	tmuxSession: "trail-worker-1",
	task: "assess mascot viability",
	cwd: "/repo",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	state: "ready",
	summary: "mascot viable for subtle worker status",
};

const status: Artifact = {
	id: "w1.status",
	displayId: "w1.status",
	ref: "worker-status:worker-1:0",
	kind: "response",
	title: "w1 ready",
	subtitle: "assess mascot viability",
	body: "worker: w1\nstate: ready\nmessage:\nmascot viable for subtle worker status",
	meta: { workerId: "worker-1", workerStatus: "ready" },
};

test("Worker Result prefers worker status artifact and summary", () => {
	assert.equal(workerResultHeadline(worker, [status]), "mascot viable for subtle worker status");
	assert.equal(workerResultArtifact(worker, [status])?.displayId, "w1.status");
	assert.match(workerResultText(worker, [status]), /ref: @w1\.status/);
});

test("Worker Result falls back to latest response artifact", () => {
	const response: Artifact = { id: "r1", displayId: "r1", ref: "response:1", kind: "response", title: "answer title", subtitle: "", body: "answer body", timestamp: 2 };
	assert.equal(workerResultArtifact({ ...worker, summary: undefined }, [response])?.displayId, "r1");
	assert.equal(workerResultHeadline({ ...worker, summary: undefined }, [response]), "answer title");
});
