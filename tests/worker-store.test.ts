import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildWorkerInitialPrompt, buildWorkerLaunchCommand, createWorkerStore, createWorkerWorkspace, currentPiCommandParts, explicitExtensionArgs, projectKey, readWorkerStatusSync, workerInProject, workerProjectKey, workerShortLabel, workerSummaryName, type WorkerStatus } from "../extensions/worker-store.js";

const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "docket-worker-test-"));
	process.env.PI_CODING_AGENT_DIR = tmp;
	try {
		return await fn();
	} finally {
		if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
		await rm(tmp, { recursive: true, force: true });
	}
}

type LegacyHierarchyFields = { parentWorkerId?: string; depth?: number; canSpawn?: string[] };

async function seedWorker(root: string, partial: Partial<WorkerStatus> & LegacyHierarchyFields & { id: string; index: number }): Promise<void> {
	const { id, index, ...overrides } = partial;
	const status: WorkerStatus & LegacyHierarchyFields = {
		id,
		index,
		tmuxSession: partial.tmuxSession ?? `docket-worker-${id}`,
		task: partial.task ?? "demo task",
		cwd: partial.cwd ?? "/repo",
		createdAt: partial.createdAt ?? "2026-05-01T00:00:00.000Z",
		updatedAt: partial.updatedAt ?? "2026-05-01T00:00:00.000Z",
		state: partial.state ?? "active",
		...overrides,
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
	assert.match(text, /docket_wait/);
	assert.match(text, /docket_done/);
	assert.match(text, /docket_fail/);
	assert.match(text, /docket_todos/);
	assert.match(text, /Recommended:/);
	assert.match(text, /same response that calls `docket_done`/);
	assert.match(text, /Do not assume/i);
	assert.match(text, /Read-only by default/);
	assert.match(text, /Shared tmux session/);
	assert.match(text, /Never invoke `tmux` directly/);
});

test("worker initial prompt points at guardrails and names protocol tools", () => {
	const prompt = buildWorkerInitialPrompt({ index: 1, id: "demo", dir: "/tmp/docket-worker-demo" });
	assert.match(prompt, /<docket_worker_guardrails>/);
	assert.match(prompt, /docket_wait/);
	assert.match(prompt, /docket_done/);
	assert.match(prompt, /docket_fail/);
	assert.match(prompt, /docket_todos/);
	assert.match(prompt, /task is in \/tmp\/docket-worker-demo\/task\.md/);
	const worktreePrompt = buildWorkerInitialPrompt({ index: 1, id: "demo", dir: "/tmp/docket-worker-demo", worktreePath: "/tmp/docket-worker-demo/worktree" });
	assert.match(worktreePrompt, /Worker workspace: \/tmp\/docket-worker-demo\/worktree/);
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
		extensionArgs: ["--no-extensions", "-e", "./extensions/docket.ts"],
		agentDir: "/tmp/docket agent",
		piCommandParts: parts,
	});
	assert.match(command, /DOCKET_WORKER_ID='worker-1' PI_CODING_AGENT_DIR='\/tmp\/docket agent' '\/usr\/local\/bin\/node' '\/opt\/homebrew\/lib\/node_modules\/\@earendil-works\/pi-coding-agent\/dist\/cli\.js'/);
	assert.match(command, /--session-dir '\/tmp\/session'/);
	assert.match(command, /'--no-extensions' '-e' '\.\/extensions\/docket\.ts'/);
	assert.match(command, /; code=\$\?; /);
	assert.match(command, /worker process exited before reporting ready/);
});

test("worker launch command preserves agent dir for child process", async () => {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "docket-worker-agent-dir-"));
	try {
		const output = path.join(tmp, "agent-dir.txt");
		const command = buildWorkerLaunchCommand({
			id: "worker-1",
			sessionDir: path.join(tmp, "session"),
			statusFile: path.join(tmp, "status.json"),
			initialPrompt: "prompt",
			agentDir: "/tmp/isolated-agent",
			piCommandParts: ["sh", "-c", `printf '%s' "$PI_CODING_AGENT_DIR" > ${JSON.stringify(output)}`],
		});
		assert.equal(spawnSync("sh", ["-c", command], { encoding: "utf8" }).status, 0);
		assert.equal(await readFile(output, "utf8"), "/tmp/isolated-agent");
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});

test("worker handoff writes exact sidecar and retry preserves selected model", async () => {
	await withTempHome(async () => {
		const tmp = await mkdtemp(path.join(os.tmpdir(), "docket-worker-handoff-store-"));
		const bin = path.join(tmp, "bin");
		const log = path.join(tmp, "tmux.log");
		const tmux = path.join(bin, "tmux");
		const oldPath = process.env.PATH;
		const oldTmux = process.env.TMUX;
		const oldTmuxLog = process.env.TMUX_LOG;
		try {
			await mkdir(bin, { recursive: true });
			await writeFile(tmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TMUX_LOG"\ncase "$1" in\n  -V) echo 'tmux 3.4'; exit 0 ;;\n  has-session) exit 1 ;;\n  display-message) echo '@7'; exit 0 ;;\n  *) exit 0 ;;\nesac\n`, "utf8");
			await chmod(tmux, 0o755);
			process.env.PATH = `${bin}:${oldPath ?? ""}`;
			process.env.TMUX_LOG = log;
			delete process.env.TMUX;

			const store = createWorkerStore();
			const body = "# Approved plan\n\nExact final byte";
			const spawned = await store.spawn({
				task: "implement approved plan",
				cwd: tmp,
				worktree: false,
				fresh: true,
				model: "openai/gpt-5",
				thinking: "high",
				extensionArgs: ["--model", "openai/gpt-5", "--thinking", "high"],
				sourceDeliverable: {
					body,
					provenance: {
						sourceDeliverableId: "worker-deliverable:source",
						sourceVersion: 2,
						sourceRef: "worker-deliverable:source:2",
						sourceWorkerId: "source",
						sourceWorkerLabel: "w1",
						approvingDecisionId: "decision-1",
						approvedAt: "2026-01-01T00:00:00.000Z",
						sidecarPath: "source-deliverable.md",
					},
				},
			});

			const sidecar = path.join(store.dirFor(spawned.id), "source-deliverable.md");
			assert.equal(await readFile(sidecar, "utf8"), body);
			assert.match(await readFile(store.taskFile(spawned.id), "utf8"), /worker-deliverable:source:2[\s\S]*source-deliverable\.md/);
			assert.equal((await store.find(spawned.id))?.sourceHandoff?.approvingDecisionId, "decision-1");

			const legacyStatus = JSON.parse(await readFile(store.statusFile(spawned.id), "utf8")) as Record<string, unknown>;
			legacyStatus.parentWorkerId = "old-parent";
			legacyStatus.depth = 2;
			legacyStatus.canSpawn = ["scout"];
			await writeFile(store.statusFile(spawned.id), `${JSON.stringify(legacyStatus)}\n`, "utf8");
			await store.patchStatus(spawned.id, { state: "failed" });
			await writeFile(log, "", "utf8");
			await store.respawn(spawned.id);
			const launches = await readFile(log, "utf8");
			assert.match(launches, /'--model' 'openai\/gpt-5' '--thinking' 'high'/);
			assert.doesNotMatch(launches, /dispatched by worker|depth 2/);
		} finally {
			if (oldPath === undefined) delete process.env.PATH;
			else process.env.PATH = oldPath;
			if (oldTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = oldTmux;
			if (oldTmuxLog === undefined) delete process.env.TMUX_LOG;
			else process.env.TMUX_LOG = oldTmuxLog;
			await rm(tmp, { recursive: true, force: true });
		}
	});
});

test("explicit extension args preserve no-extension isolation", () => {
	const originalArgv = process.argv;
	process.argv = ["node", "pi", "--no-extensions", "-e", "./extensions/docket.ts", "--extension=extra.ts", "--model", "sonnet"];
	try {
		assert.deepEqual(explicitExtensionArgs(), ["--no-extensions", "-e", "./extensions/docket.ts", "--extension", "extra.ts"]);
	} finally {
		process.argv = originalArgv;
	}
});

test("worker workspace is seeded from parent dirty state", async () => {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "docket-worker-workspace-test-"));
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
		assert.equal(created?.kind, "git");
		assert.ok(created?.snapshotHead);
		assert.equal(await readFile(path.join(workspace, "tracked.txt"), "utf8"), "one\nparent dirty\n");
		assert.equal(await readFile(path.join(workspace, "untracked.txt"), "utf8"), "parent untracked\n");
		assert.equal(spawnSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: workspace }).status, 0);
	} finally {
		spawnSync("git", ["worktree", "remove", "--force", workspace], { cwd: tmp, stdio: "ignore" });
		await rm(tmp, { recursive: true, force: true });
	}
});

test("worker workspace falls back to copied git baseline for unborn repos", async () => {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "docket-worker-unborn-test-"));
	const workspace = path.join(os.tmpdir(), `${path.basename(tmp)}-workspace`);
	try {
		await rm(workspace, { recursive: true, force: true });
		const git = (args: string[]) => {
			const result = spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr || result.error?.message);
			return result.stdout.trim();
		};
		git(["init"]);
		await writeFile(path.join(tmp, "draft.txt"), "unborn\n", "utf8");

		const created = createWorkerWorkspace(tmp, workspace);

		assert.equal(created.kind, "copy");
		assert.equal(await realpath(created.baseRoot!), await realpath(tmp));
		assert.ok(created.snapshotHead);
		assert.equal(await readFile(path.join(workspace, "draft.txt"), "utf8"), "unborn\n");
		assert.equal(spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: workspace }).status, 0);
	} finally {
		await rm(workspace, { recursive: true, force: true });
		await rm(tmp, { recursive: true, force: true });
	}
});

test("worker workspace falls back to copied git baseline outside repos", async () => {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "docket-worker-nonrepo-test-"));
	const workspace = path.join(os.tmpdir(), `${path.basename(tmp)}-workspace`);
	try {
		await rm(workspace, { recursive: true, force: true });
		await writeFile(path.join(tmp, "notes.txt"), "plain\n", "utf8");

		const created = createWorkerWorkspace(tmp, workspace);

		assert.equal(created.kind, "copy");
		assert.equal(await realpath(created.baseRoot!), await realpath(tmp));
		assert.ok(created.snapshotHead);
		assert.equal(await readFile(path.join(workspace, "notes.txt"), "utf8"), "plain\n");
		assert.equal(spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: workspace }).status, 0);
	} finally {
		await rm(workspace, { recursive: true, force: true });
		await rm(tmp, { recursive: true, force: true });
	}
});

test("worker launch command marks early process exits", async () => {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "docket-worker-exit-test-"));
	try {
		const statusFile = path.join(tmp, "status.json");
		await writeFile(statusFile, `${JSON.stringify({ id: "worker-1", index: 1, tmuxSession: "docket-worker-1", task: "test", cwd: tmp, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", state: "starting" })}\n`, "utf8");
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

test("stale worker exit hook cannot overwrite a newer launch", async () => {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "docket-worker-stale-exit-test-"));
	try {
		const statusFile = path.join(tmp, "status.json");
		await writeFile(statusFile, `${JSON.stringify({ id: "worker-1", index: 1, tmuxSession: "docket-worker-1", task: "test", cwd: tmp, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", state: "active", runToken: "new-run" })}\n`, "utf8");
		const command = buildWorkerLaunchCommand({ id: "worker-1", sessionDir: path.join(tmp, "session"), statusFile, initialPrompt: "prompt", piCommandParts: ["sh", "-c", "exit 7"], runToken: "old-run" });
		assert.equal(spawnSync("sh", ["-c", command], { encoding: "utf8" }).status, 0);
		const status = JSON.parse(await readFile(statusFile, "utf8")) as WorkerStatus;
		assert.equal(status.state, "active");
		assert.equal(status.runToken, "new-run");
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

test("projectKey returns git toplevel or realpath cwd", async () => {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "docket-project-key-test-"));
	const outside = await mkdtemp(path.join(os.tmpdir(), "docket-project-key-outside-"));
	try {
		const git = (args: string[], cwd = tmp) => {
			const result = spawnSync("git", args, { cwd, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr || result.error?.message);
		};
		git(["init"]);
		await mkdir(path.join(tmp, "src"), { recursive: true });
		assert.equal(projectKey(path.join(tmp, "src")), await realpath(tmp));
		assert.equal(projectKey(outside), await realpath(outside));
		const link = path.join(os.tmpdir(), `${path.basename(tmp)}-link`);
		await rm(link, { recursive: true, force: true });
		await symlink(tmp, link);
		assert.equal(projectKey(path.join(link, "src")), await realpath(tmp));
		await rm(link, { recursive: true, force: true });
	} finally {
		await rm(tmp, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("worker project key falls back through legacy worktree fields", async () => {
	const project = await mkdtemp(path.join(os.tmpdir(), "docket-worker-project-test-"));
	const workspace = await mkdtemp(path.join(os.tmpdir(), "docket-worker-workspace-project-test-"));
	try {
		const worker = {
			id: "legacy",
			index: 1,
			tmuxSession: "docket-worker-legacy",
			task: "legacy",
			cwd: workspace,
			worktree: { path: workspace, baseCwd: project, baseRoot: project, parentCwd: path.join(project, "src") },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			state: "active",
		} as WorkerStatus;
		assert.equal(workerProjectKey(worker), projectKey(project));
		assert.equal(workerInProject(worker, projectKey(project)), true);
	} finally {
		await rm(project, { recursive: true, force: true });
		await rm(workspace, { recursive: true, force: true });
	}
});

test("worker store list filters by project root", async () => {
	await withTempHome(async () => {
		const store = createWorkerStore();
		const root = store.root();
		const projectA = await mkdtemp(path.join(os.tmpdir(), "docket-worker-project-a-"));
		const projectB = await mkdtemp(path.join(os.tmpdir(), "docket-worker-project-b-"));
		try {
			await mkdir(root, { recursive: true });
			await seedWorker(root, { id: "a", index: 1, projectRoot: projectKey(projectA) });
			await seedWorker(root, { id: "b", index: 2, projectRoot: projectKey(projectB) });
			await seedWorker(root, { id: "legacy-a", index: 3, cwd: path.join(projectA, "worker"), worktree: { path: path.join(projectA, "worker"), baseCwd: projectA, baseRoot: projectA, parentCwd: projectA } });

			assert.deepEqual((await store.list({ projectRoot: projectKey(projectA) })).map((w) => w.id), ["a", "legacy-a"]);
			assert.deepEqual((await store.list({ projectRoot: projectKey(projectB) })).map((w) => w.id), ["b"]);
			assert.equal((await store.list()).length, 3);
		} finally {
			await rm(projectA, { recursive: true, force: true });
			await rm(projectB, { recursive: true, force: true });
		}
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

test("worker store serializes concurrent status transitions without lost fields", async () => {
	await withTempHome(async () => {
		const store = createWorkerStore();
		await mkdir(store.root(), { recursive: true });
		await seedWorker(store.root(), { id: "serialized", index: 1, state: "active" });

		const [heartbeat, review] = await Promise.all([
			store.updateStatus("serialized", () => ({ pid: 42, artifactCount: 3 })),
			store.updateStatus("serialized", () => ({ reviewedAt: "2026-05-02T00:00:00.000Z" })),
		]);
		const final = await store.find("serialized");

		assert.equal(heartbeat.changed, true);
		assert.equal(review.changed, true);
		assert.equal(final?.pid, 42);
		assert.equal(final?.artifactCount, 3);
		assert.equal(final?.reviewedAt, "2026-05-02T00:00:00.000Z");
		const noOp = await store.updateStatus("serialized", () => undefined);
		assert.equal(noOp.changed, false);
		assert.equal(noOp.after?.updatedAt, final?.updatedAt);
	});
});

test("legacy hierarchy statuses list safely and purge removes only requested worker", async () => {
	await withTempHome(async () => {
		const store = createWorkerStore();
		const root = store.root();
		await mkdir(root, { recursive: true });
		await seedWorker(root, { id: "parent", index: 1, state: "ended" });
		await seedWorker(root, { id: "child-a", index: 2, parentWorkerId: "parent", depth: 1, canSpawn: ["scout"], state: "ended" });
		await seedWorker(root, { id: "child-b", index: 3, parentWorkerId: "parent", depth: 1, state: "ended" });
		await seedWorker(root, { id: "grandchild", index: 4, parentWorkerId: "child-a", depth: 2, state: "ended" });
		await seedWorker(root, { id: "unrelated", index: 5, state: "ended" });

		const listed = await store.list();
		assert.equal(listed.length, 5);
		assert.equal((listed.find((worker) => worker.id === "child-a") as WorkerStatus & LegacyHierarchyFields).depth, 1);
		const purged = await store.purge("parent");
		const remaining = (await store.list()).map((worker) => worker.id).sort();

		assert.deepEqual(purged, ["parent"]);
		assert.deepEqual(remaining, ["child-a", "child-b", "grandchild", "unrelated"]);
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

test("pane harvest settles missing windows and reads back captured tails", async () => {
	await withTempHome(async () => {
		const store = createWorkerStore();
		const root = store.root();
		await mkdir(root, { recursive: true });
		await seedWorker(root, { id: "post-mortem", index: 1, state: "failed" });

		assert.equal(await store.harvestPaneTail("missing-worker"), "not_found");

		// No tmux window resolves for the seeded target: harvest settles without a capture.
		assert.equal(await store.harvestPaneTail("post-mortem"), "window_gone");
		const settled = await store.find("post-mortem");
		assert.equal(typeof settled?.paneCapturedAt, "string");
		assert.equal(await store.readPaneTail("post-mortem"), undefined);

		// Settled workers are not re-probed.
		assert.equal(await store.harvestPaneTail("post-mortem"), "window_gone");

		// A captured tail reads back verbatim; blank files read as undefined.
		await writeFile(path.join(root, "post-mortem", "pane-tail.txt"), "Error: boom\n  at main.ts:1\n", "utf8");
		assert.match((await store.readPaneTail("post-mortem")) ?? "", /Error: boom/);
		await writeFile(path.join(root, "post-mortem", "pane-tail.txt"), "  \n", "utf8");
		assert.equal(await store.readPaneTail("post-mortem"), undefined);
	});
});
