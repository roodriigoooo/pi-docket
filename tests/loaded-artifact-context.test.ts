import test from "node:test";
import assert from "node:assert/strict";
import { createLoadedArtifactContext } from "../extensions/loaded-artifact-context.js";
import type { Artifact, CheckpointIndexEntry } from "../extensions/types.js";
import type { WorkerStatus } from "../extensions/worker-store.js";
import type { WorkerDeliverable } from "../extensions/worker-deliverable.js";

const commandArtifact: Artifact = {
	id: "c1",
	displayId: "c1",
	ref: "command:t1:0",
	kind: "command",
	title: "$ npm test",
	subtitle: "ok",
	body: "passed",
};

const fileArtifact: Artifact = {
	id: "f1",
	displayId: "f1",
	ref: "file:t2:0",
	kind: "file",
	title: "read src/a.ts",
	subtitle: "ok",
	body: "current file",
};

const checkpoint: CheckpointIndexEntry = {
	id: "ck-1",
	mode: "handoff",
	file: "/tmp/ck-1.md",
	createdAt: "2026-01-01T00:00:00.000Z",
	cwd: "/repo",
	consumeOnUse: true,
};

const worker: WorkerStatus = {
	id: "worker-1",
	index: 2,
	tmuxSession: "docket-worker-1",
	task: "inspect bug",
	cwd: "/repo",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	state: "active",
};

function context(artifacts = [commandArtifact, fileArtifact]) {
	return createLoadedArtifactContext({
		readCheckpointArtifacts: async () => [fileArtifact],
		readWorkerArtifacts: async () => [commandArtifact],
		loadConfig: async () => ({
			maxArtifacts: 50,
			maxBodyChars: 1000,
			checkpointArtifacts: 10,
			consumedRetentionDays: 7,
			summarizer: { enabled: false, maxOutputTokens: 1000, maxInputChars: 10000, timeoutMs: 1000 },
		}),
		createCatalog: (_ctx, _config, carryover) => {
			const all = [...artifacts, ...carryover];
			return {
				list: () => all,
				find: (idOrRef: string) => all.find((artifact) => artifact.displayId === idOrRef || artifact.ref === idOrRef),
				reference: (artifact: Artifact) => `ref:${artifact.displayId}`,
				fullText: (artifact: Artifact) => `full:${artifact.displayId}`,
				inspect: async () => ({ title: "", text: "" }),
				search: async () => [],
				selectForCheckpoint: () => [],
				checkpointPayload: () => [],
				summary: (artifact: Artifact) => artifact,
			};
		},
	});
}

test("Loaded Artifact context toggles chips and clears them", () => {
	const loaded = context();
	assert.equal(loaded.toggleChip(commandArtifact, "ref"), "added");
	assert.deepEqual(loaded.chips().map((chip) => `${chip.displayId}:${chip.mode}`), ["c1:ref"]);
	assert.equal(loaded.toggleChip(commandArtifact, "full"), "upgraded");
	assert.deepEqual(loaded.chips().map((chip) => `${chip.displayId}:${chip.mode}`), ["c1:full"]);
	assert.equal(loaded.toggleChip(commandArtifact, "ref"), "downgraded");
	assert.equal(loaded.toggleChip(commandArtifact, "ref"), "removed");
	assert.equal(loaded.clearChips(), false);
	loaded.toggleChip(commandArtifact, "ref");
	assert.equal(loaded.clearChips(), true);
	assert.deepEqual(loaded.chips(), []);
});

test("Loaded Artifact context expands ref and full chips into submit text", async () => {
	const loaded = context();
	loaded.toggleChip(commandArtifact, "ref");
	loaded.toggleChip(fileArtifact, "full");

	const result = await loaded.expandChipsForSubmit({ cwd: "/repo", sessionManager: { getBranch: () => [] } }, "continue");

	assert.equal(result.expanded, 2);
	assert.deepEqual(result.missing, []);
	assert.match(result.text, /<<docket-context: 2 references>>/);
	assert.ok(result.text.includes("<<docket @c1 ref>>\nref:c1\n<</docket>>"));
	assert.ok(result.text.includes("<<docket @f1 full>>\nfull:f1\n<</docket>>"));
	assert.match(result.text, /\n\ncontinue$/);
});

test("Loaded Artifact context reports stale chips without expanding", async () => {
	const loaded = context([]);
	loaded.toggleChip(commandArtifact, "ref");

	const result = await loaded.expandChipsForSubmit({ cwd: "/repo", sessionManager: { getBranch: () => [] } }, "continue");

	assert.deepEqual(result, { text: "continue", expanded: 0, missing: ["c1"] });
});

test("Loaded Artifact context mounts checkpoint and worker artifacts with stable slots", async () => {
	const loaded = context([]);

	const ckSlot = await loaded.loadCheckpoint(checkpoint);
	const sameCkSlot = await loaded.loadCheckpoint(checkpoint);
	const workerSlot = await loaded.loadWorker(worker);

	assert.equal(ckSlot, sameCkSlot);
	assert.equal(ckSlot.slot, "c1");
	assert.equal(ckSlot.artifacts[0]?.displayId, "c1.f1");
	assert.equal(workerSlot.slot, "w2");
	assert.equal(workerSlot.artifacts[0]?.displayId, "w2.c1");
	assert.deepEqual(loaded.carryoverArtifacts().map((artifact) => artifact.displayId), ["c1.f1", "w2.c1"]);
	assert.equal(loaded.unloadSource("worker", worker.id)?.slot, "w2");
	assert.deepEqual(loaded.carryoverArtifacts().map((artifact) => artifact.displayId), ["c1.f1"]);
});

test("Loaded Artifact context selects default load source", () => {
	const loaded = context();
	assert.deepEqual(loaded.defaultLoadSource({ checkpoints: [checkpoint], workers: [worker] }), { kind: "checkpoint", checkpoint });
	assert.deepEqual(loaded.defaultLoadSource({ checkpoints: [], workers: [worker] }), { kind: "worker", worker });
	assert.equal(loaded.defaultLoadSource({ checkpoints: [], workers: [] }), undefined);
});

test("Loaded Artifact context load source queues consume-on-use checkpoints", async () => {
	const loaded = context();
	const result = await loaded.loadSource({ kind: "checkpoint", checkpoint });

	assert.equal(result.slot.slot, "c1");
	assert.equal(result.queuedConsume, true);
	const consumed: string[] = [];
	await loaded.drainCheckpointConsumes(async (entry) => { consumed.push(entry.id); });
	assert.deepEqual(consumed, ["ck-1"]);
});

test("Loaded Artifact context drops pending consume when checkpoint unloads", async () => {
	const loaded = context();
	await loaded.loadCheckpoint(checkpoint);
	loaded.unloadSlot("c1");

	const consumed: string[] = [];
	await loaded.drainCheckpointConsumes(async (entry) => { consumed.push(entry.id); });

	assert.deepEqual(consumed, []);
});

test("Loaded Artifact context drains pending checkpoint consumes once", async () => {
	const loaded = context();
	loaded.queueCheckpointConsume(checkpoint);

	const consumed: string[] = [];
	await loaded.drainCheckpointConsumes(async (entry) => { consumed.push(entry.id); });
	await loaded.drainCheckpointConsumes(async (entry) => { consumed.push(entry.id); });

	assert.deepEqual(consumed, ["ck-1"]);
});

test("Loaded Artifact context mounts immutable deliverable and queues a full chip", async () => {
	const loaded = context([]);
	const deliverable: WorkerDeliverable = {
		schemaVersion: 1,
		id: "worker-deliverable:worker-1",
		version: 2,
		ref: "worker-deliverable:worker-1:2",
		createdAt: "2026-01-01T00:00:00.000Z",
		source: { workerId: worker.id, workerLabel: "w2", task: worker.task },
		body: "approved v2 body",
		summary: "approved",
		outcome: "proposal",
		evidence: [],
		recommendations: [],
		refs: [],
	};
	const slot = await loaded.loadDeliverable(worker, deliverable);
	const artifact = slot.artifacts[0]!;

	assert.equal(artifact.body, "approved v2 body");
	assert.equal(artifact.ref, deliverable.ref);
	assert.equal(loaded.toggleChip(artifact, "full"), "added");
	assert.equal(loaded.chips()[0]?.mode, "full");
});

test("mounting a newer deliverable preserves an already queued approved version", async () => {
	const loaded = context([]);
	const v1: WorkerDeliverable = {
		schemaVersion: 1, id: "worker-deliverable:worker-1", version: 1, ref: "worker-deliverable:worker-1:1", createdAt: "2026-01-01T00:00:00.000Z",
		source: { workerId: worker.id, workerLabel: "w2", task: worker.task }, body: "v1", summary: "v1", outcome: "proposal", evidence: [], recommendations: [], refs: [],
	};
	const v2 = { ...v1, version: 2, ref: "worker-deliverable:worker-1:2", body: "v2" };
	const first = await loaded.loadDeliverable(worker, v1);
	loaded.toggleChip(first.artifacts[0]!, "full");
	await loaded.loadDeliverable(worker, v2);

	assert.equal(loaded.chips()[0]?.ref, v1.ref);
	assert.equal(loaded.chips()[0]?.body, "v1");
	assert.equal(loaded.carryoverArtifacts()[0]?.ref, v2.ref);
});

test("queued deliverable body survives a worker slot refresh", async () => {
	const loaded = context([]);
	const v1: WorkerDeliverable = {
		schemaVersion: 1, id: "worker-deliverable:worker-1", version: 1, ref: "worker-deliverable:worker-1:1", createdAt: "2026-01-01T00:00:00.000Z",
		source: { workerId: worker.id, workerLabel: "w2", task: worker.task }, body: "approved v1 exact body", summary: "v1", outcome: "proposal", evidence: [], recommendations: [], refs: [],
	};
	const first = await loaded.loadDeliverable(worker, v1);
	loaded.toggleChip(first.artifacts[0]!, "full");
	loaded.unloadSource("worker", worker.id);
	await loaded.loadDeliverable(worker, { ...v1, version: 2, ref: "worker-deliverable:worker-1:2", body: "v2" });

	const expanded = await loaded.expandChipsForSubmit({ cwd: "/repo", sessionManager: { getBranch: () => [] } }, "next");
	assert.equal(expanded.missing.length, 0);
	assert.match(expanded.text, /approved v1 exact body/);
});

test("full deliverable chip expands approved bytes once on next submit", async () => {
	const loaded = createLoadedArtifactContext({
		readCheckpointArtifacts: async () => [],
		readWorkerArtifacts: async () => [commandArtifact],
		loadConfig: async () => ({ maxArtifacts: 50, maxBodyChars: 1000, checkpointArtifacts: 10, consumedRetentionDays: 7, summarizer: { enabled: false, maxOutputTokens: 1, maxInputChars: 1, timeoutMs: 1 } }),
		createCatalog: (_ctx, _config, carryover) => ({
			list: () => carryover,
			find: (id) => carryover.find((artifact) => artifact.ref === id || artifact.displayId === id),
			reference: () => "unused",
			fullText: (artifact) => artifact.body,
			inspect: async () => ({ title: "", text: "" }),
			search: async () => [],
			selectForCheckpoint: () => [],
			checkpointPayload: () => [],
			summary: (artifact) => artifact,
		}),
	});
	const deliverable: WorkerDeliverable = {
		schemaVersion: 1, id: "worker-deliverable:worker-1", version: 2, ref: "worker-deliverable:worker-1:2", createdAt: "2026-01-01T00:00:00.000Z",
		source: { workerId: worker.id, workerLabel: "w2", task: worker.task }, body: "approved v2 exact body", summary: "approved", outcome: "proposal", evidence: [], recommendations: [], refs: [],
	};
	const slot = await loaded.loadDeliverable(worker, deliverable);
	loaded.toggleChip(slot.artifacts[0]!, "full");
	const expanded = await loaded.expandChipsForSubmit({ cwd: "/repo", sessionManager: { getBranch: () => [] } }, "next prompt");
	assert.match(expanded.text, /approved v2 exact body/);
	assert.doesNotMatch(expanded.text, /latest mutable worker output/);
	loaded.clearChips();
	assert.equal(loaded.chips().length, 0);
});
