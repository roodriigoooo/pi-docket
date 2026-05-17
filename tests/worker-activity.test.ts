import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkerTodos, type WorkerStatus } from "../extensions/background-work.js";
import { workerActivityPreviewLines, workerActivityRows, workerActivityStackLines, workerActivityTotals } from "../extensions/worker-activity.js";
import type { Artifact } from "../extensions/types.js";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 1,
		tmuxSession: "trail-worker-1",
		task: "inspect worker flow",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "active",
		...partial,
	};
}

const answer: Artifact = {
	id: "answer-1",
	displayId: "answer-1",
	ref: "response:1",
	kind: "response",
	title: "Found 3 suggestions",
	subtitle: "",
	body: "No files changed. Status artifact was shown before latest answer.",
	timestamp: 2,
};

test("Worker Activity keeps all workers visible as compact rows", () => {
	const readyOpen = worker({
		id: "ready-open",
		index: 2,
		state: "ready",
		summary: "reported answer",
		updatedAt: "2026-01-01T00:01:00.000Z",
		todos: normalizeWorkerTodos([
			{ text: "Inspect", state: "completed" },
			{ text: "Report", state: "pending" },
		]),
	});
	const ready = worker({ id: "ready", index: 3, state: "ready", summary: "complete", updatedAt: "2026-01-01T00:03:00.000Z" });
	const active = worker({ id: "active", index: 1, state: "active", updatedAt: "2026-01-01T00:04:00.000Z" });
	const rows = workerActivityRows([active, ready, readyOpen], new Map([["ready-open", [answer]]]), { now: 0 });
	const lines = workerActivityStackLines(rows).map((line) => line.text);

	assert.deepEqual(rows.map((row) => row.label), ["w2", "w3", "w1"]);
	assert.equal(rows[0]?.stateLabel, "ready/open todos");
	assert.equal(rows[0]?.outputLabel, "no changes · 3 suggestions");
	assert.equal(rows[0]?.actionHint, "press l to load");
	assert.equal(workerActivityTotals(rows).readyOpenTodos, 1);
	assert.match(lines.join("\n"), /w2\(\^_\?\) · ready\/open todos · todos 1\/2 · inspect worker flow · no changes · 3 suggestions · press l to load/);
	assert.match(lines.join("\n"), /w3\(\^_\^\) · ready · inspect worker flow · summary only · press l to load/);
	assert.match(lines.join("\n"), /w1\(\._\.\) · active · inspect worker flow · working · working/);
	assert.doesNotMatch(lines.join("\n"), /├|└|said:|also tracking/);
});

test("Worker Activity preview shows selected worker detail without dumping todos", () => {
	const row = workerActivityRows([
		worker({ state: "ready", summary: "Reviewed README and found improvements", todos: normalizeWorkerTodos([{ text: "Inspect", state: "completed" }]) }),
	], new Map([["worker-1", [answer]]]), { now: 0 })[0]!;
	const preview = workerActivityPreviewLines(row).join("\n");

	assert.match(preview, /w1 summary/);
	assert.match(preview, /Reviewed README and found improvements/);
	assert.match(preview, /Said: Found 3 suggestions/);
	assert.match(preview, /Progress: 1\/1 todos/);
	assert.match(preview, /Actions: Enter details · l load into prompt · c continue · a attach tmux · x stop/);
	assert.doesNotMatch(preview, /├|└/);
});
