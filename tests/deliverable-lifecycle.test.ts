import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeliverableLifecycle } from "../extensions/deliverable-lifecycle.js";
import { createDeliverableStore } from "../extensions/deliverable-store.js";
import { workerDeliverableId, workerDeliverableRef, type WorkerDeliverable } from "../extensions/worker-deliverable.js";
import type { DecisionEvent } from "../extensions/decision-log.js";
import type { Artifact } from "../extensions/types.js";
import type { ArtifactCatalog } from "../extensions/artifact-catalog.js";
import type { WorkerStatus } from "../extensions/background-work.js";

const artifact: Artifact = {
	id: "response-1",
	displayId: "response-1",
	ref: "response:entry:0",
	kind: "response",
	title: "worker answer",
	subtitle: "answer source",
	body: "Full artifact bytes before editing",
	timestamp: 1_735_689_600_000,
};

function worker(id = "worker-1"): WorkerStatus {
	return {
		id,
		index: 1,
		tmuxSession: "docket-workers:w1",
		task: "inspect auth",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		state: "ready",
	};
}

function deliverable(workerId = "worker-1", version = 1): WorkerDeliverable {
	return {
		schemaVersion: 1,
		id: workerDeliverableId(workerId),
		version,
		ref: workerDeliverableRef(workerId, version),
		createdAt: "2026-01-02T00:00:00.000Z",
		source: { workerId, workerLabel: "w1", task: "inspect auth" },
		body: "worker exact body",
		summary: "worker summary",
		outcome: "completed",
		evidence: ["test passed"],
		recommendations: ["ship"],
		refs: [],
	};
}

function decision(workerValue: WorkerStatus, value: WorkerDeliverable, verb: "accept" | "reject" = "accept", state = "ready"): DecisionEvent {
	return {
		type: "verdict_resolved",
		id: `${verb}-1`,
		timestamp: "2026-01-03T00:00:00.000Z",
		workerId: workerValue.id,
		workerLabel: "w1",
		task: workerValue.task,
		state,
		verb,
		evidenceRefs: [],
		deliverableId: value.id,
		deliverableVersion: value.version,
		deliverableRef: value.ref,
		reviewNote: "version-bound note",
	};
}

function catalogFor(value: Artifact, fullText = value.body): ArtifactCatalog {
	return {
		list: () => [value],
		find: (ref) => ref === value.ref || ref === value.displayId ? value : undefined,
		reference: () => `ref ${value.ref}`,
		fullText: () => fullText,
		inspect: async () => ({ title: value.title, text: fullText }),
		search: async () => [value],
		summary: (candidate) => ({ displayId: candidate.displayId, ref: candidate.ref, kind: candidate.kind, title: candidate.title, subtitle: candidate.subtitle, timestamp: candidate.timestamp }),
	};
}

async function rootFor(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "docket-deliverable-lifecycle-"));
}

test("Deliverable Lifecycle saves only the exact approved current worker generation", async (t) => {
	const root = await rootFor();
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = createDeliverableStore(root);
	const currentWorker = worker();
	const current = deliverable();
	const notifications: string[] = [];
	const lifecycle = createDeliverableLifecycle({
		store,
		workerStore: { find: async (ref) => ref === "w1" ? currentWorker : undefined, readCurrentDeliverable: async () => current },
		readDecisionEvents: async () => [decision(currentWorker, current)],
		catalog: async () => catalogFor(artifact),
		cwd: "/repo",
		hasUI: false,
		edit: async () => undefined,
		selectOutcome: async () => undefined,
		notify: (text) => notifications.push(text),
	});
	const first = await lifecycle.saveWorker("w1");
	assert.ok(first);
	assert.equal(first?.deliverable.body, current.body);
	assert.match(notifications[0] ?? "", /saved/);
	const second = await lifecycle.saveWorker("w1");
	assert.equal(second?.idempotent, true);

	const stale = createDeliverableLifecycle({
		store: createDeliverableStore(path.join(root, "stale")),
		workerStore: { find: async () => currentWorker, readCurrentDeliverable: async () => ({ ...current, version: 2, ref: workerDeliverableRef(currentWorker.id, 2) }) },
		readDecisionEvents: async () => [decision(currentWorker, current)],
		catalog: async () => catalogFor(artifact),
		cwd: "/repo",
		hasUI: false,
		edit: async () => undefined,
		selectOutcome: async () => undefined,
		notify: (text) => notifications.push(text),
	});
	assert.equal(await stale.saveWorker("w1"), undefined);
	assert.match(notifications.at(-1) ?? "", /not approved/);

	const rejected = createDeliverableLifecycle({
		store: createDeliverableStore(path.join(root, "rejected")),
		workerStore: { find: async () => currentWorker, readCurrentDeliverable: async () => current },
		readDecisionEvents: async () => [decision(currentWorker, current, "accept"), decision(currentWorker, current, "reject")],
		catalog: async () => catalogFor(artifact),
		cwd: "/repo",
		hasUI: false,
		edit: async () => undefined,
		selectOutcome: async () => undefined,
		notify: (text) => notifications.push(text),
	});
	assert.equal(await rejected.saveWorker("w1"), undefined);
});

test("Deliverable Lifecycle parent authoring preserves edited bytes, selected ref, and outcome", async (t) => {
	const root = await rootFor();
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = createDeliverableStore(root);
	const edited = "  Parent bytes\nwith deliberate spacing\n";
	let editedInput = "";
	const lifecycle = createDeliverableLifecycle({
		store,
		workerStore: { find: async () => undefined, readCurrentDeliverable: async () => undefined },
		readDecisionEvents: async () => [],
		catalog: async () => catalogFor(artifact, "Full selected content\nwith two lines"),
		cwd: "/repo",
		parentSession: "/repo/.pi/session.jsonl",
		hasUI: true,
		edit: async (_title, content) => { editedInput = content; return edited; },
		selectOutcome: async () => "findings",
		notify: () => {},
	});
	const saved = await lifecycle.saveArtifact(artifact.ref);
	assert.equal(editedInput, "Full selected content\nwith two lines");
	assert.ok(saved);
	assert.equal(saved?.deliverable.body, edited);
	assert.equal(saved?.deliverable.outcome, "findings");
	assert.deepEqual(saved?.deliverable.refs, [saved?.deliverable.source.kind === "parent" ? saved.deliverable.source.selectedArtifact : undefined].filter(Boolean));
	assert.equal(saved?.deliverable.approval.kind, "human");
	assert.equal(saved?.deliverable.source.kind, "parent");
});

test("Deliverable Lifecycle routes a selected Worker Deliverable through exact approval", async (t) => {
	const root = await rootFor();
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = createDeliverableStore(root);
	const currentWorker = worker();
	const current = deliverable();
	const workerArtifact: Artifact = {
		...artifact,
		ref: current.ref,
		meta: { workerDeliverable: true, workerId: currentWorker.id },
	};
	let edited = false;
	const lifecycle = createDeliverableLifecycle({
		store,
		workerStore: { find: async () => currentWorker, readCurrentDeliverable: async () => current },
		readDecisionEvents: async () => [decision(currentWorker, current)],
		catalog: async () => catalogFor(workerArtifact),
		cwd: "/repo",
		hasUI: true,
		edit: async () => { edited = true; return "should not be used"; },
		selectOutcome: async () => "proposal",
		notify: () => {},
	});
	const saved = await lifecycle.saveArtifact(current.ref);
	assert.equal(edited, false);
	assert.equal(saved?.deliverable.source.kind, "worker");
});

test("Deliverable Lifecycle never replaces a selected worker generation with the newer current one", async (t) => {
	const root = await rootFor();
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = createDeliverableStore(root);
	const currentWorker = worker();
	const selected = deliverable(currentWorker.id, 1);
	const current = { ...deliverable(currentWorker.id, 2), body: "newer body" };
	const workerArtifact: Artifact = {
		...artifact,
		ref: selected.ref,
		body: selected.body,
		meta: {
			workerDeliverable: true,
			workerId: currentWorker.id,
			deliverableId: selected.id,
			deliverableVersion: selected.version,
			deliverableRef: selected.ref,
		},
	};
	const lifecycle = createDeliverableLifecycle({
		store,
		workerStore: {
			find: async () => currentWorker,
			readCurrentDeliverable: async () => current,
			readDeliverable: async (_workerId, version) => version === selected.version ? selected : current,
		},
		readDecisionEvents: async () => [decision(currentWorker, selected)],
		catalog: async () => catalogFor(workerArtifact),
		cwd: "/repo",
		hasUI: true,
		edit: async () => "must not edit",
		selectOutcome: async () => "proposal",
		notify: () => {},
	});
	const saved = await lifecycle.saveArtifact(selected.ref);
	assert.equal(saved?.deliverable.version, selected.version);
	assert.equal(saved?.deliverable.body, selected.body);
	assert.equal((await store.find(saved!.deliverable.ref))?.body, selected.body);
});

test("Deliverable Lifecycle rejects parent authoring outside interactive UI and empty edits", async () => {
	const notifications: string[] = [];
	const base = {
		workerStore: { find: async () => undefined, readCurrentDeliverable: async () => undefined },
		readDecisionEvents: async () => [],
		catalog: async () => catalogFor(artifact),
		cwd: "/repo",
		edit: async () => "",
		selectOutcome: async () => "proposal" as const,
		notify: (text: string) => notifications.push(text),
	};
	const nonInteractive = createDeliverableLifecycle({ ...base, hasUI: false });
	assert.equal(await nonInteractive.saveArtifact(artifact.ref), undefined);
	assert.match(notifications[0] ?? "", /interactive UI/);
	const empty = createDeliverableLifecycle({ ...base, hasUI: true });
	assert.equal(await empty.saveArtifact(artifact.ref), undefined);
	assert.match(notifications.at(-1) ?? "", /cannot be empty/);
});
