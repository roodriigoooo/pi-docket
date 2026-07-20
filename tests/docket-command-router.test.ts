import test from "node:test";
import assert from "node:assert/strict";
import { createDocketCommandRouter, type DocketCommandRouterDeps } from "../extensions/docket-command-router.js";
import type { ArtifactCatalog } from "../extensions/artifact-catalog.js";
import type { CheckpointCommands } from "../extensions/checkpoint-commands.js";
import type { CheckpointStore, CheckpointSummary } from "../extensions/checkpoint-store.js";
import type { LoadedArtifactContext, LoadableSource } from "../extensions/loaded-artifact-context.js";
import type { Artifact, CheckpointIndexEntry } from "../extensions/types.js";
import type { WorkerCommands } from "../extensions/worker-commands.js";
import type { WorkerStatus, WorkerStore } from "../extensions/worker-store.js";
import type { DecisionEvent, DecisionRecord } from "../extensions/decision-log.js";
import type { WorkerDeliverable } from "../extensions/worker-deliverable.js";
import { findVerdictWorker, type WorkerVerdictDeps } from "../extensions/worker-verdict.js";

const artifact: Artifact = { id: "a1", displayId: "a1", ref: "command:1", kind: "command", title: "npm test", subtitle: "", body: "passed", timestamp: 1 };
const checkpoint: CheckpointIndexEntry = { id: "ck-1", mode: "handoff", file: "/tmp/ck.md", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/repo", consumeOnUse: true };
const summary: CheckpointSummary = { entry: checkpoint, artifactCount: 1, estimatedTokens: 1, files: 0, errors: 0, commands: 0 };
const worker: WorkerStatus = { id: "worker-1", index: 2, tmuxSession: "docket-worker-1", task: "inspect bug", cwd: "/repo", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", state: "ready", summary: "ship the fix" };
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

function harness(overrides: Partial<DocketCommandRouterDeps> = {}) {
	const calls: string[] = [];
	const decisions: DecisionRecord[] = [];
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
		spawn: async () => { calls.push("worker.spawn"); return undefined; },
		tell: async () => { calls.push("worker.tell"); },
		list: async () => { calls.push("worker.list"); },
		listKinds: async () => { calls.push("worker.listKinds"); },
		delete: async () => { calls.push("worker.delete"); },
		respawn: async () => { calls.push("worker.respawn"); },
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
		readCurrentDeliverable: async () => undefined,
	} as unknown as WorkerStore;
	const deps: DocketCommandRouterDeps = {
		hasUI: false,
		workerCommands,
		checkpointCommands,
		loadedArtifacts,
		workerStore,
		checkpointStore,
		notify: (text) => { calls.push(`notify:${text}`); },
		emitText: (_text, kind, heading) => { calls.push(`emit:${kind}:${heading ?? ""}`); },
		announce: (subject) => { calls.push(`announce:${subject}`); },
		docketUsage: () => "usage",
		renderArtifactList: () => "artifacts",
		renderParallelWorkList: () => "workers",
		formatArtifact: (item) => item.title,
		refreshChipWidget: () => { calls.push("refreshChips"); },
		refreshWorkerDockWidget: async () => { calls.push("refreshWorkers"); },
		refreshWorkerCarryoverForReview: async () => { calls.push("refreshCarryover"); },
		showWorkerResult: () => { calls.push("showWorkerResult"); },
		clearWorkerResult: () => { calls.push("clearWorkerResult"); return false; },
		markArtifactDone: (item) => { calls.push(`done:${item.ref}`); },
		markWorkerLoaded: (item) => { calls.push(`loaded:${item.id}`); },
		markWorkerUnloaded: (item) => { calls.push(`unloaded:${item.id}`); },
		markAllWorkersUnloaded: () => { calls.push("unloaded:all"); },
		promoteWorkerChangeSet: async (item) => { calls.push(`promote:${item.ref}`); return true; },
		reviewWorkerChangeSet: async () => ({ kind: "returned" }),
		applyWorkerState: async () => { calls.push("applyWorkerState"); },
		createCheckpoint: async () => { calls.push("createCheckpoint"); },
		createHandoffCheckpoint: async () => { calls.push("createHandoffCheckpoint"); },
		catalog: async () => fakeCatalog(),
		readWorkersWithArtifacts: async () => ({ workers: [worker], artifactsByWorker: new Map([[worker.id, [artifact]]]) }),
		showParallelWorkDashboard: async () => null,
		showLoadPicker: async () => null,
		showText: async () => { calls.push("showText"); },
		showDocketBrowser: async () => null,
		showVerdict: async () => null,
		showReport: async () => { calls.push("showReport"); },
		showArtifact: async () => { calls.push("showArtifact"); },
		openFileOrArtifact: async () => { calls.push("openFileOrArtifact"); },
		input: async () => undefined,
		confirmDeleteWorker: async () => true,
		copyText: async () => { calls.push("copyText"); return true; },
		announceChipChange: () => { calls.push("announceChip"); },
		parallelKindLabel: (kind) => kind,
		// Decisions land in their own array so existing call-order assertions stay stable.
		recordDecision: async (record) => { decisions.push(record); },
		readDecisionEvents: async () => [],
		...overrides,
	};
	return { calls, decisions, deps, router: createDocketCommandRouter(deps) };
}

test("Docket Command Router handles clear through loaded artifact context", async () => {
	const { calls, router } = harness();
	await router.handle({ kind: "clear" });
	assert.deepEqual(calls, ["clearChips", "refreshChips", "clearWorkerResult", "notify:Docket cleared"]);
});

test("Docket Command Router loads default checkpoint without UI", async () => {
	const { calls, router } = harness();
	await router.handle({ kind: "load", refKind: "checkpoint" });
	assert.deepEqual(calls, ["loadSource:checkpoint", "announce:loaded c1 · 1 artifact"]);
});

test("Docket Command Router marks explicit worker load", async () => {
	const { calls, decisions, deps, router } = harness();
	await router.handle({ kind: "load", refKind: "worker", ref: "w2", includeConsumed: false });
	assert.deepEqual(calls, ["loadSource:worker", "loaded:worker-1", "announce:loaded w2 · 1 artifact", "refreshWorkers"]);
	assert.equal(worker.state, "ready");
	assert.equal(worker.reviewedAt, undefined);
	assert.equal(decisions.length, 0);
	const verdictWorker = await findVerdictWorker({ workerStore: deps.workerStore, projectRoot: "/repo" } as unknown as WorkerVerdictDeps);
	assert.equal(verdictWorker?.id, worker.id);
});

test("Docket Command Router loads immutable deliverable instead of competing worker artifacts", async () => {
	const deliverable: WorkerDeliverable = {
		schemaVersion: 1,
		id: "worker-deliverable:worker-1",
		version: 1,
		ref: "worker-deliverable:worker-1:1",
		createdAt: "2026-01-01T00:00:00.000Z",
		source: { workerId: worker.id, workerLabel: "w2", task: worker.task },
		body: "exact body",
		summary: "summary",
		outcome: "proposal",
		evidence: [],
		recommendations: [],
		refs: [],
	};
	const workerStore = {
		find: async () => worker,
		list: async () => [worker],
		readArtifacts: async () => [workerStatus],
		readCurrentDeliverable: async () => deliverable,
	} as unknown as WorkerStore;
	const { calls, router } = harness({ workerStore });

	await router.handle({ kind: "load", refKind: "worker", ref: "w2", includeConsumed: false });

	assert.deepEqual(calls, ["loadSource:deliverable", "loaded:worker-1", "announce:loaded w2 · 1 artifact", "refreshWorkers"]);
});

test("Docket Command Router routes worker delete and refreshes dock", async () => {
	const { calls, router } = harness();
	await router.handle({ kind: "delete", target: "w2", targetKind: "worker" });
	assert.deepEqual(calls, ["worker.delete", "refreshWorkers"]);
});

test("Docket Command Router confirms dashboard stop before purging", async () => {
	const decisions: string[] = [];
	const { calls, router } = harness({
		hasUI: true,
		showParallelWorkDashboard: async () => ({ action: "stop", worker }),
		confirmDeleteWorker: async () => { decisions.push("confirm"); return false; },
	});
	await router.handle({ kind: "workers", allProjects: false });
	assert.deepEqual(decisions, ["confirm"]);
	assert.equal(calls.includes("worker.delete"), false);
});

test("Docket Command Router attaches from worker back to recorded parent target", async () => {
	const copied: string[] = [];
	const currentWorker: WorkerStatus = { ...worker, id: "current-worker", index: 1, parentTmuxTarget: "parent-session:3.0" };
	const workerStore = {
		find: async (id: string) => id === currentWorker.id ? currentWorker : undefined,
		list: async () => [currentWorker],
		readArtifacts: async () => [],
	} as unknown as WorkerStore;
	const { calls, router } = harness({
		workerId: currentWorker.id,
		workerStore,
		copyText: async (text) => { copied.push(text); return true; },
	});

	const priorTmux = process.env.TMUX;
	delete process.env.TMUX;
	try {
		await router.handle({ kind: "attach", worker: "parent" });
	} finally {
		if (priorTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = priorTmux;
	}

	assert.deepEqual(copied, ["tmux attach -t parent-session:3.0"]);
	assert.deepEqual(calls, ["notify:Copied: tmux attach -t parent-session:3.0"]);
});

test("Docket Command Router handles artifact ref chips through context", async () => {
	const { calls, router } = harness();
	await router.handle({ kind: "artifact", action: "ref", idOrRef: "a1" });
	assert.deepEqual(calls, ["done:command:1", "toggleChip", "refreshChips", "announceChip"]);
});

test("Docket Command Router routes spawn intent and forwards seed/fresh flags to worker spawn", async () => {
	const captured: Array<{ task: string; fresh?: boolean; seed?: boolean; as?: string }> = [];
	const spawnCommands: WorkerCommands = {
		spawn: async (task, options) => { captured.push({ task, fresh: options?.fresh, seed: options?.seed, as: options?.as }); return undefined; },
		tell: async () => {},
		list: async () => {},
		listKinds: async () => {},
		delete: async () => {},
		respawn: async () => {},
		load: async () => {},
		unload: async () => {},
		completionCandidates: async () => [],
	};
	const { router } = harness({ workerCommands: spawnCommands });

	await router.handle({ kind: "spawn", task: "map callers", seed: true });
	await router.handle({ kind: "spawn", task: "recon", fresh: true, as: "scout" });
	await router.handle({ kind: "spawn", task: "plain" });

	assert.deepEqual(captured, [
		{ task: "map callers", seed: true, fresh: false, as: undefined },
		{ task: "recon", fresh: true, seed: false, as: "scout" },
		{ task: "plain", fresh: false, seed: false, as: undefined },
	]);
});

test("Docket Command Router verdict accept approves waiting worker without loading artifacts", async () => {
	const waiting: WorkerStatus = { ...worker, state: "needs_input", question: "Proceed?" };
	const { calls, router } = harness({
		hasUI: true,
		workerStore: { find: async () => waiting, list: async () => [waiting], readArtifacts: async () => [] } as unknown as WorkerStore,
		showVerdict: async () => ({ verb: "accept", worker: waiting }),
	});

	await router.handle({ kind: "verdict", worker: "w2" });

	assert.deepEqual(calls, ["worker.tell", "refreshWorkers"]);
});

test("Docket Command Router routes worker dashboard verdict actions", async () => {
	const waiting: WorkerStatus = { ...worker, state: "needs_input", question: "Proceed?" };
	const { calls, router } = harness({
		hasUI: true,
		workerStore: { find: async () => waiting, list: async () => [waiting], readArtifacts: async () => [] } as unknown as WorkerStore,
		readWorkersWithArtifacts: async () => ({ workers: [waiting], artifactsByWorker: new Map([[waiting.id, []]]) }),
		showParallelWorkDashboard: async () => ({ action: "verdict", worker: waiting }),
		showVerdict: async () => ({ verb: "accept", worker: waiting }),
	});

	await router.handle({ kind: "workers" });

	assert.deepEqual(calls, ["worker.tell", "refreshWorkers"]);
});

test("Docket Command Router records a verdict in the decision ledger", async () => {
	const waiting: WorkerStatus = { ...worker, state: "needs_input", question: "Proceed?" };
	const { decisions, router } = harness({
		hasUI: true,
		workerStore: { find: async () => waiting, list: async () => [waiting], readArtifacts: async () => [] } as unknown as WorkerStore,
		showVerdict: async () => ({ verb: "accept", worker: waiting }),
	});

	await router.handle({ kind: "verdict", worker: "w2" });

	assert.equal(decisions.length, 1);
	assert.equal(decisions[0]?.verb, "accept");
	assert.equal(decisions[0]?.workerId, "worker-1");
	assert.equal(decisions[0]?.state, "needs_input");
});

test("Docket Command Router logs option-send verdicts with the option text", async () => {
	const waiting: WorkerStatus = { ...worker, state: "needs_input", question: "Pick one" };
	const { calls, decisions, router } = harness({
		hasUI: true,
		workerStore: { find: async () => waiting, list: async () => [waiting], readArtifacts: async () => [] } as unknown as WorkerStore,
		showVerdict: async () => ({ verb: "send", worker: waiting, text: "use postgres" }),
	});

	await router.handle({ kind: "verdict", worker: "w2" });

	assert.deepEqual(calls, ["worker.tell", "refreshWorkers"]);
	assert.equal(decisions[0]?.verb, "send");
	assert.equal(decisions[0]?.option, "use postgres");
});

test("Docket Command Router decisions lens renders the ledger via showText", async () => {
	const events: DecisionEvent[] = [
		{ type: "verdict_resolved", timestamp: new Date().toISOString(), workerId: "worker-1", workerLabel: "w1", state: "ready", verb: "accept", evidenceRefs: [] },
		{ type: "worker_evicted_unreviewed", timestamp: new Date().toISOString(), workerId: "worker-2", workerLabel: "w2", state: "ended", reason: "pruned" },
	];
	let shown: { title: string; body: string } | undefined;
	const { router } = harness({
		hasUI: true,
		readDecisionEvents: async () => events,
		showText: async (title, body) => { shown = { title, body }; },
	});

	await router.handle({ kind: "decisions" });

	assert.equal(shown?.title, "docket · decisions");
	assert.match(shown?.body ?? "", /1 resolved · 1 evicted unreviewed/);
	assert.match(shown?.body ?? "", /decision debt/);
});
