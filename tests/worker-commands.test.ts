import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerCommands, workerCompletionCandidates } from "../extensions/worker-commands.js";
import type { Artifact } from "../extensions/types.js";
import type { SpawnInput, WorkerStatus, WorkerStore } from "../extensions/worker-store.js";

const worker: WorkerStatus = {
	id: "worker-1",
	index: 2,
	tmuxSession: "trail-worker-1",
	task: "inspect bug now please",
	cwd: "/repo",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: new Date().toISOString(),
	state: "active",
	artifactCount: 3,
};

function fakeStore(workers: WorkerStatus[] = [worker]) {
	const spawned: SpawnInput[] = [];
	const purged: string[] = [];
	const sent: Array<{ id: string; text: string }> = [];
	const store: WorkerStore = {
		root: () => "/tmp/workers",
		dirFor: (id) => `/tmp/workers/${id}`,
		statusFile: (id) => `/tmp/workers/${id}/status.json`,
		artifactsFile: (id) => `/tmp/workers/${id}/artifacts.json`,
		taskFile: (id) => `/tmp/workers/${id}/task.md`,
		list: async () => workers,
		find: async (id) => workers.find((entry) => entry.id === id || `w${entry.index}` === id),
		readArtifacts: async () => [] as Artifact[],
		writeStatus: async () => {},
		patchStatus: async () => undefined,
		writeArtifacts: async () => {},
		sendInput: async (id, text) => { sent.push({ id, text }); return true; },
		spawn: async (input) => { spawned.push(input); return worker; },
		kill: async () => true,
		purge: async (id) => { purged.push(id); },
	};
	return { store, spawned, purged, sent };
}

function deps(workers = [worker]) {
	const { store, spawned, purged, sent } = fakeStore(workers);
	const notifications: string[] = [];
	const announcements: Array<{ subject: string; detail?: string; kind?: string }> = [];
	const emitted: string[] = [];
	const loaded: string[] = [];
	const unloaded: string[] = [];
	const commands = createWorkerCommands({
		store,
		loadedArtifacts: {
			loadWorker: async (worker) => {
				loaded.push(worker.id);
				return { slot: `w${worker.index}`, kind: "worker", sourceId: worker.id, artifacts: [{ id: "a1", displayId: "a1", ref: "command:t:0", kind: "command", title: "cmd", subtitle: "ok", body: "body" }] };
			},
			unloadSource: (_kind, sourceId) => {
				unloaded.push(sourceId);
				return sourceId === worker.id ? { slot: "w2", kind: "worker", sourceId, artifacts: [] } : undefined;
			},
		},
		cwd: "/repo",
		parentSession: "/session.json",
		notify: (text) => notifications.push(text),
		announce: (subject, detail, kind) => announcements.push({ subject, detail, kind }),
		emitText: (text) => emitted.push(text),
	});
	return { commands, store, spawned, purged, sent, notifications, announcements, emitted, loaded, unloaded };
}

test("Worker Commands spawns worker with cwd and parent session", async () => {
	const { commands, spawned, announcements } = deps();

	await commands.spawn("inspect bug");

	assert.deepEqual(spawned, [{ task: "inspect bug", cwd: "/repo", parentSession: "/session.json" }]);
	assert.equal(announcements[0]?.subject, "spawned w2 · starting");
	assert.match(announcements[0]?.detail ?? "", /review: \/trail/);
	assert.match(announcements[0]?.detail ?? "", /debug:  \/trail workers/);
});

test("Worker Commands sends parent replies to workers", async () => {
	const { commands, sent, announcements } = deps();

	await commands.ask("w2", "include prompt chips");

	assert.deepEqual(sent, [{ id: "worker-1", text: "Parent reply: include prompt chips" }]);
	assert.equal(announcements[0]?.subject, "sent reply to w2");
});

test("Worker Commands lists workers", async () => {
	const { commands, emitted } = deps();

	await commands.list();

	assert.equal(emitted.length, 1);
	assert.match(emitted[0]!, /w2\s+active\s+3 artifacts/);
});

test("Worker Commands loads and unloads worker artifacts", async () => {
	const { commands, loaded, unloaded, announcements } = deps();

	await commands.load("w2");
	await commands.unload("w2");

	assert.deepEqual(loaded, ["worker-1"]);
	assert.deepEqual(unloaded, ["worker-1"]);
	assert.equal(announcements[0]?.subject, "loaded w2 · 1 artifact");
	assert.equal(announcements[1]?.subject, "unloaded w2");
});

test("Worker Commands deletes worker and unloads it first", async () => {
	const { commands, purged, unloaded, announcements } = deps();

	await commands.delete("w2");

	assert.deepEqual(unloaded, ["worker-1"]);
	assert.deepEqual(purged, ["worker-1"]);
	assert.equal(announcements[0]?.subject, "worker w2 killed");
});

test("Worker Commands reports missing worker", async () => {
	const { commands, notifications } = deps([]);

	await commands.load("w2");

	assert.deepEqual(notifications, ["Trail worker not found"]);
});

test("workerCompletionCandidates returns recent worker labels", async () => {
	const { store } = fakeStore([worker]);

	assert.deepEqual(await workerCompletionCandidates(store), [{ value: "w2", label: "w2  active  inspect bug now please" }]);
});
