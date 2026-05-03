import test from "node:test";
import assert from "node:assert/strict";
import { createCheckpointLifecycle } from "../extensions/checkpoint-lifecycle.js";
import type { Artifact } from "../extensions/types.js";

const artifact: Artifact = {
	id: "c1",
	displayId: "c1",
	ref: "command:t1:0",
	kind: "command",
	title: "$ npm test",
	subtitle: "failed · cwd /repo",
	body: "command: npm test\nstatus: error\n\nboom",
	entryId: "t1",
	timestamp: Date.parse("2026-01-01T00:00:00Z"),
	meta: { command: "npm test" },
};

function config(enabled = false) {
	return {
		maxArtifacts: 50,
		maxBodyChars: 2000,
		checkpointArtifacts: 24,
		consumedRetentionDays: 7,
		summarizer: {
			enabled,
			maxOutputTokens: 1200,
			maxInputChars: 36000,
			timeoutMs: 120000,
		},
	};
}

function ctx(hasUI = false) {
	return {
		cwd: "/repo",
		hasUI,
		ui: {
			notify() {},
			editor: async () => "edited",
		},
		sessionManager: {
			getSessionFile: () => "/sessions/source.json",
			getLeafId: () => "leaf-1",
			getBranch: () => [],
		},
		getContextUsage: () => ({ tokens: 42, contextWindow: 1000 }),
		model: undefined,
		modelRegistry: {},
	} as any;
}

function pi() {
	const appended: Array<{ customType: string; data: unknown }> = [];
	const labels: Array<{ leaf: string; label: string }> = [];
	return {
		appended,
		labels,
		api: {
			appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
			setLabel: (leaf: string, label: string) => labels.push({ leaf, label }),
			sendMessage() {},
		} as any,
	};
}

function store() {
	const saves: any[] = [];
	return {
		saves,
		store: {
			save: async (input: any) => {
				saves.push(input);
				return { id: input.id, mode: input.mode, file: `/tmp/${input.id}.md`, createdAt: "2026-01-01T00:00:00.000Z", cwd: input.cwd, note: input.note, consumeOnUse: input.consumeOnUse };
			},
			find: async () => undefined,
			list: async () => [],
			listSummaries: async () => [],
			readMarkdown: async () => "",
			readArtifacts: async () => [],
			markConsumed: async () => {},
			purge: async () => {},
			sweepConsumed: async () => 0,
			artifactsFile: (id: string) => `/tmp/${id}.artifacts.json`,
		},
	};
}

function catalog(artifacts: Artifact[]) {
	return {
		list: () => artifacts,
		find: () => undefined,
		reference: () => "ref",
		fullText: () => "full",
		inspect: async () => ({ title: "inspect", text: "text" }),
		search: async () => [],
		selectForCheckpoint: () => artifacts,
		checkpointPayload: () => artifacts,
		summary: (a: Artifact) => a,
	} as any;
}

const options = { mode: "handoff" as const, note: "fix tests", consumeOnUse: false, raw: true };

test("Checkpoint Lifecycle warns and does not persist when no artifacts selected", async () => {
	const fakePi = pi();
	const fakeStore = store();
	const notifications: string[] = [];
	const lifecycle = await createCheckpointLifecycle(fakePi.api, ctx(), {
		loadConfig: async () => config(false),
		createCatalog: () => catalog([]),
		store: fakeStore.store,
		makeId: () => "ck-test",
		notify: (text) => notifications.push(text),
	});

	await lifecycle.create(options);
	assert.deepEqual(fakeStore.saves, []);
	assert.deepEqual(fakePi.appended, []);
	assert.deepEqual(notifications, ["Trail found no artifacts to checkpoint"]);
});

test("Checkpoint Lifecycle raw flow saves checkpoint, appends session entry, and labels leaf", async () => {
	const fakePi = pi();
	const fakeStore = store();
	const notifications: string[] = [];
	const lifecycle = await createCheckpointLifecycle(fakePi.api, ctx(), {
		loadConfig: async () => config(false),
		createCatalog: () => catalog([artifact]),
		store: fakeStore.store,
		makeId: () => "ck-test",
		notify: (text) => notifications.push(text),
	});

	await lifecycle.create(options);
	assert.equal(fakeStore.saves.length, 1);
	assert.equal(fakeStore.saves[0].id, "ck-test");
	assert.match(fakeStore.saves[0].markdown, /# Trail checkpoint ck-test/);
	assert.match(fakeStore.saves[0].markdown, /note: fix tests/);
	assert.match(fakeStore.saves[0].markdown, /\$ npm test/);
	assert.deepEqual(fakePi.appended.map((entry) => entry.customType), ["trail:checkpoint"]);
	assert.deepEqual(fakePi.labels, [{ leaf: "leaf-1", label: "trail:ck-test" }]);
	assert.deepEqual(notifications, ["Trail checkpoint saved: ck-test"]);
});

test("Checkpoint Lifecycle saves only artifacts accepted by selector", async () => {
	const fakePi = pi();
	const fakeStore = store();
	const fileArtifact: Artifact = { ...artifact, id: "f2", displayId: "f2", ref: "file:t2:0", kind: "file", title: "edit src/a.ts" };
	const lifecycle = await createCheckpointLifecycle(fakePi.api, ctx(), {
		loadConfig: async () => config(false),
		createCatalog: () => catalog([artifact, fileArtifact]),
		store: fakeStore.store,
		makeId: () => "ck-test",
		selectArtifactsForCheckpoint: async (artifacts) => [artifacts[1]!],
		notify: () => {},
	});

	await lifecycle.create(options);
	assert.equal(fakeStore.saves.length, 1);
	assert.deepEqual(fakeStore.saves[0].artifacts.map((saved: Artifact) => saved.ref), ["file:t2:0"]);
	assert.match(fakeStore.saves[0].markdown, /edit src\/a\.ts/);
	assert.doesNotMatch(fakeStore.saves[0].markdown, /\$ npm test/);
});

test("Checkpoint Lifecycle cancel during artifact selection does not persist", async () => {
	const fakePi = pi();
	const fakeStore = store();
	const notifications: string[] = [];
	const lifecycle = await createCheckpointLifecycle(fakePi.api, ctx(), {
		loadConfig: async () => config(false),
		createCatalog: () => catalog([artifact]),
		store: fakeStore.store,
		makeId: () => "ck-test",
		selectArtifactsForCheckpoint: async () => null,
		notify: (text) => notifications.push(text),
	});

	await lifecycle.create(options);
	assert.deepEqual(fakeStore.saves, []);
	assert.deepEqual(fakePi.appended, []);
	assert.deepEqual(notifications, ["Trail checkpoint cancelled"]);
});

test("Checkpoint Lifecycle cancel during review does not persist", async () => {
	const fakePi = pi();
	const fakeStore = store();
	const notifications: string[] = [];
	const lifecycle = await createCheckpointLifecycle(fakePi.api, ctx(true), {
		loadConfig: async () => config(false),
		createCatalog: () => catalog([artifact]),
		store: fakeStore.store,
		makeId: () => "ck-test",
		reviewMarkdown: async () => null,
		selectArtifactsForCheckpoint: async (artifacts) => artifacts,
		notify: (text) => notifications.push(text),
	});

	await lifecycle.create(options);
	assert.deepEqual(fakeStore.saves, []);
	assert.deepEqual(fakePi.appended, []);
	assert.deepEqual(notifications, ["Trail checkpoint cancelled"]);
});

test("Checkpoint Lifecycle falls back to raw markdown when summarizer fails", async () => {
	const fakePi = pi();
	const fakeStore = store();
	const notifications: string[] = [];
	const lifecycle = await createCheckpointLifecycle(fakePi.api, ctx(), {
		loadConfig: async () => config(true),
		createCatalog: () => catalog([artifact]),
		store: fakeStore.store,
		summarizer: { summarize: async () => { throw new Error("model down"); } },
		makeId: () => "ck-test",
		notify: (text) => notifications.push(text),
	});

	await lifecycle.create({ ...options, raw: false });
	assert.equal(fakeStore.saves.length, 1);
	assert.match(fakeStore.saves[0].markdown, /# Trail checkpoint ck-test/);
	assert.match(notifications[0] ?? "", /Trail summarizer failed; using raw checkpoint: Error: model down/);
});
