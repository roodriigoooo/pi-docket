import test from "node:test";
import assert from "node:assert/strict";
import { dockRowsForRender, pickModelBadge, shortModelLabel, workerActivityRows } from "../extensions/worker-activity.js";
import type { WorkerStatus } from "../extensions/background-work.js";

function makeWorker(partial: Partial<WorkerStatus> & { id: string; index: number; state?: WorkerStatus["state"] }): WorkerStatus {
	return {
		id: partial.id,
		index: partial.index,
		tmuxSession: `trail-worker-${partial.id}`,
		task: partial.task ?? "demo task",
		cwd: partial.cwd ?? "/repo",
		createdAt: partial.createdAt ?? "2026-05-01T00:00:00.000Z",
		updatedAt: partial.updatedAt ?? "2026-05-01T00:00:00.000Z",
		state: partial.state ?? "active",
		...(partial.model ? { model: partial.model } : {}),
	};
}

test("shortModelLabel strips known provider prefixes", () => {
	assert.equal(shortModelLabel("claude-opus-4-7"), "opus-4-7");
	assert.equal(shortModelLabel("anthropic/claude-sonnet-4-6"), "sonnet-4-6");
	assert.equal(shortModelLabel("openai/gpt-5.2"), "gpt-5.2");
	assert.equal(shortModelLabel(undefined), undefined);
});

test("pickModelBadge hides when worker matches parent and all workers share model", () => {
	const w1 = makeWorker({ id: "a", index: 1, model: "claude-opus-4-7" });
	const w2 = makeWorker({ id: "b", index: 2, model: "claude-opus-4-7" });
	assert.equal(pickModelBadge(w1, [w1, w2], "claude-opus-4-7"), undefined);
});

test("pickModelBadge shows when worker model differs from parent", () => {
	const w1 = makeWorker({ id: "a", index: 1, model: "claude-sonnet-4-6" });
	assert.equal(pickModelBadge(w1, [w1], "claude-opus-4-7"), "sonnet-4-6");
});

test("pickModelBadge shows when workers vary even if matching parent", () => {
	const w1 = makeWorker({ id: "a", index: 1, model: "claude-opus-4-7" });
	const w2 = makeWorker({ id: "b", index: 2, model: "claude-sonnet-4-6" });
	assert.equal(pickModelBadge(w1, [w1, w2], "claude-opus-4-7"), "opus-4-7");
	assert.equal(pickModelBadge(w2, [w1, w2], "claude-opus-4-7"), "sonnet-4-6");
});

test("dockRowsForRender marks attention states accurately", () => {
	const waiting = makeWorker({ id: "a", index: 1, state: "needs_input" });
	const thinking = makeWorker({ id: "b", index: 2, state: "active" });
	const ready = makeWorker({ id: "c", index: 3, state: "ready" });
	const rows = workerActivityRows([waiting, thinking, ready]);
	const dock = dockRowsForRender(rows);
	const byLabel = new Map(dock.map((r) => [r.label, r]));
	assert.equal(byLabel.get("w1")!.attention, true);
	assert.equal(byLabel.get("w2")!.attention, false);
	assert.equal(byLabel.get("w3")!.attention, true);
	assert.equal(byLabel.get("w1")!.chip, "← reply");
	assert.equal(byLabel.get("w3")!.chip, "← review");
});
