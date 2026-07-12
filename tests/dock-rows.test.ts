import test from "node:test";
import assert from "node:assert/strict";
import { dockEventSubLine, dockRowsForRender, NEEDS_INPUT_AGING_WARN_MS, pickModelBadge, shortModelLabel, workerActivityRows, WORKER_SILENCE_WARN_MS } from "../extensions/worker-activity.js";
import type { WorkerStatus } from "../extensions/background-work.js";
import type { WorkerEvent } from "../extensions/worker-events.js";

function makeWorker(partial: Partial<WorkerStatus> & { id: string; index: number; state?: WorkerStatus["state"] }): WorkerStatus {
	return {
		id: partial.id,
		index: partial.index,
		tmuxSession: `docket-worker-${partial.id}`,
		task: partial.task ?? "demo task",
		cwd: partial.cwd ?? "/repo",
		createdAt: partial.createdAt ?? "2026-05-01T00:00:00.000Z",
		updatedAt: partial.updatedAt ?? "2026-05-01T00:00:00.000Z",
		state: partial.state ?? "active",
		...(partial.model ? { model: partial.model } : {}),
		...(partial.kind ? { kind: partial.kind } : {}),
	};
}

test("shortModelLabel strips provider prefixes", () => {
	assert.equal(shortModelLabel("claude-opus-4-7"), "opus-4-7");
	assert.equal(shortModelLabel("anthropic/claude-sonnet-4-6"), "sonnet-4-6");
	assert.equal(shortModelLabel("openai/gpt-5.2"), "gpt-5.2");
	assert.equal(shortModelLabel("openai-codex/gpt-5.6-sol"), "gpt-5.6-sol");
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
	assert.equal(byLabel.get("w1")!.chip, "f8 verdict");
	assert.equal(byLabel.get("w3")!.chip, "f8 verdict");
});

function event(kind: WorkerEvent["kind"], payload: Record<string, unknown>): WorkerEvent {
	return { ts: Date.now(), kind, payload };
}

test("dockEventSubLine suppresses ordinary tool chatter when thinking", () => {
	const events: WorkerEvent[] = [
		event("tool", { tool: "docket_todos" }),
		event("tool", { tool: "read", target: "src/foo.ts" }),
		event("tool", { tool: "docket_wait" }),
	];
	assert.equal(dockEventSubLine(events, "thinking"), undefined);
});

test("dockEventSubLine suppresses ordinary progress chatter when thinking", () => {
	const events: WorkerEvent[] = [
		event("state", { state: "active" }),
		event("todo", { total: 5, completed: 2, inProgress: 1 }),
	];
	assert.equal(dockEventSubLine(events, "thinking"), undefined);
});

test("dockEventSubLine returns undefined for non-thinking states", () => {
	const events: WorkerEvent[] = [event("tool", { tool: "edit", target: "x" })];
	assert.equal(dockEventSubLine(events, "ready"), undefined);
	assert.equal(dockEventSubLine(events, "needs_input"), undefined);
	assert.equal(dockEventSubLine(events, "failed"), undefined);
});

test("dockEventSubLine warns on silent active workers", () => {
	const now = Date.parse("2026-05-01T00:10:00.000Z");
	const oldTool: WorkerEvent = { ts: now - WORKER_SILENCE_WARN_MS - 60_000, kind: "tool", payload: { tool: "read", target: "src/auth.ts" } };
	assert.equal(dockEventSubLine([oldTool], "thinking", { now }), "silent 6m · last tool: read src/auth.ts");
});

test("dockEventSubLine warns on old parent questions", () => {
	const now = Date.parse("2026-05-01T01:00:00.000Z");
	const waiting = makeWorker({ id: "wait", index: 4, state: "needs_input", updatedAt: new Date(now - NEEDS_INPUT_AGING_WARN_MS - 60_000).toISOString() });
	waiting.questions = [{ id: "q1", text: "Which path?", createdAt: new Date(now - NEEDS_INPUT_AGING_WARN_MS - 60_000).toISOString() }];
	assert.equal(dockEventSubLine(undefined, "needs_input", { now, worker: waiting }), "waiting 31m · reply, reject, or stop");
});

test("dockRowsForRender omits ordinary tool event lines", () => {
	const now = Date.now();
	const fresh = new Date(now).toISOString();
	const thinking = makeWorker({ id: "a", index: 1, state: "active", createdAt: fresh, updatedAt: fresh });
	const events = new Map<string, WorkerEvent[]>([
		["a", [event("tool", { tool: "edit", target: "src/bar.ts" })]],
	]);
	const rows = workerActivityRows([thinking], new Map(), { now });
	const dock = dockRowsForRender(rows, { eventsByWorker: events, now });
	assert.equal(dock[0]!.eventLine, undefined);
});

test("dockRowsForRender uses compact progress bars", () => {
	const worker = makeWorker({ id: "progress", index: 7, state: "active" });
	worker.todos = [
		{ id: "a", text: "read", state: "completed" },
		{ id: "b", text: "patch", state: "completed" },
		{ id: "c", text: "test", state: "pending" },
		{ id: "d", text: "docs", state: "pending" },
	];
	const rows = workerActivityRows([worker]);
	const dock = dockRowsForRender(rows);
	assert.equal(dock[0]!.progressLabel, "▰▰▱▱▱");
});

test("dockRowsForRender keeps loaded ready workers reviewable", () => {
	const ready = makeWorker({ id: "a", index: 1, state: "ready" });
	const rows = workerActivityRows([ready], new Map(), { explicitlyLoadedWorkerIds: new Set([ready.id]) });
	const dock = dockRowsForRender(rows);

	assert.equal(dock[0]!.attention, true);
	assert.equal(dock[0]!.loaded, true);
	assert.equal(dock[0]!.chip, "f8 verdict");
});

test("dockRowsForRender exposes kindLabel for non-default kinds", () => {
	const scout = makeWorker({ id: "a", index: 1, state: "active", kind: "scout" });
	const patcher = makeWorker({ id: "b", index: 2, state: "ready", kind: "patcher" });
	const defaultKind = makeWorker({ id: "c", index: 3, state: "active", kind: "default" });
	const noKind = makeWorker({ id: "d", index: 4, state: "active" });
	const rows = workerActivityRows([scout, patcher, defaultKind, noKind]);
	const dock = dockRowsForRender(rows);
	const byLabel = new Map(dock.map((r) => [r.label, r]));
	assert.equal(byLabel.get("w1")!.kindLabel, "scout");
	assert.equal(byLabel.get("w2")!.kindLabel, "patcher");
	assert.equal(byLabel.get("w3")!.kindLabel, undefined);
	assert.equal(byLabel.get("w4")!.kindLabel, undefined);
});
