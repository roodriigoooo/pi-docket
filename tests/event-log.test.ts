import test from "node:test";
import assert from "node:assert/strict";
import { replayEvents, type CheckpointEvent } from "../extensions/event-log.js";
import type { CheckpointIndexEntry } from "../extensions/types.js";

const sampleEntry: CheckpointIndexEntry = {
	id: "ck-a",
	mode: "handoff",
	file: "/tmp/ck-a.md",
	createdAt: "2026-05-01T00:00:00.000Z",
	cwd: "/repo",
	consumeOnUse: true,
};

test("replay applies saved + consumed events in order", () => {
	const events: CheckpointEvent[] = [
		{ type: "checkpoint_saved", timestamp: "2026-05-01T00:00:00Z", entry: sampleEntry },
		{ type: "checkpoint_consumed", timestamp: "2026-05-02T00:00:00Z", id: "ck-a", consumedAt: "2026-05-02T00:00:00Z" },
	];
	const index = replayEvents(events);
	assert.equal(index.length, 1);
	assert.equal(index[0]?.id, "ck-a");
	assert.equal(index[0]?.consumedAt, "2026-05-02T00:00:00Z");
});

test("replay drops entries on purge", () => {
	const events: CheckpointEvent[] = [
		{ type: "checkpoint_saved", timestamp: "2026-05-01T00:00:00Z", entry: sampleEntry },
		{ type: "checkpoint_purged", timestamp: "2026-05-03T00:00:00Z", id: "ck-a" },
	];
	const index = replayEvents(events);
	assert.equal(index.length, 0);
});

test("replay handles unconsume", () => {
	const events: CheckpointEvent[] = [
		{ type: "checkpoint_saved", timestamp: "2026-05-01T00:00:00Z", entry: sampleEntry },
		{ type: "checkpoint_consumed", timestamp: "2026-05-02T00:00:00Z", id: "ck-a", consumedAt: "2026-05-02T00:00:00Z" },
		{ type: "checkpoint_unconsumed", timestamp: "2026-05-03T00:00:00Z", id: "ck-a" },
	];
	const index = replayEvents(events);
	assert.equal(index.length, 1);
	assert.equal(index[0]?.consumedAt, undefined);
});

test("replay sweep purges multiple ids", () => {
	const second: CheckpointIndexEntry = { ...sampleEntry, id: "ck-b", createdAt: "2026-05-01T01:00:00.000Z", consumeOnUse: false };
	const events: CheckpointEvent[] = [
		{ type: "checkpoint_saved", timestamp: "2026-05-01T00:00:00Z", entry: sampleEntry },
		{ type: "checkpoint_saved", timestamp: "2026-05-01T01:00:00Z", entry: second },
		{ type: "checkpoint_swept", timestamp: "2026-05-04T00:00:00Z", ids: ["ck-a"], retentionDays: 7 },
	];
	const index = replayEvents(events);
	assert.equal(index.length, 1);
	assert.equal(index[0]?.id, "ck-b");
});

test("replay output sorted by createdAt", () => {
	const a: CheckpointIndexEntry = { ...sampleEntry, id: "ck-a", createdAt: "2026-05-02T00:00:00.000Z" };
	const b: CheckpointIndexEntry = { ...sampleEntry, id: "ck-b", createdAt: "2026-05-01T00:00:00.000Z", consumeOnUse: false };
	const events: CheckpointEvent[] = [
		{ type: "checkpoint_saved", timestamp: a.createdAt, entry: a },
		{ type: "checkpoint_saved", timestamp: b.createdAt, entry: b },
	];
	const index = replayEvents(events);
	assert.deepEqual(index.map((entry) => entry.id), ["ck-b", "ck-a"]);
});
