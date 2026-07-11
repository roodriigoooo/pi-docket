import test from "node:test";
import assert from "node:assert/strict";
import { automaticParentContentForWorkerEvent } from "../extensions/worker-parent-flow.js";
import type { WorkerEvent } from "../extensions/worker-events.js";
import type { WorkerStatus } from "../extensions/background-work.js";

function readyWorker(): WorkerStatus {
	return {
		id: "worker-1",
		index: 1,
		tmuxSession: "docket-workers:w1",
		task: "map auth",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "ready",
		summary: "Found 4 auth call sites.\n\nRecommended:\n- audit src/auth.ts",
		recommended: ["audit src/auth.ts"],
		outcome: "findings",
	};
}

function stateEvent(state: string): WorkerEvent {
	return {
		ts: "2026-01-01T00:00:00.000Z",
		kind: "state",
		payload: { state },
	};
}

test("ready worker events never produce automatic parent session content", () => {
	const worker = readyWorker();
	assert.equal(automaticParentContentForWorkerEvent(stateEvent("ready"), worker), undefined);
	assert.equal(automaticParentContentForWorkerEvent(stateEvent("ready_open_todos"), worker), undefined);
});

test("blocked worker events never produce automatic parent session content", () => {
	const worker = { ...readyWorker(), state: "needs_input" as const, summary: undefined, question: "Use postgres?" };
	assert.equal(automaticParentContentForWorkerEvent(stateEvent("needs_input"), worker), undefined);
});

test("legacy autoEmbedSummary: true still produces no parent session content", () => {
	const worker = readyWorker();
	assert.equal(automaticParentContentForWorkerEvent(stateEvent("ready"), worker, true), undefined);
	assert.equal(automaticParentContentForWorkerEvent(stateEvent("ready_open_todos"), worker, true), undefined);
	assert.equal(automaticParentContentForWorkerEvent(stateEvent("needs_input"), worker, true), undefined);
});
