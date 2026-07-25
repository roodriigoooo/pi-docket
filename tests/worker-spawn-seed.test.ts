import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerCommands } from "../extensions/worker-commands.js";
import type { Artifact } from "../extensions/types.js";
import type { SpawnInput, WorkerStatus, WorkerStore } from "../extensions/worker-store.js";
import { createWorkerKindRegistry, type WorkerKindRegistry } from "../extensions/worker-kinds.js";

const executionDeps = {
	parentModel: () => "anthropic/claude-sonnet",
	parentThinking: () => "high",
	availableModels: () => [{ provider: "anthropic", id: "claude-sonnet", reasoning: true }],
	hasUI: false,
	confirmSpawn: async () => true,
};

/**
 * End-to-end matrix for the spawn seed-decision: the only behavior that matters at
 * this layer is whether `parentSession` reaches `store.spawn` (seeding) and whether
 * the `fresh` flag is set (blank session). Everything else is pass-through.
 *
 * Precedence under test:
 *   --fresh  -> fresh (never seed), regardless of kind
 *   --seed   -> seed, regardless of kind
 *   otherwise -> kind.parentSeedPolicy (default kind = none)
 */

const baseWorker: WorkerStatus = {
	id: "worker-1",
	index: 2,
	tmuxSession: "docket-workers:w2",
	task: "x",
	cwd: "/repo",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: new Date().toISOString(),
	state: "active",
	artifactCount: 0,
};

function fakeStore(): { store: WorkerStore; spawned: SpawnInput[] } {
	const spawned: SpawnInput[] = [];
	const store = {
		root: () => "/tmp/workers",
		dirFor: (id: string) => `/tmp/workers/${id}`,
		statusFile: (id: string) => `/tmp/workers/${id}/status.json`,
		artifactsFile: (id: string) => `/tmp/workers/${id}/artifacts.json`,
		taskFile: (id: string) => `/tmp/workers/${id}/task.md`,
		deliverablesDir: (id: string) => `/tmp/workers/${id}/deliverables`,
		deliverableFile: (id: string, version: number) => `/tmp/workers/${id}/deliverables/v${version}.json`,
		readDeliverable: async () => undefined,
		readCurrentDeliverable: async () => undefined,
		list: async () => [baseWorker],
		find: async (id: string) => (id === "worker-1" || id === "w2" ? baseWorker : undefined),
		readArtifacts: async () => [] as Artifact[],
		writeStatus: async () => {},
		patchStatus: async () => undefined,
		updateStatus: async () => ({ before: undefined, after: undefined, changed: false }),
		writeArtifacts: async () => {},
		addQuestion: async () => undefined,
		sendInput: async () => true,
		spawn: async (input: SpawnInput) => { spawned.push(input); return { ...baseWorker, state: "starting" }; },
		kill: async () => true,
		purge: async (id: string) => [id],
		countActive: async () => 0,
		respawn: async () => baseWorker,
		harvestPaneTail: async () => "window_gone" as const,
		readPaneTail: async () => undefined,
	} satisfies WorkerStore;
	return { store, spawned };
}

function buildCommands(store: WorkerStore, kinds: WorkerKindRegistry) {
	return createWorkerCommands({
		...executionDeps,
		store,
		loadedArtifacts: {
			loadSource: async () => { throw new Error("unused"); },
			unloadSource: () => undefined,
		},
		cwd: "/repo",
		parentSession: "/parent/session.json",
		kinds,
		maxActive: () => 8,
		notify: () => {},
		announce: () => {},
		emitText: () => {},
	});
}

type Scenario = {
	name: string;
	kind?: string;
	fresh?: boolean;
	seed?: boolean;
	expectSeeded: boolean;
};

const registryWith = (name: string, policy: "full" | "none"): WorkerKindRegistry => {
	const reg = createWorkerKindRegistry();
	reg.register({
		name,
		readOnly: false,
		defaultWorktree: true,
		parentSeedPolicy: policy,
		canSpawn: [],
		layout: "single",
		source: "runtime",
	});
	return reg;
};

const scenarios: Scenario[] = [
	{ name: "default kind → fresh", expectSeeded: false },
	{ name: "default kind + --seed → seeded", seed: true, expectSeeded: true },
	{ name: "default kind + --fresh → fresh", fresh: true, expectSeeded: false },
	{ name: "full kind → seeded", kind: "seedy", expectSeeded: true },
	{ name: "full kind + --fresh → fresh", kind: "seedy", fresh: true, expectSeeded: false },
	{ name: "full kind + --seed → seeded", kind: "seedy", seed: true, expectSeeded: true },
	{ name: "none kind → fresh", kind: "clean", expectSeeded: false },
	{ name: "none kind + --seed → seeded", kind: "clean", seed: true, expectSeeded: true },
	{ name: "none kind + --fresh → fresh", kind: "clean", fresh: true, expectSeeded: false },
];

for (const scenario of scenarios) {
	test(`spawn seed-decision: ${scenario.name}`, async () => {
		const { store, spawned } = fakeStore();
		const kinds = scenario.kind === "seedy"
			? registryWith("seedy", "full")
			: scenario.kind === "clean"
				? registryWith("clean", "none")
				: createWorkerKindRegistry();
		const commands = buildCommands(store, kinds);

		await commands.spawn("do work", {
			...(scenario.fresh ? { fresh: true } : {}),
			...(scenario.seed ? { seed: true } : {}),
			...(scenario.kind ? { as: scenario.kind } : {}),
		});

		assert.equal(spawned.length, 1, "spawn reached the store exactly once");
		const input = spawned[0]!;
		if (scenario.expectSeeded) {
			assert.equal(input.parentSession, "/parent/session.json", "parent session seeded");
			assert.equal(input.fresh, undefined, "fresh flag must be absent when seeding");
		} else {
			assert.equal(input.parentSession, undefined, "no parent session when fresh");
			assert.equal(input.fresh, true, "fresh flag must be true when not seeding");
		}
	});
}

test("spawn seed-decision: --fresh wins over --seed when both passed", async () => {
	const { store, spawned } = fakeStore();
	const commands = buildCommands(store, createWorkerKindRegistry());
	await commands.spawn("do work", { fresh: true, seed: true });
	assert.equal(spawned[0]?.parentSession, undefined);
	assert.equal(spawned[0]?.fresh, true);
});

test("spawn seed-decision: missing parent session still degrades to fresh safely", async () => {
	const { store, spawned } = fakeStore();
	const commands = createWorkerCommands({
		...executionDeps,
		store,
		loadedArtifacts: { loadSource: async () => { throw new Error("unused"); }, unloadSource: () => undefined },
		cwd: "/repo",
		kinds: createWorkerKindRegistry(),
		maxActive: () => 8,
		notify: () => {},
		announce: () => {},
		emitText: () => {},
	});
	// No parentSession wired; --seed should still not crash, and must not seed.
	await commands.spawn("do work", { seed: true });
	assert.equal(spawned[0]?.parentSession, undefined);
	assert.equal(spawned[0]?.fresh, true);
});

test("spawn seed-decision: config parentSeedPolicy=full seeds default kind", async () => {
	const { store, spawned } = fakeStore();
	const commands = buildCommands(store, createWorkerKindRegistry());
	const commandsSeeded = createWorkerCommands({
		...executionDeps,
		store,
		loadedArtifacts: { loadSource: async () => { throw new Error("unused"); }, unloadSource: () => undefined },
		cwd: "/repo",
		parentSession: "/parent/session.json",
		kinds: createWorkerKindRegistry(),
		maxActive: () => 8,
		parentSeedPolicy: () => "full",
		notify: () => {},
		announce: () => {},
		emitText: () => {},
	});
	// default kind alone = fresh
	await commands.spawn("x");
	assert.equal(spawned[0]?.parentSession, undefined);
	assert.equal(spawned[0]?.fresh, true);
	// config full flips default kind to seeded
	await commandsSeeded.spawn("x");
	assert.equal(spawned[1]?.parentSession, "/parent/session.json");
	assert.equal(spawned[1]?.fresh, undefined);
	// --fresh still wins over config full
	await commandsSeeded.spawn("y", { fresh: true });
	assert.equal(spawned[2]?.parentSession, undefined);
	assert.equal(spawned[2]?.fresh, true);
});
