import test from "node:test";
import assert from "node:assert/strict";
import { createCheckpointCommands } from "../extensions/checkpoint-commands.js";
import type { CheckpointStore } from "../extensions/checkpoint-store.js";
import type { Artifact, CheckpointIndexEntry } from "../extensions/types.js";

const checkpoint: CheckpointIndexEntry = {
	id: "ck-1",
	mode: "handoff",
	file: "/tmp/ck-1.md",
	createdAt: "2026-01-01T00:00:00.000Z",
	cwd: "/repo",
	note: "continue",
};

function fakeStore(entry: CheckpointIndexEntry | undefined = checkpoint) {
	const purged: CheckpointIndexEntry[] = [];
	const store: CheckpointStore = {
		find: async () => entry,
		list: async () => entry ? [entry] : [],
		listSummaries: async () => entry ? [{ entry, artifactCount: 2, files: 1, errors: 0, commands: 1, estimatedTokens: 42 }] : [],
		readMarkdown: async () => "checkpoint markdown",
		readArtifacts: async () => [] as Artifact[],
		markConsumed: async () => {},
		purge: async (candidate) => { purged.push(candidate); },
	};
	return { store, purged };
}

function deps(overrides: Partial<Parameters<typeof createCheckpointCommands>[0]> = {}) {
	const { store, purged } = fakeStore();
	const notifications: string[] = [];
	const emitted: string[] = [];
	const base: Parameters<typeof createCheckpointCommands>[0] = {
		store,
		notify: (text) => notifications.push(text),
		emitText: (text) => emitted.push(text),
		confirmDelete: async () => true,
		...overrides,
	};
	return { commands: createCheckpointCommands(base), notifications, emitted, purged };
}

test("Checkpoint Commands delete respects cancelled confirmation", async () => {
	const { commands, notifications, purged } = deps({ confirmDelete: async () => false });

	const deleted = await commands.delete("ck-1");

	assert.equal(deleted, false);
	assert.deepEqual(purged, []);
	assert.deepEqual(notifications, ["Docket delete cancelled"]);
});

test("Checkpoint Commands list emits the legacy bundle table", async () => {
	const { commands, emitted } = deps();

	await commands.list(true);

	assert.equal(emitted.length, 1);
	assert.match(emitted[0]!, /ck-1\thandoff\t\/repo\tcontinue/);
});

test("Checkpoint Commands delete without a target resolves the latest legacy bundle", async () => {
	const { commands, purged } = deps();

	assert.equal(await commands.delete(), true);
	assert.deepEqual(purged, [checkpoint]);
});
