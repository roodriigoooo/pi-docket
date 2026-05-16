import test from "node:test";
import assert from "node:assert/strict";
import { appendWorkerQuestionPatch, deriveWorkerState, namespaceWorkerArtifacts, workerHeartbeatPatch, workerProtocolPatch, workerProtocolResultText, workerQuestions, workerShortLabel, workerStatusArtifact, type WorkerQuestion, type WorkerStatus } from "../extensions/background-work.js";
import type { Artifact } from "../extensions/types.js";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 2,
		tmuxSession: "trail-worker-1",
		task: "inspect failing tests",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "active",
		...partial,
	};
}

function question(text: string): WorkerQuestion {
	return { id: `q-${text.length}`, text, createdAt: "2026-01-01T00:01:00.000Z" };
}

test("Background Work derives attention states", () => {
	assert.equal(deriveWorkerState(worker({ state: "needs_input" })), "needs_input");
	assert.equal(deriveWorkerState(worker({ state: "error" })), "failed");
	assert.equal(deriveWorkerState(worker({ state: "ended", artifactCount: 2 })), "ready");
	assert.equal(deriveWorkerState(worker({ state: "ended", artifactCount: 0 })), "empty");
	assert.equal(deriveWorkerState(worker({ state: "active", updatedAt: "2026-01-01T00:00:00.000Z" }), Date.parse("2026-01-01T00:02:00.000Z")), "stale");
});

test("Background Work appends protocol questions without losing legacy question", () => {
	const current = worker({ question: "First?" });
	const patch = appendWorkerQuestionPatch(current, "Second?", question("Second?"));

	assert.equal(patch?.state, "needs_input");
	assert.equal(patch?.question, "2 questions");
	assert.deepEqual(patch?.questions?.map((q) => q.text), ["First?", "Second?"]);
});

test("Background Work protocol patch clears questions for ready and failed states", () => {
	const current = worker({ state: "needs_input", questions: [question("Proceed?")], question: "Proceed?" });

	assert.deepEqual(workerProtocolPatch(current, "ready", "done", question("ignored")), {
		state: "ready",
		question: undefined,
		questions: [],
		summary: "done",
		lastError: undefined,
	});
	assert.equal(workerProtocolResultText("failed"), "Trail failure recorded. Parent can review the failure.");
});

test("Background Work heartbeat preserves sticky attention states", () => {
	assert.equal(workerHeartbeatPatch(worker({ state: "needs_input" }), { pid: 123, artifactCount: 4 }).state, "needs_input");
	assert.equal(workerHeartbeatPatch(worker({ state: "idle" }), { pid: 123, artifactCount: 4 }).state, "active");
});

test("Background Work projects worker status into synthetic Review Artifact", () => {
	const status = worker({ state: "needs_input", questions: [question("Choose target?")], updatedAt: "2026-01-01T00:01:00.000Z" });
	const artifact = workerStatusArtifact(status);

	assert.equal(artifact?.ref, "worker-status:worker-1:0");
	assert.equal(artifact?.kind, "response");
	assert.equal(artifact?.meta?.workerStatus, "needs_input");
	assert.match(artifact?.title ?? "", /w2 needs input/);
});

test("Background Work namespaces worker artifacts by worker label", () => {
	const artifact: Artifact = { id: "a1", displayId: "a1", ref: "command:1", kind: "command", title: "npm test", subtitle: "", body: "", timestamp: 1 };
	assert.deepEqual(namespaceWorkerArtifacts(worker(), [artifact]).map((item) => [item.id, item.displayId, item.source]), [["w2.a1", "w2.a1", "w2"]]);
	assert.equal(workerShortLabel(2), "w2");
	assert.deepEqual(workerQuestions(worker({ question: "Legacy?" })).map((q) => q.text), ["Legacy?"]);
});
