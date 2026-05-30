import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promoteWorkerChangeSet, workerChangeSetArtifact } from "../extensions/worker-changes.js";
import type { WorkerStatus } from "../extensions/background-work.js";
import { createWorkerWorkspace } from "../extensions/worker-store.js";

function git(cwd: string, args: string[], input?: string): string {
	const result = spawnSync("git", args, { cwd, input, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	return result.stdout.trim();
}

async function makeRepo(): Promise<{ root: string; workerPath: string; head: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "trail-worker-changes-"));
	git(root, ["init"]);
	git(root, ["config", "user.name", "Test"]);
	git(root, ["config", "user.email", "test@example.invalid"]);
	await writeFile(path.join(root, "app.txt"), "one\n", "utf8");
	git(root, ["add", "app.txt"]);
	git(root, ["commit", "-m", "initial"]);
	const head = git(root, ["rev-parse", "HEAD"]);
	const workerPath = path.join(root, "..", `${path.basename(root)}-worker`);
	git(root, ["worktree", "add", "--detach", workerPath, head]);
	return {
		root,
		workerPath,
		head,
		cleanup: async () => {
			spawnSync("git", ["worktree", "remove", "--force", workerPath], { cwd: root, stdio: "ignore" });
			await rm(root, { recursive: true, force: true });
		},
	};
}

function worker(root: string, workerPath: string, snapshotHead: string): WorkerStatus {
	return {
		id: "worker-1",
		index: 1,
		tmuxSession: "trail-worker-1",
		task: "edit app text",
		cwd: workerPath,
		worktree: { path: workerPath, baseCwd: root, baseRoot: root, parentCwd: root, baseHead: snapshotHead, snapshotHead },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:01:00.000Z",
		state: "ready",
	};
}

test("worker change set artifact summarizes workspace edits", async () => {
	const repo = await makeRepo();
	try {
		await writeFile(path.join(repo.workerPath, "app.txt"), "one\ntwo\n", "utf8");
		await writeFile(path.join(repo.workerPath, "new.txt"), "new\n", "utf8");
		const artifact = workerChangeSetArtifact(worker(repo.root, repo.workerPath, repo.head));

		assert.equal(artifact?.meta?.workerChangeSet, true);
		assert.match(artifact?.title ?? "", /2 files/);
		assert.match(artifact?.body ?? "", /app\.txt/);
		assert.match(artifact?.body ?? "", /new\.txt/);
	} finally {
		await repo.cleanup();
	}
});

test("promote worker change set applies whole patch to parent", async () => {
	const repo = await makeRepo();
	try {
		await writeFile(path.join(repo.workerPath, "app.txt"), "one\ntwo\n", "utf8");
		await mkdir(path.join(repo.workerPath, "nested"));
		await writeFile(path.join(repo.workerPath, "nested", "new.txt"), "new\n", "utf8");
		const result = promoteWorkerChangeSet(worker(repo.root, repo.workerPath, repo.head), repo.root);

		assert.equal(result.ok, true, result.message);
		assert.equal(await readFile(path.join(repo.root, "app.txt"), "utf8"), "one\ntwo\n");
		assert.equal(await readFile(path.join(repo.root, "nested", "new.txt"), "utf8"), "new\n");
		assert.equal(workerChangeSetArtifact(worker(repo.root, repo.workerPath, repo.head)), undefined);
	} finally {
		await repo.cleanup();
	}
});

test("promote worker change set applies copied workspace patch outside git repos", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "trail-worker-copy-promote-"));
	const workspace = path.join(os.tmpdir(), `${path.basename(root)}-workspace`);
	try {
		await writeFile(path.join(root, "app.txt"), "one\n", "utf8");
		const created = createWorkerWorkspace(root, workspace);
		assert.equal(created.kind, "copy");
		await writeFile(path.join(workspace, "app.txt"), "one\ntwo\n", "utf8");
		await writeFile(path.join(workspace, "new.txt"), "new\n", "utf8");

		const result = promoteWorkerChangeSet({ ...worker(root, workspace, created.snapshotHead ?? ""), worktree: created }, root);

		assert.equal(result.ok, true, result.message);
		assert.equal(await readFile(path.join(root, "app.txt"), "utf8"), "one\ntwo\n");
		assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "new\n");
	} finally {
		await rm(workspace, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
});

test("promote does not warn when parent still matches dirty spawn snapshot", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "trail-worker-dirty-promote-"));
	const workspace = path.join(os.tmpdir(), `${path.basename(root)}-workspace`);
	try {
		git(root, ["init"]);
		git(root, ["config", "user.name", "Test"]);
		git(root, ["config", "user.email", "test@example.invalid"]);
		await writeFile(path.join(root, "app.txt"), "one\n", "utf8");
		git(root, ["add", "app.txt"]);
		git(root, ["commit", "-m", "initial"]);
		await writeFile(path.join(root, "app.txt"), "one\nparent\n", "utf8");
		await writeFile(path.join(root, "scratch.txt"), "scratch\n", "utf8");
		await rm(workspace, { recursive: true, force: true });
		const created = createWorkerWorkspace(root, workspace);
		assert.ok(created?.snapshotHead);
		await writeFile(path.join(workspace, "app.txt"), "one\nparent\nworker\n", "utf8");

		const result = promoteWorkerChangeSet({ ...worker(root, workspace, created.snapshotHead), worktree: created }, root);

		assert.equal(result.ok, true, result.message);
		assert.equal(await readFile(path.join(root, "app.txt"), "utf8"), "one\nparent\nworker\n");
	} finally {
		spawnSync("git", ["worktree", "remove", "--force", workspace], { cwd: root, stdio: "ignore" });
		await rm(root, { recursive: true, force: true });
	}
});
