import test from "node:test";
import assert from "node:assert/strict";
import { dockIdleHideMs, isDockIdleEvictable, pruneAfterMs, selectPrunableWorkers, shouldPruneWorker } from "../extensions/worker-eviction.js";
import type { WorkerStatus } from "../extensions/background-work.js";

function makeWorker(partial: Partial<WorkerStatus> & { id: string; state: WorkerStatus["state"]; updatedAt: string }): WorkerStatus {
	return {
		id: partial.id,
		index: partial.index ?? 1,
		tmuxSession: partial.tmuxSession ?? `trail-workers:w${partial.index ?? 1}`,
		task: partial.task ?? "demo",
		cwd: partial.cwd ?? "/repo",
		createdAt: partial.createdAt ?? partial.updatedAt,
		updatedAt: partial.updatedAt,
		state: partial.state,
	};
}

test("dockIdleHideMs / pruneAfterMs parse config correctly", () => {
	assert.equal(dockIdleHideMs({ dockIdleHideMinutes: 30 }), 30 * 60_000);
	assert.equal(dockIdleHideMs({ dockIdleHideMinutes: 0 }), 0);
	assert.equal(dockIdleHideMs(undefined), 0);
	assert.equal(pruneAfterMs({ pruneAfterHours: 24 }), 24 * 3_600_000);
	assert.equal(pruneAfterMs({ pruneAfterHours: -1 }), 0);
});

test("isDockIdleEvictable only fires on ended workers past the hide window", () => {
	const now = Date.now();
	const hideMs = 30 * 60_000;
	const oldEnded = makeWorker({ id: "a", state: "ended", updatedAt: new Date(now - hideMs - 1000).toISOString() });
	const freshEnded = makeWorker({ id: "b", state: "ended", updatedAt: new Date(now - 1000).toISOString() });
	const oldReady = makeWorker({ id: "c", state: "ready", updatedAt: new Date(now - hideMs - 1000).toISOString() });
	const oldFailed = makeWorker({ id: "d", state: "failed", updatedAt: new Date(now - hideMs - 1000).toISOString() });
	assert.equal(isDockIdleEvictable(oldEnded, now, hideMs), true);
	assert.equal(isDockIdleEvictable(freshEnded, now, hideMs), false);
	assert.equal(isDockIdleEvictable(oldReady, now, hideMs), false);
	assert.equal(isDockIdleEvictable(oldFailed, now, hideMs), false);
});

test("isDockIdleEvictable returns false when hide window is zero or negative", () => {
	const now = Date.now();
	const ended = makeWorker({ id: "a", state: "ended", updatedAt: new Date(now - 86_400_000).toISOString() });
	assert.equal(isDockIdleEvictable(ended, now, 0), false);
});

test("shouldPruneWorker selects ended workers past prune window only", () => {
	const now = Date.now();
	const pruneMs = 24 * 3_600_000;
	const oldEnded = makeWorker({ id: "a", state: "ended", updatedAt: new Date(now - pruneMs - 1000).toISOString() });
	const freshEnded = makeWorker({ id: "b", state: "ended", updatedAt: new Date(now - 1000).toISOString() });
	const oldReady = makeWorker({ id: "c", state: "ready", updatedAt: new Date(now - pruneMs - 1000).toISOString() });
	assert.equal(shouldPruneWorker(oldEnded, now, pruneMs), true);
	assert.equal(shouldPruneWorker(freshEnded, now, pruneMs), false);
	assert.equal(shouldPruneWorker(oldReady, now, pruneMs), false);
});

test("selectPrunableWorkers returns only the ended-and-old set", () => {
	const now = Date.now();
	const pruneMs = 24 * 3_600_000;
	const workers = [
		makeWorker({ id: "old1", state: "ended", updatedAt: new Date(now - pruneMs - 1000).toISOString() }),
		makeWorker({ id: "old2", state: "ended", updatedAt: new Date(now - pruneMs - 2000).toISOString() }),
		makeWorker({ id: "active", state: "active", updatedAt: new Date(now - 60_000).toISOString() }),
		makeWorker({ id: "ready", state: "ready", updatedAt: new Date(now - pruneMs - 1000).toISOString() }),
	];
	const targets = selectPrunableWorkers(workers, now, pruneMs);
	assert.deepEqual(targets.map((w) => w.id).sort(), ["old1", "old2"]);
});
