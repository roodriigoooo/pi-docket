import test from "node:test";
import assert from "node:assert/strict";
import { DOCK_GUTTER, dockColumns, dockEventSubLine, dockRowCells, dockRowsForRender, dockSettledLine, NEEDS_INPUT_AGING_WARN_MS, partitionDockRows, pickModelBadge, shortModelLabel, workerActivityRows, WORKER_SILENCE_WARN_MS } from "../extensions/worker-activity.js";
import type { WorkerStatus } from "../extensions/background-work.js";
import type { Artifact } from "../extensions/types.js";
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

test("a moved base outranks state hints and yields to an untaken message", () => {
	const now = Date.parse("2026-05-01T00:10:00.000Z");
	const stale = "base moved · 1 file it works on landed since it started";
	const queued = { id: "msg-1", kind: "directive" as const, from: "human" as const, body: "x", deliverAs: "steer" as const, createdAt: "2026-05-01T00:09:00.000Z", delivery: "queued" as const };

	// Above the state hints: those describe what a worker is doing, this describes whether what
	// it is doing still holds.
	assert.equal(dockEventSubLine([], "consulting", { now, staleLine: stale }), stale);
	assert.equal(dockEventSubLine([], "thinking", { now, staleLine: stale }), stale);
	// Below an untaken message: there the human already acted and nothing has happened yet.
	assert.equal(dockEventSubLine([], "thinking", { now, staleLine: stale, messages: [queued] }), "1 message queued · not taken yet");
	// And silent when nothing landed.
	assert.equal(dockEventSubLine([], "consulting", { now }), "asking the parent agent · escalates to you if unanswered");
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

function editArtifact(id: string, path: string): Artifact {
	return { id, displayId: id, ref: `file:${id}`, kind: "file", title: `edit ${path}`, subtitle: "", body: "", timestamp: 0, meta: { tool: "edit", args: { path } } };
}

test("a settled worker leaves the dock and the fold stands for it", () => {
	const reviewed = makeWorker({ id: "a", index: 1, state: "ended", updatedAt: "2026-05-01T00:00:00.000Z" });
	reviewed.reviewedAt = "2026-05-01T00:01:00.000Z";
	reviewed.artifactCount = 3;
	const stopped = makeWorker({ id: "b", index: 2, state: "ended" });
	stopped.artifactCount = 2;
	const ready = makeWorker({ id: "c", index: 3, state: "ready" });

	const dock = dockRowsForRender(workerActivityRows([reviewed, stopped, ready]));
	const { visible, settled } = partitionDockRows(dock);

	assert.deepEqual(visible.map((row) => row.label), ["w3"], "only the row with a decision left on it stays");
	assert.deepEqual(settled.map((row) => row.label).sort(), ["w1", "w2"]);
	assert.equal(dockSettledLine(settled.length), "2 settled · f8");
	assert.equal(dockSettledLine(0), undefined, "nothing folded says nothing");
});

test("a message the worker never took un-settles its row", () => {
	const now = Date.parse("2026-05-01T00:10:00.000Z");
	const reviewed = makeWorker({ id: "a", index: 1, state: "ended" });
	reviewed.reviewedAt = "2026-05-01T00:01:00.000Z";
	reviewed.artifactCount = 3;
	const queued = { id: "msg-1", kind: "directive" as const, from: "human" as const, body: "x", deliverAs: "steer" as const, createdAt: "2026-05-01T00:09:00.000Z", delivery: "queued" as const };

	const rows = workerActivityRows([reviewed], new Map(), { now });
	const quiet = dockRowsForRender(rows, { now });
	const holding = dockRowsForRender(rows, { now, messagesByWorker: new Map([[reviewed.id, [queued]]]) });

	assert.equal(quiet[0]!.settled, true);
	assert.equal(holding[0]!.settled, false, "the human acted and nothing happened: that is not settled");
});

test("a recorded verdict outranks an overlap warning and a moved base", () => {
	const now = Date.parse("2026-05-01T00:10:00.000Z");
	const reviewed = makeWorker({ id: "a", index: 1, state: "ended" });
	reviewed.reviewedAt = "2026-05-01T00:01:00.000Z";
	reviewed.artifactCount = 3;
	const peer = makeWorker({ id: "b", index: 2, state: "ready" });
	const artifacts = new Map<string, Artifact[]>([
		[reviewed.id, [editArtifact("a1", "src/api/limit.ts")]],
		[peer.id, [editArtifact("b1", "src/api/limit.ts")]],
	]);

	const rows = workerActivityRows([reviewed, peer], artifacts, { now });
	const stale = "base moved · 1 file it works on landed since it started";
	const dock = dockRowsForRender(rows, { now, staleLineByWorker: new Map([[reviewed.id, stale], [peer.id, stale]]) });
	const byLabel = new Map(dock.map((row) => [row.label, row]));

	assert.equal(byLabel.get("w1")!.progressLabel, "reviewed", "nothing left to warn about once the verdict is recorded");
	assert.match(byLabel.get("w2")!.progressLabel, /^overlap w1/, "the undecided peer still gets the warning");
	assert.equal(byLabel.get("w1")!.eventLine, undefined, "a moved base cannot change a decision already made");
	assert.equal(byLabel.get("w2")!.eventLine, stale);
});

test("dockColumns sizes every column to its widest cell", () => {
	const short = makeWorker({ id: "a", index: 1, state: "ready", kind: "scout" });
	const long = makeWorker({ id: "b", index: 2, state: "ready", kind: "implementer" });
	const dock = dockRowsForRender(workerActivityRows([short, long]));
	const columns = dockColumns(dock, 110);

	assert.equal(columns.label, "w2·implementer".length);
	assert.equal(columns.state, "ready".length);
	assert.equal(columns.chip, "f8 verdict".length);
	assert.equal(columns.task > 0, true);
	const spent = 2 + [columns.label, columns.state, columns.meta, columns.age, columns.chip].reduce((acc, c) => c > 0 ? acc + c + DOCK_GUTTER : acc, 0);
	assert.equal(spent + columns.task, 110, "columns and separators account for the full width");
});

test("dockColumns gives back the secondary columns first and the task last", () => {
	const worker = makeWorker({ id: "a", index: 1, state: "ready", kind: "implementer" });
	worker.todos = [{ id: "a", text: "read", state: "completed" }, { id: "b", text: "patch", state: "pending" }];
	const dock = dockRowsForRender(workerActivityRows([worker]));

	const wide = dockColumns(dock, 110);
	assert.equal(wide.meta > 0 && wide.state > 0 && wide.chip > 0, true, "everything fits with room to spare");
	assert.equal(dockColumns(dock, 60).meta, 0, "meta goes first");
	assert.equal(dockColumns(dock, 44).state, 0, "then the state word");
	assert.equal(dockColumns(dock, 36).chip, 0, "then the chip");
	// Below that only the label gives ground, and the task text never disappears: a bare `w1` is
	// never allowed to be the only handle on a row.
	const cramped = dockColumns(dock, 24);
	assert.equal(cramped.label, 5);
	assert.equal(cramped.task > 0, true);
});

test("dockRowCells keeps liveness and lifecycle in one cell each", () => {
	const gone = makeWorker({ id: "a", index: 1, state: "ready" });
	gone.paneCapturedAt = "2026-05-01T00:05:00.000Z";
	const dock = dockRowsForRender(workerActivityRows([gone]));

	assert.equal(dockRowCells(dock[0]!).state, "ready · gone");
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
