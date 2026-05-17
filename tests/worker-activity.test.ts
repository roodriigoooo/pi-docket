import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkerTodos, type WorkerStatus } from "../extensions/background-work.js";
import { workerActivityRows, workerActivityStackLines, workerActivityTotals } from "../extensions/worker-activity.js";
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
	title: "Found result handling bug",
	subtitle: "",
	body: "Status artifact was shown before latest answer.",
	timestamp: 2,
};

test("Worker Activity keeps all workers visible and prioritizes ready/open-todos", () => {
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
	assert.equal(rows[0]?.stateLabel, "ready · open todos");
	assert.equal(workerActivityTotals(rows).readyOpenTodos, 1);
	assert.match(lines.join("\n"), /w2\(\^_\?\) · ready · open todos · todos 1\/2 · reported answer/);
	assert.match(lines.join("\n"), /said: Found result handling bug/);
	assert.match(lines.join("\n"), /w3\(\^_\^\) · ready · complete/);
	assert.match(lines.join("\n"), /w1\(\._\.\) · active · inspect worker flow/);
	assert.doesNotMatch(lines.join("\n"), /also tracking/);
});
