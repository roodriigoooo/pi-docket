import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkerTodos, type WorkerStatus } from "../extensions/background-work.js";
import { workerActivityPreviewLines, workerActivityRows, workerActivityStackLines, workerActivityTotals } from "../extensions/worker-activity.js";
import type { Artifact } from "../extensions/types.js";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 1,
		tmuxSession: "docket-worker-1",
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

	assert.deepEqual(rows.map((row) => row.label), ["w3", "w2", "w1"]);
	const w2 = rows.find((row) => row.label === "w2")!;
	assert.equal(w2.stateLabel, "ready");
	assert.equal(w2.outputLabel, "3 recs · no files · 1/2 progress");
	assert.equal(w2.actionHint, "press l to load");
	assert.equal(workerActivityTotals(rows).readyOpenTodos, 0);
	assert.equal(workerActivityTotals(rows).ready, 2);
	assert.match(lines.join("\n"), /w2\(\^_\^\) · ready · progress 1\/2 · inspect worker flow · 3 recs · no files · 1\/2 progress · press l to load/);
	assert.match(lines.join("\n"), /w3\(\^_\^\) · ready · inspect worker flow · summary only · press l to load/);
	assert.match(lines.join("\n"), /w1 · active · inspect worker flow · working · working/);
	assert.doesNotMatch(lines.join("\n"), /├|└|said:|also tracking/);
});

test("Worker Activity result column standardizes to recs · files · progress", () => {
	const fileEdit: Artifact = { id: "f1", displayId: "f1", ref: "file:1", kind: "file", title: "src/auth.ts", subtitle: "", body: "+", timestamp: 1, meta: { tool: "edit", diff: "+ line" } };
	const fileRead: Artifact = { id: "f2", displayId: "f2", ref: "file:2", kind: "file", title: "README.md", subtitle: "", body: "", timestamp: 2, meta: { tool: "read" } };
	const cmd: Artifact = { id: "c1", displayId: "c1", ref: "cmd:1", kind: "command", title: "npm test", subtitle: "", body: "", timestamp: 3 };
	const row = workerActivityRows([
		worker({ state: "ready", summary: "Recommended:\n- bullet a\n- bullet b\n- bullet c", todos: normalizeWorkerTodos([{ text: "Inspect", state: "completed" }]) }),
	], new Map([["worker-1", [fileEdit, fileRead, cmd]]]), { now: 0 })[0]!;

	assert.equal(row.recommendations, 3);
	assert.equal(row.filesChanged, 1);
	assert.equal(row.outputLabel, "3 recs · 1 file changed · 1/1 progress");
	assert.equal(row.evidence.reads, 1);
	assert.equal(row.evidence.commands, 1);
	assert.equal(row.evidence.edits, 1);

	const preview = workerActivityPreviewLines(row).join("\n");
	assert.match(preview, /1 reads · 1 commands · 1 edits · 1\/1 progress/);
	assert.match(preview, /Files: src\/auth\.ts, README\.md/);
});

test("Worker Activity preview shows Outcome, Evidence, Next actions", () => {
	const row = workerActivityRows([
		worker({ state: "ready", summary: "Reviewed README and found improvements", todos: normalizeWorkerTodos([{ text: "Inspect", state: "completed" }]) }),
	], new Map([["worker-1", [answer]]]), { now: 0 })[0]!;
	const preview = workerActivityPreviewLines(row).join("\n");

	assert.match(preview, /^Outcome$/m);
	assert.match(preview, /Reviewed README and found improvements/);
	assert.match(preview, /^Evidence$/m);
	assert.match(preview, /1\/1 progress/);
	assert.match(preview, /^Next actions$/m);
	assert.match(preview, /\[Enter Review answer\] \[p Peek\] \[l Load summary\] \[c Continue\] \[a Attach tmux\] \[x Dismiss\]/);
	assert.doesNotMatch(preview, /├|└|Actions:/);
});

test("Worker Activity marks explicitly loaded ready workers as non-attention", () => {
	const ready = worker({ state: "ready", summary: "Reviewed README and found improvements" });
	const rows = workerActivityRows([ready], new Map([[ready.id, [answer]]]), { now: 0, loadedWorkerIds: new Set([ready.id]) });
	const totals = workerActivityTotals(rows);
	const preview = workerActivityPreviewLines(rows[0]!).join("\n");

	assert.equal(rows[0]?.loaded, true);
	assert.equal(rows[0]?.outputLabel, "loaded");
	assert.equal(totals.loaded, 1);
	assert.equal(totals.ready, 0);
	assert.match(preview, /\[Enter Details\] \[p Peek\] \[l Loaded\]/);
});
