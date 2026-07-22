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
import type { DeliverableLifecycle } from "../extensions/deliverable-lifecycle.js";
import type { DeliverableStore, StoredDeliverable } from "../extensions/deliverable-store.js";
import { findVerdictWorker, type WorkerVerdictDeps } from "../extensions/worker-verdict.js";

const artifact: Artifact = { id: "a1", displayId: "a1", ref: "command:1", kind: "command", title: "npm test", subtitle: "", body: "passed", timestamp: 1 };
const checkpoint: CheckpointIndexEntry = { id: "ck-1", mode: "handoff", file: "/tmp/ck.md", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/repo", consumeOnUse: true };
const summary: CheckpointSummary = { entry: checkpoint, artifactCount: 1, estimatedTokens: 1, files: 0, errors: 0, commands: 0 };
const worker: WorkerStatus = { id: "worker-1", index: 2, tmuxSession: "docket-worker-1", task: "inspect bug", cwd: "/repo", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", state: "ready", summary: "ship the fix" };
const workerStatus: Artifact = { id: "w2.status", displayId: "w2.status", ref: "worker-status:worker-1:0", kind: "response", title: "w2 ready: ship the fix", subtitle: "inspect bug", body: "worker: w2\nstate: ready\nmessage:\nship the fix", timestamp: 1, meta: { workerId: "worker-1", workerLabel: "w2", workerStatus: "ready", summary: "ship the fix" } };
const storedDeliverable: StoredDeliverable = {
	schemaVersion: 1,
	id: "parent-20260101-abcdef",
	version: 1,
	ref: "deliverable:parent-20260101-abcdef:1",
	createdAt: "2026-01-01T00:00:00.000Z",
	savedAt: "2026-01-01T00:01:00.000Z",
	body: "durable exact body",
	summary: "durable result",
	outcome: "findings",
	evidence: [],
	recommendations: [],
	refs: [],
	source: {
		kind: "parent",
		createdAt: "2026-01-01T00:00:00.000Z",
		cwd: "/repo",
		selectedArtifact: { displayId: "a1", ref: artifact.ref, kind: artifact.kind, title: artifact.title, subtitle: artifact.subtitle, timestamp: artifact.timestamp },
	},
	reviewNotes: [],
	approval: { kind: "human", decisionId: "human-authorship:parent-20260101-abcdef", decidedAt: "2026-01-01T00:01:00.000Z", reason: "parent-authorship" },
};

function fakeCatalog(): ArtifactCatalog {
	return {
		list: () => [artifact],
		find: (idOrRef) => idOrRef === artifact.id || idOrRef === artifact.ref ? artifact : undefined,
		reference: (item) => `ref:${item.displayId}`,
		fullText: (item) => `full:${item.displayId}`,
		inspect: async () => ({ title: "", text: "" }),
		search: async () => [artifact],
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
			const slot = source.kind === "checkpoint" ? "c1" : source.kind === "stored-deliverable" ? "d1" : "w2";
			const kind = source.kind === "stored-deliverable" ? "deliverable" : source.kind;
			const sourceId = source.kind === "checkpoint" ? source.checkpoint.id : source.kind === "stored-deliverable" ? source.deliverable.ref : source.worker.id;
			const artifacts = source.kind === "worker" ? [workerStatus] : source.kind === "stored-deliverable" ? [{ ...artifact, ref: source.deliverable.ref, body: source.deliverable.body }] : [artifact];
			return { source, queuedConsume: source.kind === "checkpoint", slot: { slot, kind, sourceId, artifacts } };
		},
		toggleChip: () => { calls.push("toggleChip"); return "added" as const; },
		slots: () => [],
		unloadSlot: () => undefined,
		unloadSource: (kind: string, sourceId: string) => { calls.push(`unloadSource:${kind}:${sourceId}`); return undefined; },
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

test("Docket Command Router routes save to the durable lifecycle", async () => {
	const saved: unknown[] = [];
	const deliverableLifecycle = {
		save: async (source: unknown) => { saved.push(source); return undefined; },
		saveWorker: async () => undefined,
		saveArtifact: async () => undefined,
	} as DeliverableLifecycle;
	const { router } = harness({ deliverableLifecycle });

	await router.handle({ kind: "save", source: { kind: "worker", ref: "w2" } });

	assert.deepEqual(saved, [{ kind: "worker", ref: "w2" }]);
});

test("Docket Command Router mounts a stored deliverable without queuing model context", async () => {
	const deliverableStore = {
		find: async () => storedDeliverable,
		list: async () => [storedDeliverable],
	} as unknown as DeliverableStore;
	const { calls, router } = harness({ deliverableStore });

	await router.handle({ kind: "load", ref: storedDeliverable.ref, refKind: "deliverable" });

	assert.deepEqual(calls, ["loadSource:stored-deliverable", "announce:loaded d1 · 1 artifact"]);
	assert.equal(calls.includes("toggleChip"), false);
});

test("Docket Command Router lists and explicitly deletes durable records alongside legacy bundles", async () => {
	let listing = "";
	const deleted: string[] = [];
	const deliverableStore = {
		find: async () => storedDeliverable,
		list: async () => [storedDeliverable],
		delete: async (deliverable: StoredDeliverable) => { deleted.push(deliverable.ref); return true; },
	} as unknown as DeliverableStore;
	const checkpointStore = {
		find: async () => checkpoint,
		list: async () => [checkpoint],
		listSummaries: async () => [summary],
		readMarkdown: async () => "markdown",
	} as unknown as CheckpointStore;
	const { calls, router } = harness({
		hasUI: true,
		deliverableStore,
		checkpointStore,
		confirmDeleteDeliverable: async () => true,
		emitText: (text) => { listing = text; },
	});

	await router.handle({ kind: "list", includeConsumed: true });
	assert.match(listing, new RegExp(storedDeliverable.ref));
	assert.match(listing, /legacy bundle/);

	await router.handle({ kind: "delete", target: storedDeliverable.ref, targetKind: "deliverable" });
	assert.deepEqual(deleted, [storedDeliverable.ref]);
	assert.deepEqual(calls, [
		`unloadSource:deliverable:${storedDeliverable.ref}`,
		`notify:Docket deliverable deleted: ${storedDeliverable.ref}`,
	]);
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

test("Docket Command Router ignores legacy parentWorkerId attach fallback", async () => {
	const currentWorker = { ...worker, id: "legacy-child", index: 3, parentWorkerId: "legacy-parent" } as WorkerStatus & { parentWorkerId: string };
	const oldParent = { ...worker, id: "legacy-parent", index: 1, tmuxSession: "docket-workers:w1" };
	const workerStore = {
		find: async (id: string) => id === currentWorker.id ? currentWorker : id === oldParent.id ? oldParent : undefined,
		list: async () => [oldParent, currentWorker],
		readArtifacts: async () => [],
	} as unknown as WorkerStore;
	const { calls, router } = harness({ workerId: currentWorker.id, workerStore });

	await router.handle({ kind: "attach", worker: "parent" });

	assert.deepEqual(calls, ["notify:Docket parent tmux target not recorded for this worker"]);
});

test("Docket Command Router handles artifact ref chips through context", async () => {
	const { calls, router } = harness();
	await router.handle({ kind: "artifact", action: "ref", idOrRef: "a1" });
	assert.deepEqual(calls, ["done:command:1", "toggleChip", "refreshChips", "announceChip"]);
});

test("Docket Command Router forwards spawn execution choices", async () => {
	const captured: Array<{ task: string; fresh?: boolean; seed?: boolean; as?: string; model?: string; thinking?: string }> = [];
	const spawnCommands: WorkerCommands = {
		spawn: async (task, options) => { captured.push({ task, fresh: options?.fresh, seed: options?.seed, as: options?.as, model: options?.model, thinking: options?.thinking }); return undefined; },
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

	await router.handle({ kind: "spawn", task: "map callers", seed: true, model: "openai/gpt", thinking: "high" });
	await router.handle({ kind: "spawn", task: "recon", fresh: true, as: "scout" });
	await router.handle({ kind: "spawn", task: "plain" });

	assert.deepEqual(captured, [
		{ task: "map callers", seed: true, fresh: undefined, as: undefined, model: "openai/gpt", thinking: "high" },
		{ task: "recon", fresh: true, seed: undefined, as: "scout", model: undefined, thinking: undefined },
		{ task: "plain", fresh: undefined, seed: undefined, as: undefined, model: undefined, thinking: undefined },
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
