import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildWorkerInitialPrompt, createWorkerStore, workerShortLabel, workerSummaryName, type WorkerStatus } from "../extensions/worker-store.js";

const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "trail-worker-test-"));
	process.env.PI_CODING_AGENT_DIR = tmp;
	try {
		return await fn();
	} finally {
		if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
		await rm(tmp, { recursive: true, force: true });
	}
}

async function seedWorker(root: string, partial: Partial<WorkerStatus> & { id: string; index: number }): Promise<void> {
	const status: WorkerStatus = {
		id: partial.id,
		index: partial.index,
		tmuxSession: `trail-worker-${partial.id}`,
		task: partial.task ?? "demo task",
		cwd: partial.cwd ?? "/repo",
		createdAt: partial.createdAt ?? "2026-05-01T00:00:00.000Z",
		updatedAt: partial.updatedAt ?? "2026-05-01T00:00:00.000Z",
		state: partial.state ?? "active",
	};
	const dir = path.join(root, partial.id);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "status.json"), `${JSON.stringify(status)}\n`, "utf8");
}

test("workerShortLabel + workerSummaryName format consistently", () => {
	assert.equal(workerShortLabel(1), "w1");
	assert.equal(workerShortLabel(12), "w12");
	const trimmed = workerSummaryName({ task: "investigate the auth middleware token expiry edge case here" } as WorkerStatus, 24);
	assert.equal(trimmed.length <= 24, true);
	assert.match(trimmed, /investigate/);
});

test("worker initial prompt prefers protocol tools over bash slash commands", () => {
	const prompt = buildWorkerInitialPrompt({ index: 1, id: "demo", dir: "/tmp/trail-worker-demo" });
	assert.match(prompt, /call `trail_wait`/);
	assert.match(prompt, /call `trail_done`/);
	assert.match(prompt, /call `trail_fail`/);
	assert.match(prompt, /Do not run `\/trail wait`/);
});

test("worker store find resolves by short label, bare digits, and partial id", async () => {
	await withTempHome(async () => {
		const store = createWorkerStore();
		const root = store.root();
		await mkdir(root, { recursive: true });
		await seedWorker(root, { id: "auth-investigation-a665", index: 1 });
		await seedWorker(root, { id: "middleware-audit-b912", index: 2 });

		const w1 = await store.find("w1");
		assert.equal(w1?.id, "auth-investigation-a665");
		const byBareIndex = await store.find("2");
		assert.equal(byBareIndex?.id, "middleware-audit-b912");
		const byPartial = await store.find("middleware");
		assert.equal(byPartial?.id, "middleware-audit-b912");
		const missing = await store.find("w99");
		assert.equal(missing, undefined);
	});
});

test("worker store list sorts by createdAt", async () => {
	await withTempHome(async () => {
		const store = createWorkerStore();
		const root = store.root();
		await mkdir(root, { recursive: true });
		await seedWorker(root, { id: "older-a", index: 1, createdAt: "2026-04-01T00:00:00.000Z" });
		await seedWorker(root, { id: "newer-b", index: 2, createdAt: "2026-05-01T00:00:00.000Z" });
		const list = await store.list();
		assert.deepEqual(list.map((w) => w.id), ["older-a", "newer-b"]);
	});
});

test("worker store appends active questions", async () => {
	await withTempHome(async () => {
		const store = createWorkerStore();
		const root = store.root();
		await mkdir(root, { recursive: true });
		await seedWorker(root, { id: "question-worker", index: 1 });

		await store.addQuestion("w1", "Include checkpoint flow?");
		const updated = await store.addQuestion("w1", "Inspect prompt chips too?");

		assert.equal(updated?.state, "needs_input");
		assert.equal(updated?.question, "2 questions");
		assert.deepEqual(updated?.questions?.map((q) => q.text), ["Include checkpoint flow?", "Inspect prompt chips too?"]);
	});
});
