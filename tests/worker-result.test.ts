import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkerTodos } from "../extensions/background-work.js";
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

test("Worker Result presents latest answer before status metadata", () => {
	const response: Artifact = { id: "r1", displayId: "r1", ref: "response:1", kind: "response", title: "final answer", subtitle: "", body: "Final answer body", timestamp: 2 };
	const text = workerResultText(worker, [status, response]);

	assert.equal(workerResultHeadline(worker, [status, response]), "mascot viable for subtle worker status");
	assert.equal(workerResultArtifact(worker, [status, response])?.displayId, "r1");
	assert.match(text, /answer:\nFinal answer body/);
	assert.match(text, /ref: @r1/);
	assert.doesNotMatch(text, /worker: w1/);
});

test("Worker Result falls back to status artifact when no answer exists", () => {
	assert.equal(workerResultArtifact(worker, [status])?.displayId, "w1.status");
	assert.match(workerResultText(worker, [status]), /actions: \/trail use w1 · \/trail ask w1/);
});

test("Worker Result falls back to latest response artifact", () => {
	const response: Artifact = { id: "r1", displayId: "r1", ref: "response:1", kind: "response", title: "answer title", subtitle: "", body: "answer body", timestamp: 2 };
	assert.equal(workerResultArtifact({ ...worker, summary: undefined }, [response])?.displayId, "r1");
	assert.equal(workerResultHeadline({ ...worker, summary: undefined }, [response]), "answer title");
});

test("Worker Result includes lightweight progress board", () => {
	const withTodos: WorkerStatus = {
		...worker,
		state: "active",
		summary: undefined,
		todos: normalizeWorkerTodos([
			{ text: "Inspect current dock", state: "completed" },
			{ text: "Render worker todo board", state: "in_progress" },
		]),
	};

	assert.equal(workerResultHeadline(withTodos), "1/2 · Render worker todo board");
	assert.match(workerResultText(withTodos), /progress:\nTodos \(1\/2\)/);
	assert.match(workerResultText(withTodos), /├ ✓ Inspect current dock/);
});
