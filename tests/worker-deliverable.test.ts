import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkerStatus } from "../extensions/background-work.js";
import {
	extractWorkerDeliverableBody,
	publishWorkerDeliverable,
	readWorkerDeliverable,
	workerDeliverableArtifact,
	workerDeliverablePointer,
} from "../extensions/worker-deliverable.js";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 1,
		tmuxSession: "docket-workers:w1",
		task: "write a durable plan",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "ready",
		...partial,
	};
}

function assistant(content: unknown) {
	return { type: "message", message: { role: "assistant", content } };
}

test("deliverable body comes from exact docket_done assistant message without artifact truncation", () => {
	const body = `# Plan\n\n${"long body ".repeat(800)}`;
	const extracted = extractWorkerDeliverableBody([
		assistant([{ type: "text", text: body }, { type: "toolCall", id: "done-1", name: "docket_done", arguments: {} }]),
	], "done-1", "short summary");

	assert.equal(extracted, body);
	assert.ok(extracted.length > 6_000);
});

test("deliverable body preserves empty text blocks without adding tool-call newlines", () => {
	const extracted = extractWorkerDeliverableBody([
		assistant([
			{ type: "text", text: "# Plan" },
			{ type: "text", text: "" },
			{ type: "thinking", thinking: "hidden" },
			{ type: "text", text: "Body" },
			{ type: "toolCall", id: "done-1", name: "docket_done", arguments: {} },
		]),
	], "done-1", "summary");

	assert.equal(extracted, "# Plan\n\nBody");
});

test("deliverable body falls back past protocol-only messages to latest normal assistant response", () => {
	const extracted = extractWorkerDeliverableBody([
		assistant([{ type: "text", text: "Useful full answer" }]),
		assistant([{ type: "toolCall", id: "wait", name: "docket_wait", arguments: {} }]),
	], "missing", "summary");

	assert.equal(extracted, "Useful full answer");
});

test("deliverable publication serializes concurrent version allocation", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "docket-deliverable-lock-"));
	try {
		const published = await Promise.all([
			publishWorkerDeliverable({ root, worker: worker(), toolCallId: "done-a", body: "a" }),
			publishWorkerDeliverable({ root, worker: worker(), toolCallId: "done-b", body: "b" }),
		]);
		assert.deepEqual(published.map((item) => item.deliverable.version).sort((a, b) => a - b), [1, 2]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("deliverable publication rejects malformed sidecars without overwriting claimed versions", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "docket-deliverable-claimed-"));
	try {
		const dir = path.join(root, "worker-1", "deliverables");
		const payload = {
			schemaVersion: 1,
			id: "worker-deliverable:worker-1",
			version: 1,
			ref: "wrong-ref",
			createdAt: "2026-01-01T00:00:00.000Z",
			source: { workerId: "worker-1", workerLabel: "w1", task: "write a durable plan" },
			body: "claimed bytes",
			summary: "claimed",
			outcome: "proposal",
			evidence: [],
			recommendations: [],
			refs: [],
		};
		const firstFile = path.join(dir, "v1.json");
		const secondFile = path.join(dir, "v2.json");
		const claimed = `${JSON.stringify(payload, null, 2)}\n`;
		const malformed = `${JSON.stringify({ ...payload, version: 2, ref: "worker-deliverable:worker-1:2", refs: {} }, null, 2)}\n`;
		await mkdir(dir, { recursive: true });
		await writeFile(firstFile, claimed, "utf8");
		await writeFile(secondFile, malformed, "utf8");

		assert.equal(await readWorkerDeliverable(root, "worker-1", 1), undefined, "mismatched identity is rejected");
		assert.equal(await readWorkerDeliverable(root, "worker-1", 2), undefined, "malformed required fields are rejected");
		const published = await publishWorkerDeliverable({ root, worker: worker(), toolCallId: "done-2", body: "new body" });

		assert.equal(published.deliverable.version, 3);
		assert.equal(await readFile(firstFile, "utf8"), claimed);
		assert.equal(await readFile(secondFile, "utf8"), malformed);
		assert.equal((await readWorkerDeliverable(root, "worker-1", 3))?.body, "new body");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("deliverable publication versions immutable generations and deduplicates tool execution", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "docket-deliverable-"));
	try {
		const first = await publishWorkerDeliverable({
			root,
			worker: worker(),
			toolCallId: "done-1",
			body: "first full body",
			done: { outcome: "proposal", summary: "first" },
			captureChangeSet: (version) => ({ ref: `worker-changes:worker-1:${version}`, files: [{ path: "plan.md", additions: 1 }], stat: " plan.md | 1 +", patch: "diff --git a/plan.md b/plan.md\n@@ -0,0 +1 @@\n+first\n", hunkCount: 1 }),
		});
		const duplicate = await publishWorkerDeliverable({
			root,
			worker: worker(),
			toolCallId: "done-1",
			body: "should not replace first",
			done: { summary: "different" },
		});
		const second = await publishWorkerDeliverable({
			root,
			worker: worker(),
			toolCallId: "done-2",
			body: "second full body",
			done: { summary: "second" },
		});

		assert.equal(first.deliverable.version, 1);
		assert.equal(first.deliverable.ref, "worker-deliverable:worker-1:1");
		assert.equal(duplicate.idempotent, true);
		assert.equal(duplicate.deliverable.version, 1);
		assert.equal(second.deliverable.version, 2);
		assert.deepEqual(workerDeliverablePointer(second.deliverable), { id: "worker-deliverable:worker-1", version: 2, ref: "worker-deliverable:worker-1:2" });
		assert.equal((await readWorkerDeliverable(root, "worker-1", 1))?.body, "first full body");
		assert.equal((await readWorkerDeliverable(root, "worker-1", 2))?.body, "second full body");
		assert.match(await readFile(path.join(root, "worker-1", "deliverables", "v1.json"), "utf8"), /worker-changes:worker-1:1/);
		assert.equal(workerDeliverableArtifact(first.deliverable).meta?.patch, first.deliverable.changeSet?.patch);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
