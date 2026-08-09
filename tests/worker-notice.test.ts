import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildWorkerMessage, listWorkerMessages, writeWorkerMessage } from "../extensions/worker-mailbox.js";
import { workerNoticeArtifact, type WorkerStatus } from "../extensions/background-work.js";
import { isWorkerNoticeArtifact, workerAnswerArtifacts, workerResultArtifactFromReview } from "../extensions/worker-review.js";
import type { Artifact } from "../extensions/types.js";

const worker: WorkerStatus = {
	id: "worker-1",
	index: 2,
	tmuxSession: "docket-workers",
	task: "add rate limiting to the public API",
	cwd: "/repo",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	state: "active",
};

test("a notice becomes an artifact the human can open, attributed to its worker", () => {
	const artifact = workerNoticeArtifact(worker, { id: "n1", body: "auth middleware now takes a context arg", createdAt: "2026-01-01T00:01:00.000Z" });

	assert.equal(artifact?.title, "w2 shared: auth middleware now takes a context arg");
	assert.equal(artifact?.meta?.workerNotice, true);
	assert.equal(artifact?.meta?.workerLabel, "w2");
	assert.match(artifact!.body, /auth middleware now takes a context arg/);
});

test("addressed notices name their suggested recipients without routing anywhere", () => {
	const artifact = workerNoticeArtifact(worker, { id: "n1", body: "signature changed", createdAt: "2026-01-01T00:01:00.000Z", to: ["w1", "w4"] });

	assert.equal(artifact?.subtitle, "suggested for w1, w4");
	assert.deepEqual(artifact?.meta?.noticeTo, ["w1", "w4"]);
});

test("an empty notice produces nothing", () => {
	assert.equal(workerNoticeArtifact(worker, { id: "n1", body: "   \n ", createdAt: "2026-01-01T00:01:00.000Z" }), undefined);
});

test("a notice never displaces the worker's actual answer", () => {
	const notice = workerNoticeArtifact(worker, { id: "n1", body: "middleware changed", createdAt: "2026-01-01T00:05:00.000Z" })!;
	const answer: Artifact = {
		id: "a1",
		displayId: "a1",
		ref: "response:1",
		kind: "response",
		title: "rate limiting added",
		subtitle: "worker answer",
		body: "done",
		timestamp: Date.parse("2026-01-01T00:02:00.000Z"),
		meta: { workerId: worker.id },
	};

	assert.equal(isWorkerNoticeArtifact(notice), true);
	assert.deepEqual(workerAnswerArtifacts([answer, notice]), [answer]);
	// The notice is newer; without the exclusion it would be picked as the result.
	assert.equal(workerResultArtifactFromReview(worker, [answer, notice])?.ref, "response:1");
});

test("notices live in the outbox and never in the worker's inbox", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "docket-notice-"));
	try {
		const notice = buildWorkerMessage({ body: "middleware changed", kind: "notice", from: "worker", fromWorker: "w2", to: ["w1"] })!;
		await writeWorkerMessage(root, "worker-1", notice, "outbox");

		assert.deepEqual(await listWorkerMessages(root, "worker-1", "inbox"), []);
		const stored = await listWorkerMessages(root, "worker-1", "outbox");
		assert.equal(stored.length, 1);
		assert.equal(stored[0]?.kind, "notice");
		assert.equal(stored[0]?.from, "worker");
		assert.equal(stored[0]?.fromWorker, "w2");
		assert.deepEqual(stored[0]?.to, ["w1"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a relayed worker claim is framed as coming from that worker, not from the human", async () => {
	const { formatWorkerMessageForSession } = await import("../extensions/worker-mailbox.js");
	const relayed = buildWorkerMessage({ body: "middleware changed", kind: "notice", from: "worker", fromWorker: "w2" })!;

	assert.match(formatWorkerMessageForSession(relayed), /^\[docket · from w2\]/);
});
