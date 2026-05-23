import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildWorkerInitialPrompt, buildWorkerLaunchCommand, createWorkerStore, createWorkerWorkspace, currentPiCommandParts, explicitExtensionArgs, readWorkerStatusSync, workerShortLabel, workerSummaryName, type WorkerStatus } from "../extensions/worker-store.js";

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
		...(partial.parentWorkerId ? { parentWorkerId: partial.parentWorkerId } : {}),
		...(typeof partial.depth === "number" ? { depth: partial.depth } : {}),
		...(partial.kind ? { kind: partial.kind } : {}),
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

test("packaged worker guardrails file ships with protocol contract", async () => {
	const guardrailsPath = path.join(process.cwd(), "extensions", "worker-guardrails.md");
	const text = await import("node:fs/promises").then((fs) => fs.readFile(guardrailsPath, "utf8"));
	assert.match(text, /trail_wait/);
	assert.match(text, /trail_done/);
	assert.match(text, /trail_fail/);
	assert.match(text, /trail_todos/);
	assert.match(text, /Recommended:/);
	assert.match(text, /Do not assume/i);
	assert.match(text, /Read-only by default/);
	assert.match(text, /Shared tmux session/);
	assert.match(text, /Never invoke `tmux` directly/);
});

test("worker initial prompt points at guardrails and names protocol tools", () => {
	const prompt = buildWorkerInitialPrompt({ index: 1, id: "demo", dir: "/tmp/trail-worker-demo" });
	assert.match(prompt, /<trail_worker_guardrails>/);
	assert.match(prompt, /trail_wait/);
	assert.match(prompt, /trail_done/);
	assert.match(prompt, /trail_fail/);
	assert.match(prompt, /trail_todos/);
	assert.match(prompt, /task is in \/tmp\/trail-worker-demo\/task\.md/);
	const worktreePrompt = buildWorkerInitialPrompt({ index: 1, id: "demo", dir: "/tmp/trail-worker-demo", worktreePath: "/tmp/trail-worker-demo/worktree" });
	assert.match(worktreePrompt, /Worker workspace: \/tmp\/trail-worker-demo\/worktree/);
});

test("worker launch command reuses current pi binary and records process exit", () => {
	const piCli = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
	const parts = currentPiCommandParts(["/usr/local/bin/node", piCli], "/usr/local/bin/node");
	assert.deepEqual(parts, ["/usr/local/bin/node", piCli]);
	assert.deepEqual(currentPiCommandParts(["/usr/local/bin/node", "/repo/tests/worker-store.test.js"], "/usr/local/bin/node"), ["pi"]);

	const command = buildWorkerLaunchCommand({
		id: "worker-1",
		sessionDir: "/tmp/session",
		statusFile: "/tmp/status.json",
		initialPrompt: "Read task, then say 'done'",
		extensionArgs: ["--no-extensions", "-e", "./extensions/trail.ts"],
		piCommandParts: parts,
	});
	assert.match(command, /TRAIL_WORKER_ID='worker-1' '\/usr\/local\/bin\/node' '\/opt\/homebrew\/lib\/node_modules\/\@earendil-works\/pi-coding-agent\/dist\/cli\.js'/);
	assert.match(command, /--session-dir '\/tmp\/session'/);
	assert.match(command, /'--no-extensions' '-e' '\.\/extensions\/trail\.ts'/);
	assert.match(command, /; code=\$\?; /);
	assert.match(command, /worker process exited before reporting ready/);
});

test("explicit extension args preserve no-extension isolation", () => {
	const originalArgv = process.argv;
	process.argv = ["node", "pi", "--no-extensions", "-e", "./extensions/trail.ts", "--extension=extra.ts", "--model", "sonnet"];
	try {
		assert.deepEqual(explicitExtensionArgs(), ["--no-extensions", "-e", "./extensions/trail.ts", "--extension", "extra.ts"]);
	} finally {
		process.argv = originalArgv;
	}
});

test("worker workspace is seeded from parent dirty state", async () => {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "trail-worker-workspace-test-"));
	const workspace = path.join(os.tmpdir(), `${path.basename(tmp)}-workspace`);
	try {
		await rm(workspace, { recursive: true, force: true });
		const git = (args: string[]) => {
			const result = spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr || result.error?.message);
			return result.stdout.trim();
		};
		git(["init"]);
		git(["config", "user.name", "Test"]);
		git(["config", "user.email", "test@example.invalid"]);
		await writeFile(path.join(tmp, "tracked.txt"), "one\n", "utf8");
		git(["add", "tracked.txt"]);
		git(["commit", "-m", "initial"]);
		await writeFile(path.join(tmp, "tracked.txt"), "one\nparent dirty\n", "utf8");
		await writeFile(path.join(tmp, "untracked.txt"), "parent untracked\n", "utf8");

		const created = createWorkerWorkspace(tmp, workspace);

		assert.equal(created?.path, workspace);
		assert.ok(created?.snapshotHead);
		assert.equal(await readFile(path.join(workspace, "tracked.txt"), "utf8"), "one\nparent dirty\n");
		assert.equal(await readFile(path.join(workspace, "untracked.txt"), "utf8"), "parent untracked\n");
		assert.equal(spawnSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: workspace }).status, 0);
	} finally {
		spawnSync("git", ["worktree", "remove", "--force", workspace], { cwd: tmp, stdio: "ignore" });
		await rm(tmp, { recursive: true, force: true });
	}
});

test("worker launch command marks early process exits", async () => {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "trail-worker-exit-test-"));
	try {
		const statusFile = path.join(tmp, "status.json");
		await writeFile(statusFile, `${JSON.stringify({ id: "worker-1", index: 1, tmuxSession: "trail-worker-1", task: "test", cwd: tmp, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", state: "starting" })}\n`, "utf8");
		const command = buildWorkerLaunchCommand({ id: "worker-1", sessionDir: path.join(tmp, "session"), statusFile, initialPrompt: "prompt", piCommandParts: ["sh", "-c", "exit 7"] });
		const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
		assert.equal(result.status, 0);
		const status = JSON.parse(await readFile(statusFile, "utf8")) as WorkerStatus;
		assert.equal(status.state, "failed");
		assert.equal(status.lastError, "worker process exited before reporting ready (exit 7)");
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
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

test("worker status sync reader supports live spawn messages", async () => {
	await withTempHome(async () => {
		const store = createWorkerStore();
		const root = store.root();
		await mkdir(root, { recursive: true });
		await seedWorker(root, { id: "live-worker", index: 1, state: "ready" });

		assert.equal(readWorkerStatusSync("live-worker")?.state, "ready");
		assert.equal(readWorkerStatusSync("../live-worker"), undefined);
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

test("purge cascades to child workers when requested", async () => {
	await withTempHome(async () => {
		const store = createWorkerStore();
		const root = store.root();
		await mkdir(root, { recursive: true });
		await seedWorker(root, { id: "parent", index: 1, state: "ended" });
		await seedWorker(root, { id: "child-a", index: 2, parentWorkerId: "parent", depth: 1, state: "ended" });
		await seedWorker(root, { id: "child-b", index: 3, parentWorkerId: "parent", depth: 1, state: "ended" });
		await seedWorker(root, { id: "grandchild", index: 4, parentWorkerId: "child-a", depth: 2, state: "ended" });
		await seedWorker(root, { id: "unrelated", index: 5, state: "ended" });

		const purged = await store.purge("parent", { cascade: true });
		const remaining = (await store.list()).map((w) => w.id).sort();

		assert.equal(purged.includes("parent"), true);
		assert.equal(purged.includes("child-a"), true);
		assert.equal(purged.includes("child-b"), true);
		assert.equal(purged.includes("grandchild"), true);
		assert.deepEqual(remaining, ["unrelated"]);
	});
});

test("countActive ignores ended/failed workers", async () => {
	await withTempHome(async () => {
		const store = createWorkerStore();
		const root = store.root();
		await mkdir(root, { recursive: true });
		await seedWorker(root, { id: "a", index: 1, state: "active" });
		await seedWorker(root, { id: "b", index: 2, state: "needs_input" });
		await seedWorker(root, { id: "c", index: 3, state: "ready" });
		await seedWorker(root, { id: "d", index: 4, state: "ended" });
		await seedWorker(root, { id: "e", index: 5, state: "failed" });
		assert.equal(await store.countActive(), 2);
	});
});
