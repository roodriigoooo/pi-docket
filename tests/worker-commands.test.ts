import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerCommands, workerCompletionCandidates } from "../extensions/worker-commands.js";
import type { Artifact } from "../extensions/types.js";
import type { SpawnInput, WorkerStatus, WorkerStore } from "../extensions/worker-store.js";
import { createWorkerKindRegistry } from "../extensions/worker-kinds.js";

const worker: WorkerStatus = {
	id: "worker-1",
	index: 2,
	tmuxSession: "docket-worker-1",
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
		updateStatus: async () => ({ before: undefined, after: undefined, changed: false }),
		writeArtifacts: async () => {},
		addQuestion: async () => undefined,
		sendInput: async (id, text) => { sent.push({ id, text }); return true; },
		spawn: async (input) => { spawned.push(input); return { ...worker, state: "starting" }; },
		kill: async () => true,
		purge: async (id) => { purged.push(id); return [id]; },
		countActive: async () => workers.filter((w) => ["starting", "active", "idle", "needs_input"].includes(w.state)).length,
		respawn: async (id) => workers.find((w) => w.id === id),
		harvestPaneTail: async () => "window_gone",
		readPaneTail: async () => undefined,
	};
	return { store, spawned, purged, sent };
}

function deps(workers = [worker], kinds = createWorkerKindRegistry()) {
	const { store, spawned, purged, sent } = fakeStore(workers);
	const notifications: string[] = [];
	const announcements: Array<{ subject: string; detail?: string; kind?: string; meta?: { workerId: string } }> = [];
	const emitted: string[] = [];
	const loaded: string[] = [];
	const unloaded: string[] = [];
	const commands = createWorkerCommands({
		store,
		loadedArtifacts: {
			loadSource: async (source) => {
				if (source.kind !== "worker") throw new Error("expected worker");
				loaded.push(source.worker.id);
				const slot = { slot: `w${source.worker.index}`, kind: "worker" as const, sourceId: source.worker.id, artifacts: [{ id: "a1", displayId: "a1", ref: "command:t:0", kind: "command" as const, title: "cmd", subtitle: "ok", body: "body" }] };
				return { source, slot, queuedConsume: false };
			},
			unloadSource: (_kind, sourceId) => {
				unloaded.push(sourceId);
				return sourceId === worker.id ? { slot: "w2", kind: "worker", sourceId, artifacts: [] } : undefined;
			},
		},
		cwd: "/repo",
		parentSession: "/session.json",
			kinds,
		maxActive: () => 8,
		captureTerminal: () => false,
		notify: (text) => notifications.push(text),
		announce: (subject, detail, kind, _docket, meta) => announcements.push({ subject, detail, kind, meta }),
		emitText: (text) => emitted.push(text),
	});
	return { commands, store, spawned, purged, sent, notifications, announcements, emitted, loaded, unloaded, kinds };
}

test("Worker Commands spawns worker with cwd and fresh session by default", async () => {
	const { commands, spawned, announcements } = deps();

	await commands.spawn("inspect bug");

	assert.equal(spawned.length, 1);
	assert.equal(spawned[0]?.task, "inspect bug");
	assert.equal(spawned[0]?.cwd, "/repo");
	assert.equal(spawned[0]?.parentSession, undefined); // default kind = fresh (no parent seed)
	assert.equal(spawned[0]?.kind, "default");
	assert.equal(spawned[0]?.worktree, true); // default kind has defaultWorktree=true
	assert.equal(announcements[0]?.subject, "spawned w2 · starting");
	assert.match(announcements[0]?.detail ?? "", /status: w2 inspect bug now please/);
	assert.match(announcements[0]?.detail ?? "", /inbox:  \/docket/);
	assert.match(announcements[0]?.detail ?? "", /debug:  \/docket workers/);
	assert.deepEqual(announcements[0]?.meta, { workerId: "worker-1" });
});

test("Worker Commands does not infer kind policy from task wording", async () => {
	const { commands, spawned } = deps();

	await commands.spawn("investigate auth flake");
	await commands.spawn("fix auth flake");

	assert.deepEqual(spawned.map((input) => input.kind), ["default", "default"]);
	assert.deepEqual(spawned.map((input) => input.planGate), [true, true]);
	assert.deepEqual(spawned.map((input) => input.readOnly), [false, false]);
});

test("Worker Commands passes worktree spawn option", async () => {
	const { commands, spawned } = deps();

	await commands.spawn("edit bug", { worktree: true });

	assert.equal(spawned[0]?.task, "edit bug");
	assert.equal(spawned[0]?.worktree, true);
	assert.equal(spawned[0]?.parentSession, undefined); // default kind = fresh
});

test("Worker Commands --seed forces parent session seeding", async () => {
	const { commands, spawned } = deps();

	await commands.spawn("edit bug", { seed: true });

	assert.equal(spawned[0]?.parentSession, "/session.json");
});

test("Worker Commands --fresh overrides a full kind", async () => {
	const setup = deps();
	const reg = createWorkerKindRegistry();
	reg.register({ name: "seedy", readOnly: false, defaultWorktree: true, parentSeedPolicy: "full", canSpawn: [], layout: "single", source: "runtime" });
	const commands = createWorkerCommands({
		store: setup.store, loadedArtifacts: { loadSource: async () => { throw new Error("unused"); }, unloadSource: () => undefined }, cwd: "/repo", parentSession: "/session.json", kinds: reg, maxActive: () => 8, captureTerminal: () => false, notify: () => {}, announce: () => {}, emitText: () => {},
	});

	await commands.spawn("x", { as: "seedy" });
	assert.equal(setup.spawned[0]?.parentSession, "/session.json");

	await commands.spawn("y", { as: "seedy", fresh: true });
	assert.equal(setup.spawned[1]?.parentSession, undefined);
});

test("Worker Commands passes kind decision-rights and plan gate into spawn", async () => {
	const setup = deps();
	setup.store.find = async (id) => [worker].find((entry) => entry.id === id || `w${entry.index}` === id);
	const reg = createWorkerKindRegistry();
	reg.register({
		name: "planner",
		readOnly: false,
		defaultWorktree: true,
		parentSeedPolicy: "full",
		canSpawn: [],
		planGate: true,
		decisionRights: ["May edit docs after approval"],
		layout: "single",
		source: "runtime",
	});
	const commands = createWorkerCommands({
		store: setup.store,
		loadedArtifacts: { loadSource: async () => { throw new Error("unused"); }, unloadSource: () => undefined },
		cwd: "/repo",
		parentSession: "/session.json",
		kinds: reg,
		maxActive: () => 8,
		captureTerminal: () => false,
		notify: () => {},
		announce: () => {},
		emitText: () => {},
	});

	await commands.spawn("draft docs", { as: "planner" });

	assert.equal(setup.spawned[0]?.kind, "planner");
	assert.equal(setup.spawned[0]?.readOnly, false);
	assert.equal(setup.spawned[0]?.planGate, true);
	assert.deepEqual(setup.spawned[0]?.decisionRights, ["May edit docs after approval"]);
});

test("Worker Commands uses configured default kind", async () => {
	const setup = deps();
	const reg = createWorkerKindRegistry();
	reg.register({
		name: "planner",
		readOnly: true,
		defaultWorktree: false,
		parentSeedPolicy: "none",
		canSpawn: [],
		layout: "split-events",
		source: "runtime",
	});
	const commands = createWorkerCommands({
		store: setup.store,
		loadedArtifacts: { loadSource: async () => { throw new Error("unused"); }, unloadSource: () => undefined },
		cwd: "/repo",
		parentSession: "/session.json",
		kinds: reg,
		maxActive: () => 8,
		captureTerminal: () => false,
		defaultKind: () => "planner",
		notify: () => {},
		announce: () => {},
		emitText: () => {},
	});

	await commands.spawn("draft docs");

	assert.equal(setup.spawned[0]?.kind, "planner");
	assert.equal(setup.spawned[0]?.readOnly, true);
	assert.equal(setup.spawned[0]?.worktree, false);
	assert.equal(setup.spawned[0]?.layout, "split-events");
	assert.equal(setup.spawned[0]?.planGate, undefined);
});

test("Worker Commands lists explicit worker rights", async () => {
	const kinds = createWorkerKindRegistry();
	kinds.register({ name: "writer", readOnly: false, defaultWorktree: true, parentSeedPolicy: "none", canSpawn: [], planGate: false, layout: "single", source: "runtime" });
	const setup = deps([worker], kinds);

	await setup.commands.listKinds();

	assert.match(setup.emitted[0] ?? "", /default\s+plan-gated\s+fresh\s+no-spawn/);
	assert.match(setup.emitted[0] ?? "", /writer\s+writable\s+fresh\s+no-spawn/);
});

test("Worker Commands passes kind model and thinking to worker launch", async () => {
	const setup = deps();
	const reg = createWorkerKindRegistry();
	reg.register({
		name: "opus",
		model: "anthropic/claude-opus-4-7",
		thinking: "high",
		readOnly: false,
		defaultWorktree: true,
		parentSeedPolicy: "none",
		canSpawn: [],
		layout: "single",
		source: "runtime",
	});
	const commands = createWorkerCommands({
		store: setup.store,
		loadedArtifacts: { loadSource: async () => { throw new Error("unused"); }, unloadSource: () => undefined },
		cwd: "/repo",
		parentSession: "/session.json",
		kinds: reg,
		maxActive: () => 8,
		captureTerminal: () => false,
		notify: () => {},
		announce: () => {},
		emitText: () => {},
	});

	await commands.spawn("deep review", { as: "opus" });

	assert.deepEqual(setup.spawned[0]?.extensionArgs, ["--model", "anthropic/claude-opus-4-7", "--thinking", "high"]);
});

test("Worker Commands inherits parent model when kind has no model override", async () => {
	const setup = deps();
	const reg = createWorkerKindRegistry();
	reg.register({ name: "reviewer", readOnly: true, defaultWorktree: false, parentSeedPolicy: "none", canSpawn: [], layout: "single", source: "runtime" });
	const commands = createWorkerCommands({
		store: setup.store,
		loadedArtifacts: { loadSource: async () => { throw new Error("unused"); }, unloadSource: () => undefined },
		cwd: "/repo",
		parentSession: "/session.json",
		parentModel: () => "google/gemini-3-pro",
		kinds: reg,
		maxActive: () => 8,
		captureTerminal: () => false,
		notify: () => {},
		announce: () => {},
		emitText: () => {},
	});

	await commands.spawn("review", { as: "reviewer" });

	assert.deepEqual(setup.spawned[0]?.extensionArgs, ["--model", "google/gemini-3-pro"]);
});

test("Worker Commands warns and falls back when configured default kind is missing", async () => {
	const setup = deps();
	const notifications: string[] = [];
	const commands = createWorkerCommands({
		store: setup.store,
		loadedArtifacts: { loadSource: async () => { throw new Error("unused"); }, unloadSource: () => undefined },
		cwd: "/repo",
		parentSession: "/session.json",
		kinds: createWorkerKindRegistry(),
		maxActive: () => 8,
		captureTerminal: () => false,
		defaultKind: () => "ghost",
		notify: (text) => notifications.push(text),
		announce: () => {},
		emitText: () => {},
	});

	await commands.spawn("do work");

	assert.equal(setup.spawned[0]?.kind, "default");
	assert.deepEqual(notifications, ["Docket: configured default worker kind \"ghost\" not found. Falling back to default."]);
});

test("Worker Commands sends parent messages to workers", async () => {
	const waiting: WorkerStatus = { ...worker, state: "needs_input", questions: [
		{ id: "q1", text: "Include checkpoint flow?", createdAt: "2026-01-01T00:00:00.000Z" },
		{ id: "q2", text: "Inspect prompt chips too?", createdAt: "2026-01-01T00:01:00.000Z" },
	] };
	const { commands, sent, announcements } = deps([waiting]);

	await commands.tell("w2", "include checkpoint flow only");

	assert.deepEqual(sent, [{ id: "worker-1", text: "Parent message for 2 questions: 1) Include checkpoint flow? 2) Inspect prompt chips too? Message: include checkpoint flow only" }]);
	assert.equal(announcements[0]?.subject, "told w2");
});

test("Worker Commands lists workers", async () => {
	const { commands, emitted } = deps();

	await commands.list();

	assert.equal(emitted.length, 1);
	assert.match(emitted[0]!, /w2\s+active\s+default\s+3 artifacts/);
});

test("Worker Commands loads and unloads worker artifacts", async () => {
	const { commands, loaded, unloaded, announcements } = deps();

	await commands.load("w2");
	await commands.unload("w2");

	assert.deepEqual(loaded, ["worker-1"]);
	assert.deepEqual(unloaded, ["worker-1"]);
	assert.equal(announcements[0]?.subject, "loaded w2 · 1 artifact");
	assert.match(announcements[0]?.detail ?? "", /refs: @w2\.<id>/);
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

	assert.deepEqual(notifications, ["Docket worker not found"]);
});

test("workerCompletionCandidates returns recent worker labels", async () => {
	const { store } = fakeStore([worker]);

	assert.deepEqual(await workerCompletionCandidates(store), [{ value: "w2", label: "w2  active  inspect bug now please" }]);
});
