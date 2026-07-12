import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkerTodos } from "../extensions/background-work.js";
import { workerResultArtifact, workerResultHeadline, workerResultReport, workerResultText } from "../extensions/worker-result.js";
import type { Artifact } from "../extensions/types.js";
import type { WorkerStatus } from "../extensions/worker-store.js";

const worker: WorkerStatus = {
	id: "worker-1",
	index: 1,
	tmuxSession: "docket-worker-1",
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
	assert.match(workerResultText(worker, [status]), /actions: \/docket load w1 · \/docket tell w1/);
});

test("Worker Result falls back to latest response artifact", () => {
	const response: Artifact = { id: "r1", displayId: "r1", ref: "response:1", kind: "response", title: "answer title", subtitle: "", body: "answer body", timestamp: 2 };
	assert.equal(workerResultArtifact({ ...worker, summary: undefined }, [response])?.displayId, "r1");
	assert.equal(workerResultHeadline({ ...worker, summary: undefined }, [response]), "answer title");
});

test("Worker Result report sections include outcome, recommendations, references, next", () => {
	const summary = "Suggested README improvements focused on command accuracy, onboarding, and navigation.\nRecommended:\n- Sync README commands with current behavior\n- Add a short quickstart near the top\n- Add a compact workflow-oriented table of contents";
	const ready: WorkerStatus = {
		...worker,
		task: "Improve main README",
		summary,
		todos: normalizeWorkerTodos([
			{ text: "Read README", state: "completed" },
			{ text: "Draft suggestions", state: "completed" },
		]),
	};
	const response: Artifact = { id: "r24", displayId: "r24", ref: "response:24", kind: "response", title: "ToC recommendation", subtitle: "", body: summary, timestamp: 24 };
	const code: Artifact = { id: "c25", displayId: "c25", ref: "code:25", kind: "code", title: "Markdown code block", subtitle: "", body: "```md\n# heading\n```", timestamp: 25 };
	const report = workerResultReport(ready, [status, response, code]);

	assert.equal(report.primarySection, "outcome");
	assert.equal(report.stateLabel, "ready");
	assert.equal(report.progressLine, "2/2 progress complete");
	assert.equal(report.changesLine, "none");
	assert.equal(report.recommendations.length, 3);
	assert.equal(report.recommendations[0], "Sync README commands with current behavior");
	assert.equal(report.references[0]?.displayId, "w1.r24");
	assert.equal(report.references[1]?.displayId, "w1.c25");
	assert.equal(report.nextActions[0]?.key, "Enter");
	assert.equal(report.nextActions.some((a) => a.key === "a"), false);
});

test("Worker Result report uses Question for needs_input state", () => {
	const blocked: WorkerStatus = {
		...worker,
		state: "needs_input",
		summary: undefined,
		question: "Which migration order should I use?",
		questions: [{ id: "q1", text: "Which migration order should I use?", createdAt: "2026-01-01T00:01:00.000Z" }],
	};
	const report = workerResultReport(blocked, [status]);
	assert.equal(report.primarySection, "question");
	assert.match(report.primaryBody, /Which migration order should I use\?/);
	assert.equal(report.stateLabel, "needs reply");
	assert.equal(report.nextActions[0]?.label, "tell");
});

test("Worker Result includes lightweight progress board", () => {
	const withTodos: WorkerStatus = {
		...worker,
		state: "active",
		summary: undefined,
		todos: normalizeWorkerTodos([
			{ text: "Inspect current dock", state: "completed" },
			{ text: "Render worker progress board", state: "in_progress" },
		]),
	};

	assert.equal(workerResultHeadline(withTodos), "1/2 · Render worker progress board");
	assert.match(workerResultText(withTodos), /progress:\nProgress \(1\/2\)/);
	assert.match(workerResultText(withTodos), /├ ✓ Inspect current dock/);
});
