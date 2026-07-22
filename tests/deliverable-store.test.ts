import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	approvedWorkerDecision,
	artifactSummaryFromArtifact,
	createDeliverableStore,
	makeParentDeliverableId,
	reviewNotesForWorkerDeliverable,
	safeDeliverableIdFromWorker,
	storedDeliverableHandoffProvenance,
	storedDeliverableRef,
	type StoredDeliverable,
} from "../extensions/deliverable-store.js";
import {
	workerDeliverableId,
	workerDeliverablePointer,
	workerDeliverableRef,
	type WorkerDeliverable,
} from "../extensions/worker-deliverable.js";
import type { DecisionEvent } from "../extensions/decision-log.js";
import type { Artifact, ArtifactSummary } from "../extensions/types.js";
import type { WorkerStatus } from "../extensions/background-work.js";

async function tempRoot(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "docket-deliverable-store-"));
}

const selectedArtifact: ArtifactSummary = {
	displayId: "r1",
	ref: "response:entry-1:0",
	kind: "response",
	title: "original answer",
	subtitle: "parent session",
	timestamp: 1_735_689_600_000,
};

function workerStatus(id = "worker-1"): WorkerStatus {
	return {
		id,
		index: 1,
		tmuxSession: "docket-workers:w1",
		tmuxWindowId: "@7",
		tmuxPaneId: "%9",
		task: "inspect auth",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "ready",
		model: "openai/gpt-5",
		thinking: "high",
		git: { branch: "main", dirty: 1, staged: 1, unstaged: 0 },
	};
}

function workerDeliverable(workerId = "worker-1", version = 2): WorkerDeliverable {
	return {
		schemaVersion: 1,
		id: workerDeliverableId(workerId),
		version,
		ref: workerDeliverableRef(workerId, version),
		createdAt: "2026-01-02T03:04:05.000Z",
		source: {
			workerId,
			workerLabel: "w1",
			task: "inspect auth",
			model: "openai/gpt-5",
			thinking: "high",
			runToken: "run-2",
			sessionFile: "/repo/.pi/session.jsonl",
		},
		body: "Exact body\n\nwith spacing and a trailing byte.\n",
		summary: "Auth findings",
		outcome: "findings",
		evidence: ["searched src/auth.ts", "npm test: 12 passed"],
		recommendations: ["rotate the token"],
		refs: [selectedArtifact],
		changeSet: {
			ref: "worker-changes:worker-1:2",
			files: [{ path: "src/auth.ts", additions: 3, deletions: 1 }],
			stat: "1 file changed",
			patch: "@@ -1 +1 @@\n-old\n+new\n",
			hunkCount: 1,
		},
		sourceHandoff: {
			sourceDeliverableId: "parent-previous",
			sourceVersion: 1,
			sourceRef: "deliverable:parent-previous:1",
			sourceKind: "parent",
			sourceCwd: "/repo",
			approvingDecisionId: "human-authorship:parent-previous",
			approvedAt: "2026-01-01T00:00:00.000Z",
			sidecarPath: "source-deliverable.md",
		},
	};
}

function accepted(worker: WorkerStatus, deliverable: WorkerDeliverable, id: string, reviewNote?: string, state = "ready"): Extract<DecisionEvent, { type: "verdict_resolved" }> {
	return {
		type: "verdict_resolved",
		id,
		timestamp: `2026-01-0${id.endsWith("2") ? "3" : "2"}T00:00:00.000Z`,
		workerId: worker.id,
		workerLabel: "w1",
		task: worker.task,
		state,
		verb: "accept",
		evidenceRefs: [deliverable.ref],
		deliverableId: deliverable.id,
		deliverableVersion: deliverable.version,
		deliverableRef: deliverable.ref,
		...(reviewNote ? { reviewNote } : {}),
	};
}

test("DeliverableStore saves an exact approved worker generation and is idempotent", async (t) => {
	const root = await tempRoot();
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = createDeliverableStore(root);
	const worker = workerStatus();
	const deliverable = workerDeliverable();
	const events = [accepted(worker, deliverable, "decision-1", "Check the frozen patch."), accepted(worker, deliverable, "decision-2", "Second ordered note.")];
	const decision = approvedWorkerDecision(events, workerDeliverablePointer(deliverable));
	assert.equal(decision?.id, "decision-2");
	assert.deepEqual(reviewNotesForWorkerDeliverable(events, workerDeliverablePointer(deliverable)).map((note) => note.text), ["Check the frozen patch.", "Second ordered note."]);

	const saved = await store.saveWorker({
		deliverable,
		worker,
		approval: { kind: "worker", decisionId: decision!.id!, decidedAt: decision!.timestamp, verdict: "accept", workerDeliverable: workerDeliverablePointer(deliverable), decision: decision! },
		reviewNotes: reviewNotesForWorkerDeliverable(events, workerDeliverablePointer(deliverable)),
		savedAt: "2026-01-03T00:00:00.000Z",
	});
	assert.equal(saved.idempotent, false);
	assert.equal(saved.deliverable.ref, storedDeliverableRef(safeDeliverableIdFromWorker(worker.id), deliverable.version));
	assert.equal(saved.deliverable.body, deliverable.body);
	assert.deepEqual(saved.deliverable.changeSet, deliverable.changeSet);
	assert.deepEqual(saved.deliverable.handoffProvenance, deliverable.sourceHandoff);
	assert.deepEqual(saved.deliverable.reviewNotes.map((note) => note.text), ["Check the frozen patch.", "Second ordered note."]);
	assert.equal(saved.deliverable.approval.kind, "worker");
	assert.equal(saved.deliverable.approval.decisionId, "decision-2");
	assert.deepEqual(saved.deliverable.approval.kind === "worker" ? saved.deliverable.approval.decision : undefined, decision);
	assert.equal(saved.deliverable.source.kind === "worker" ? saved.deliverable.source.cwd : undefined, worker.cwd);

	const repeated = await store.saveWorker({
		deliverable,
		worker,
		approval: { kind: "worker", decisionId: decision!.id!, decidedAt: decision!.timestamp, verdict: "accept", workerDeliverable: workerDeliverablePointer(deliverable), decision: decision! },
		savedAt: "2026-01-04T00:00:00.000Z",
	});
	assert.equal(repeated.idempotent, true);
	assert.equal(repeated.deliverable.savedAt, saved.deliverable.savedAt);
	assert.equal((await store.find("last"))?.body, deliverable.body);
	assert.equal(JSON.parse(await readFile(store.fileFor(saved.deliverable.id, saved.deliverable.version), "utf8")).body, deliverable.body);
});

test("DeliverableStore never overwrites a corrupt claimed version and skips unrelated files", async (t) => {
	const root = await tempRoot();
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = createDeliverableStore(root);
	const deliverable = workerDeliverable("worker-2", 1);
	const id = safeDeliverableIdFromWorker("worker-2");
	await mkdir(store.dirFor(id), { recursive: true });
	const file = store.fileFor(id, 1);
	await writeFile(file, "corrupt claimed bytes", "utf8");
	await mkdir(path.join(root, "not-a-valid-id!"), { recursive: true });
	await writeFile(path.join(root, "unrelated.json"), "not a deliverable", "utf8");
	const malformedMetadata = await store.saveParent({
		body: "valid parent body",
		summary: "parent",
		outcome: "findings",
		cwd: "/repo",
		selectedArtifact,
		id: "parent-malformed-metadata",
	});
	const malformedFile = store.fileFor(malformedMetadata.deliverable.id, malformedMetadata.deliverable.version);
	const malformed = JSON.parse(await readFile(malformedFile, "utf8"));
	malformed.source.sessionFile = 42;
	await writeFile(malformedFile, `${JSON.stringify(malformed)}\n`, "utf8");
	const approvalDecision = accepted(workerStatus("worker-2"), deliverable, "decision");
	await assert.rejects(() => store.saveWorker({
		deliverable,
		worker: workerStatus("worker-2"),
		approval: { kind: "worker", decisionId: "decision", decidedAt: approvalDecision.timestamp, verdict: "accept", workerDeliverable: workerDeliverablePointer(deliverable), decision: approvalDecision },
	}), /corrupt/);
	assert.equal(await readFile(file, "utf8"), "corrupt claimed bytes");
	assert.deepEqual(await store.list(), []);
	assert.equal(await store.read("../escape"), undefined);
});

test("DeliverableStore serializes concurrent saves and parent authorship is immediately approved", async (t) => {
	const root = await tempRoot();
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = createDeliverableStore(root);
	const worker = workerStatus("worker-3");
	const deliverable = workerDeliverable("worker-3", 1);
	const approvalDecision = accepted(worker, deliverable, "decision");
	const input = {
		deliverable,
		worker,
		approval: { kind: "worker" as const, decisionId: "decision", decidedAt: approvalDecision.timestamp, verdict: "accept" as const, workerDeliverable: workerDeliverablePointer(deliverable), decision: approvalDecision },
	};
	const results = await Promise.all(Array.from({ length: 5 }, () => store.saveWorker(input)));
	assert.equal(results.filter((result) => !result.idempotent).length, 1);
	assert.equal((await store.list()).length, 1);

	const parent = await store.saveParent({
		body: "Parent-authored exact bytes\n",
		summary: "Parent proposal",
		outcome: "proposal",
		cwd: "/repo",
		sessionFile: "/repo/.pi/session.jsonl",
		selectedArtifact,
		createdAt: "2026-01-05T00:00:00.000Z",
		savedAt: "2026-01-05T00:00:01.000Z",
		id: makeParentDeliverableId(new Date("2026-01-05T00:00:00.000Z"), "abc123"),
	});
	assert.equal(parent.deliverable.version, 1);
	assert.deepEqual(parent.deliverable.source, {
		kind: "parent",
		createdAt: "2026-01-05T00:00:00.000Z",
		sessionFile: "/repo/.pi/session.jsonl",
		cwd: "/repo",
		selectedArtifact,
	});
	assert.deepEqual(parent.deliverable.approval, {
		kind: "human",
		decisionId: `human-authorship:${parent.deliverable.id}`,
		decidedAt: "2026-01-05T00:00:01.000Z",
		reason: "parent-authorship",
	});
	assert.equal(storedDeliverableHandoffProvenance(parent.deliverable).sourceKind, "parent");
});

test("approval extraction rejects stale, rejected, and merely-ready generations", () => {
	const worker = workerStatus();
	const deliverable = workerDeliverable();
	const pointer = workerDeliverablePointer(deliverable);
	assert.equal(approvedWorkerDecision([accepted(worker, deliverable, "ready-only", undefined, "active")], pointer), undefined);
	assert.equal(approvedWorkerDecision([{ ...accepted(worker, deliverable, "rejected"), verb: "reject" } as DecisionEvent], pointer), undefined);
	assert.equal(approvedWorkerDecision([accepted(worker, { ...deliverable, version: 1, ref: workerDeliverableRef(worker.id, 1) }, "stale")], pointer), undefined);
	assert.equal(approvedWorkerDecision([accepted(worker, deliverable, "approved")], pointer)?.id, "approved");
});

test("artifactSummaryFromArtifact keeps the selected source reference", () => {
	const artifact = { id: "a", displayId: "r1", ref: selectedArtifact.ref, kind: "response" as const, title: selectedArtifact.title, subtitle: selectedArtifact.subtitle, body: "body", timestamp: selectedArtifact.timestamp } satisfies Artifact;
	assert.deepEqual(artifactSummaryFromArtifact(artifact), selectedArtifact);
});
