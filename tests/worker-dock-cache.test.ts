import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkerSnapshotCache } from "../extensions/worker-dock-cache.js";
import type { WorkerStatus } from "../extensions/background-work.js";

function makeStatus(partial: Partial<WorkerStatus> & { id: string; index: number }): WorkerStatus {
	return {
		id: partial.id,
		index: partial.index,
		tmuxSession: `trail-worker-${partial.id}`,
		task: partial.task ?? "demo",
		cwd: partial.cwd ?? "/repo",
		createdAt: partial.createdAt ?? "2026-05-01T00:00:00.000Z",
		updatedAt: partial.updatedAt ?? "2026-05-01T00:00:00.000Z",
		state: partial.state ?? "active",
		...(partial.model ? { model: partial.model } : {}),
	};
}

async function seedWorkerDir(root: string, id: string, index: number, artifactsContent: string): Promise<{ statusFile: string; artifactsFile: string }> {
	const dir = path.join(root, id);
	await mkdir(dir, { recursive: true });
	const statusFile = path.join(dir, "status.json");
	const artifactsFile = path.join(dir, "artifacts.json");
	await writeFile(statusFile, `${JSON.stringify(makeStatus({ id, index }))}\n`, "utf8");
	await writeFile(artifactsFile, artifactsContent, "utf8");
	return { statusFile, artifactsFile };
}

test("WorkerSnapshotCache caches reads by mtime", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "trail-dock-cache-"));
	try {
		const { statusFile, artifactsFile } = await seedWorkerDir(root, "alpha", 1, "[]");
		const cache = new WorkerSnapshotCache(root);

		const first = await cache.snapshot();
		assert.equal(first.workers.length, 1);
		assert.deepEqual(first.artifactsByWorker.get("alpha"), []);

		// Touch with same content but new mtime; cache should still detect change via mtime
		const touched = new Date(Date.now() + 5000);
		await utimes(statusFile, touched, touched);
		await utimes(artifactsFile, touched, touched);

		const second = await cache.snapshot();
		assert.equal(second.workers.length, 1);
		// Identity check: when nothing actually changes shape we still re-parse only on mtime delta
		assert.equal(second.workers[0]!.id, "alpha");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("WorkerSnapshotCache drops removed worker directories", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "trail-dock-cache-rm-"));
	try {
		await seedWorkerDir(root, "alpha", 1, "[]");
		await seedWorkerDir(root, "beta", 2, "[]");
		const cache = new WorkerSnapshotCache(root);
		const initial = await cache.snapshot();
		assert.equal(initial.workers.length, 2);

		await rm(path.join(root, "beta"), { recursive: true, force: true });
		const next = await cache.snapshot();
		assert.equal(next.workers.length, 1);
		assert.equal(next.workers[0]!.id, "alpha");
		assert.equal(cache.size(), 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("WorkerSnapshotCache yields empty snapshot when root missing", async () => {
	const cache = new WorkerSnapshotCache(path.join(os.tmpdir(), `trail-cache-missing-${Date.now()}`));
	const snap = await cache.snapshot();
	assert.equal(snap.workers.length, 0);
	assert.equal(snap.artifactsByWorker.size, 0);
});
