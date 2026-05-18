import test from "node:test";
import assert from "node:assert/strict";
import { createTrailCommandRouter, type TrailCommandRouterDeps } from "../extensions/trail-command-router.js";
import type { ArtifactCatalog } from "../extensions/artifact-catalog.js";
import type { CheckpointCommands } from "../extensions/checkpoint-commands.js";
import type { CheckpointStore, CheckpointSummary } from "../extensions/checkpoint-store.js";
import type { LoadedArtifactContext, LoadableSource } from "../extensions/loaded-artifact-context.js";
import type { Artifact, CheckpointIndexEntry } from "../extensions/types.js";
import type { WorkerCommands } from "../extensions/worker-commands.js";
import type { WorkerStatus, WorkerStore } from "../extensions/worker-store.js";

const artifact: Artifact = { id: "a1", displayId: "a1", ref: "command:1", kind: "command", title: "npm test", subtitle: "", body: "passed", timestamp: 1 };
const checkpoint: CheckpointIndexEntry = { id: "ck-1", mode: "handoff", file: "/tmp/ck.md", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/repo", consumeOnUse: true };
const summary: CheckpointSummary = { entry: checkpoint, artifactCount: 1, estimatedTokens: 1, files: 0, errors: 0, commands: 0 };
const worker: WorkerStatus = { id: "worker-1", index: 2, tmuxSession: "trail-worker-1", task: "inspect bug", cwd: "/repo", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", state: "ready", summary: "ship the fix" };
const workerStatus: Artifact = { id: "w2.status", displayId: "w2.status", ref: "worker-status:worker-1:0", kind: "response", title: "w2 ready: ship the fix", subtitle: "inspect bug", body: "worker: w2\nstate: ready\nmessage:\nship the fix", timestamp: 1, meta: { workerId: "worker-1", workerLabel: "w2", workerStatus: "ready", summary: "ship the fix" } };

function fakeCatalog(): ArtifactCatalog {
	return {
		list: () => [artifact],
		find: (idOrRef) => idOrRef === artifact.id || idOrRef === artifact.ref ? artifact : undefined,
		reference: (item) => `ref:${item.displayId}`,
		fullText: (item) => `full:${item.displayId}`,
		inspect: async () => ({ title: "", text: "" }),
		search: async () => [artifact],
		selectForCheckpoint: () => [],
		checkpointPayload: () => [],
		summary: (item) => item,
	};
}

function harness(overrides: Partial<TrailCommandRouterDeps> = {}) {
	const calls: string[] = [];
	const loadedArtifacts = {
		clearChips: () => { calls.push("clearChips"); return true; },
		defaultLoadSource: ({ checkpoints, workers }: { checkpoints: CheckpointIndexEntry[]; workers: WorkerStatus[] }): LoadableSource | undefined => checkpoints[0] ? { kind: "checkpoint", checkpoint: checkpoints[0] } : workers[0] ? { kind: "worker", worker: workers[0] } : undefined,
		loadSource: async (source: LoadableSource) => {
			calls.push(`loadSource:${source.kind}`);
			return { source, queuedConsume: source.kind === "checkpoint", slot: { slot: source.kind === "checkpoint" ? "c1" : "w2", kind: source.kind, sourceId: source.kind === "checkpoint" ? source.checkpoint.id : source.worker.id, artifacts: source.kind === "worker" ? [workerStatus] : [artifact] } };
		},
		toggleChip: () => { calls.push("toggleChip"); return "added" as const; },
		slots: () => [],
		unloadSlot: () => undefined,
		unloadSource: () => undefined,
		chips: () => [],
		carryoverArtifacts: () => [],
		reset: () => {},
		loadCheckpoint: async () => ({ slot: "c1", kind: "checkpoint" as const, sourceId: checkpoint.id, artifacts: [artifact], checkpoint }),
		loadWorker: async () => ({ slot: "w2", kind: "worker" as const, sourceId: worker.id, artifacts: [artifact] }),
		queueCheckpointConsume: () => {},
		drainCheckpointConsumes: async () => {},
		expandChipsForSubmit: async (_ctx: unknown, text: string) => ({ text, expanded: 0, missing: [] }),
	} as unknown as LoadedArtifactContext;
	const workerCommands = {
		spawn: async () => { calls.push("worker.spawn"); },
		tell: async () => { calls.push("worker.tell"); },
		list: async () => { calls.push("worker.list"); },
		delete: async () => { calls.push("worker.delete"); },
		load: async () => { calls.push("worker.load"); },
		unload: async () => { calls.push("worker.unload"); },
		completionCandidates: async () => [],
	} satisfies WorkerCommands;
	const checkpointCommands = {
		continue: async () => { calls.push("checkpoint.continue"); },
		delete: async () => true,
		list: async () => { calls.push("checkpoint.list"); },
	} satisfies CheckpointCommands;
	const checkpointStore = {
		find: async () => checkpoint,
		listSummaries: async () => [summary],
		readMarkdown: async () => "markdown",
	} as unknown as CheckpointStore;
	const workerStore = {
		find: async () => worker,
		list: async () => [worker],
		readArtifacts: async () => [workerStatus],
	} as unknown as WorkerStore;
	const deps: TrailCommandRouterDeps = {
		hasUI: false,
		workerCommands,
		checkpointCommands,
		loadedArtifacts,
		workerStore,
		checkpointStore,
		notify: (text) => { calls.push(`notify:${text}`); },
		emitText: (_text, kind, heading) => { calls.push(`emit:${kind}:${heading ?? ""}`); },
		announce: (subject) => { calls.push(`announce:${subject}`); },
		trailUsage: () => "usage",
		renderArtifactList: () => "artifacts",
		renderParallelWorkList: () => "workers",
		formatArtifact: (item) => item.title,
		refreshChipWidget: () => { calls.push("refreshChips"); },
		refreshWorkerDockWidget: async () => { calls.push("refreshWorkers"); },
		refreshWorkerCarryoverForReview: async () => { calls.push("refreshCarryover"); },
		showWorkerResult: () => { calls.push("showWorkerResult"); },
		clearWorkerResult: () => { calls.push("clearWorkerResult"); return false; },
		markArtifactDone: (item) => { calls.push(`done:${item.ref}`); },
		promoteWorkerChangeSet: async (item) => { calls.push(`promote:${item.ref}`); return true; },
		applyWorkerState: async () => { calls.push("applyWorkerState"); },
		createCheckpoint: async () => { calls.push("createCheckpoint"); },
		createHandoffCheckpoint: async () => { calls.push("createHandoffCheckpoint"); },
		catalog: async () => fakeCatalog(),
		readWorkersWithArtifacts: async () => ({ workers: [worker], artifactsByWorker: new Map([[worker.id, [artifact]]]) }),
		showParallelWorkDashboard: async () => null,
		showLoadPicker: async () => null,
		showText: async () => { calls.push("showText"); },
		showTrailBrowser: async () => null,
		showArtifact: async () => { calls.push("showArtifact"); },
		openFileOrArtifact: async () => { calls.push("openFileOrArtifact"); },
		input: async () => undefined,
		copyText: async () => { calls.push("copyText"); return true; },
		announceChipChange: () => { calls.push("announceChip"); },
		parallelKindLabel: (kind) => kind,
		...overrides,
	};
	return { calls, router: createTrailCommandRouter(deps) };
}

test("Trail Command Router handles clear through loaded artifact context", async () => {
	const { calls, router } = harness();
	await router.handle({ kind: "clear" });
	assert.deepEqual(calls, ["clearChips", "refreshChips", "clearWorkerResult", "notify:Trail cleared"]);
});

test("Trail Command Router loads default checkpoint without UI", async () => {
	const { calls, router } = harness();
	await router.handle({ kind: "load", refKind: "checkpoint" });
	assert.deepEqual(calls, ["loadSource:checkpoint", "announce:loaded c1 · 1 artifact"]);
});

test("Trail Command Router routes worker delete and refreshes dock", async () => {
	const { calls, router } = harness();
	await router.handle({ kind: "delete", target: "w2", targetKind: "worker" });
	assert.deepEqual(calls, ["worker.delete", "refreshWorkers"]);
});

test("Trail Command Router shows worker result without UI", async () => {
	const { calls, router } = harness();
	await router.handle({ kind: "worker-result", worker: "w2", action: "show" });
	assert.deepEqual(calls, ["emit:list:trail · w2"]);
});

test("Trail Command Router uses worker result as a prompt chip", async () => {
	const { calls, router } = harness();
	await router.handle({ kind: "worker-result", worker: "w2", action: "use" });
	assert.deepEqual(calls, ["loadSource:worker", "toggleChip", "refreshChips", "showWorkerResult", "announceChip", "refreshWorkers"]);
});

test("Trail Command Router handles artifact ref chips through context", async () => {
	const { calls, router } = harness();
	await router.handle({ kind: "artifact", action: "ref", idOrRef: "a1" });
	assert.deepEqual(calls, ["done:command:1", "toggleChip", "refreshChips", "announceChip"]);
});
