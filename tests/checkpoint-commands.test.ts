import test from "node:test";
import assert from "node:assert/strict";
import { createCheckpointCommands, type ResumeSelection } from "../extensions/checkpoint-commands.js";
import type { CheckpointStore, CheckpointSummary } from "../extensions/checkpoint-store.js";
import type { Artifact, CheckpointIndexEntry } from "../extensions/types.js";

const checkpoint: CheckpointIndexEntry = {
	id: "ck-1",
	mode: "handoff",
	file: "/tmp/ck-1.md",
	createdAt: "2026-01-01T00:00:00.000Z",
	cwd: "/repo",
	note: "continue",
};

const summary: CheckpointSummary = {
	entry: checkpoint,
	artifactCount: 2,
	files: 1,
	errors: 0,
	commands: 1,
	estimatedTokens: 42,
};

function fakeStore(entry: CheckpointIndexEntry | undefined = checkpoint) {
	const purged: CheckpointIndexEntry[] = [];
	const store: CheckpointStore = {
		save: async () => { throw new Error("unused"); },
		find: async () => entry,
		list: async () => entry ? [entry] : [],
		listSummaries: async () => entry ? [summary] : [],
		readMarkdown: async () => "checkpoint markdown",
		readArtifacts: async () => [] as Artifact[],
		markConsumed: async () => {},
		purge: async (checkpoint) => { purged.push(checkpoint); },
		sweepConsumed: async () => 0,
		artifactsFile: (id) => `/tmp/${id}.artifacts.json`,
	};
	return { store, purged };
}

function deps(overrides: Partial<Parameters<typeof createCheckpointCommands>[0]> = {}) {
	const { store, purged } = fakeStore();
	const notifications: string[] = [];
	const emitted: string[] = [];
	const sessions: Array<{ id: string; content: string }> = [];
	const shown: string[] = [];
	const base: Parameters<typeof createCheckpointCommands>[0] = {
		store,
		hasUI: false,
		notify: (text) => notifications.push(text),
		emitText: (text) => emitted.push(text),
		confirmDelete: async () => true,
		selectCheckpoint: async () => null,
		showText: async (title) => { shown.push(title); },
		editText: async () => undefined,
		startSession: async (checkpoint, content) => { sessions.push({ id: checkpoint.id, content }); },
		...overrides,
	};
	return { commands: createCheckpointCommands(base), notifications, emitted, sessions, shown, purged };
}

test("Checkpoint Commands continues last checkpoint without UI", async () => {
	const { commands, sessions } = deps();

	await commands.continue();

	assert.deepEqual(sessions, [{ id: "ck-1", content: "checkpoint markdown" }]);
});

test("Checkpoint Commands delete respects cancelled confirmation", async () => {
	const { commands, notifications, purged } = deps({ confirmDelete: async () => false });

	const deleted = await commands.delete("ck-1");

	assert.equal(deleted, false);
	assert.deepEqual(purged, []);
	assert.deepEqual(notifications, ["Trail delete cancelled"]);
});

test("Checkpoint Commands list emits checkpoint table", async () => {
	const { commands, emitted } = deps();

	await commands.list(true);

	assert.equal(emitted.length, 1);
	assert.match(emitted[0]!, /ck-1\thandoff\t\/repo\tcontinue/);
});

test("Checkpoint Commands UI continue can preview then start selected checkpoint", async () => {
	const selections: ResumeSelection[] = [
		{ action: "preview", summary, index: 0 },
		{ action: "continue", summary, index: 0 },
	];
	const { commands, sessions, shown } = deps({
		hasUI: true,
		selectCheckpoint: async () => selections.shift() ?? null,
	});

	await commands.continue();

	assert.deepEqual(shown, ["Trail checkpoint ck-1"]);
	assert.deepEqual(sessions, [{ id: "ck-1", content: "checkpoint markdown" }]);
});
