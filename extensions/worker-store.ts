import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir, SessionManager } from "@mariozechner/pi-coding-agent";
import { appendWorkerQuestionPatch, buildWorkerInitialPrompt as buildBackgroundWorkerInitialPrompt, buildWorkerTaskDocument, workerInputAcceptedPatch, workerShortLabel, type WorkerQuestion, type WorkerStatus, type WorkerWorktree } from "./background-work.js";
import { paneHarvestedTransition, parentReplyAcceptedTransition, respawnFailedTransition, respawnStartedTransition, type WorkerTransition } from "./worker-lifecycle.js";
import type { Artifact, GitSnapshot } from "./types.js";
import { readCurrentWorkerDeliverable, readWorkerDeliverable, workerDeliverableFile, workerDeliverablesDir, type WorkerDeliverable, type WorkerHandoffProvenance } from "./worker-deliverable.js";

export { workerShortLabel, workerSummaryName, type WorkerQuestion, type WorkerState, type WorkerStatus } from "./background-work.js";

export const WORKER_TMUX_PREFIX = "docket-worker-";
export const DOCKET_WORKER_ENV = "DOCKET_WORKER_ID";
export const WORKER_DASHBOARD_TMUX = "docket-workers";
/** Single tmux session that hosts every worker window. */
export const SHARED_TMUX_SESSION = "docket-workers";

export function workerWindowTarget(index: number): string {
	return `${SHARED_TMUX_SESSION}:w${index}`;
}

export function isSharedSessionTarget(target: string | undefined): boolean {
	return typeof target === "string" && target.startsWith(`${SHARED_TMUX_SESSION}:`);
}

export type WorkerStore = {
	root(): string;
	dirFor(id: string): string;
	statusFile(id: string): string;
	artifactsFile(id: string): string;
	taskFile(id: string): string;
	deliverablesDir(id: string): string;
	deliverableFile(id: string, version: number): string;
	readDeliverable(id: string, version: number): Promise<WorkerDeliverable | undefined>;
	readCurrentDeliverable(worker: WorkerStatus | string): Promise<WorkerDeliverable | undefined>;
	list(options?: { projectRoot?: string }): Promise<WorkerStatus[]>;
	find(id: string): Promise<WorkerStatus | undefined>;
	readArtifacts(id: string): Promise<Artifact[]>;
	writeStatus(snapshot: WorkerStatus): Promise<void>;
	patchStatus(id: string, patch: Partial<WorkerStatus>): Promise<WorkerStatus | undefined>;
	updateStatus(id: string, transition: WorkerTransition): Promise<{ before: WorkerStatus | undefined; after: WorkerStatus | undefined; changed: boolean }>;
	writeArtifacts(id: string, artifacts: Artifact[]): Promise<void>;
	addQuestion(id: string, text: string): Promise<WorkerStatus | undefined>;
	sendInput(id: string, text: string): Promise<boolean>;
	spawn(input: SpawnInput): Promise<WorkerStatus>;
	kill(id: string): Promise<boolean>;
	purge(id: string): Promise<string[]>;
	countActive(): Promise<number>;
	/** Re-launch a worker whose tmux window died. Reuses the worker dir + seeded session. */
	respawn(id: string): Promise<WorkerStatus | undefined>;
	/**
	 * Post-mortem capture for a terminal worker: if its pane is dead (remain-on-exit),
	 * save the scrollback tail to pane-tail.txt, kill the window, and mark the status.
	 * "alive" means the worker process still runs — caller should leave it alone.
	 */
	harvestPaneTail(id: string): Promise<PaneHarvestResult>;
	/** Read the harvested pane tail, if one was captured. */
	readPaneTail(id: string): Promise<string | undefined>;
};

export type PaneHarvestResult = "captured" | "window_gone" | "alive" | "not_found";

export type SpawnInput = {
	task: string;
	cwd: string;
	git?: GitSnapshot;
	worktree?: boolean;
	parentSession?: string;
	extensionArgs?: string[];
	idHint?: string;
	/** Skip parent-session JSONL seeding. Worker starts with a blank session. */
	fresh?: boolean;
	/** Worker kind name; resolved by registry. */
	kind?: string;
	/** Kind-specific system-prompt body to append after universal guardrails. */
	kindSystemPrompt?: string;
	/** Whether this worker's kind forbids file edits. */
	readOnly?: boolean;
	/** Whether this worker must ask parent approval before first mutating step. */
	planGate?: boolean;
	/** Scope-specific authority lines surfaced in task.md. */
	decisionRights?: string[];
	/** Optional tmux layout. */
	layout?: "single" | "split-events";
	/** When true, run tmux pipe-pane to capture terminal output to pane.log. */
	captureTerminal?: boolean;
	/** Canonical resolved provider/model persisted for visibility and exact respawn. */
	model?: string;
	/** Resolved effective thinking persisted for visibility and exact respawn. */
	thinking?: WorkerStatus["thinking"];
	/** Exact reviewed body and provenance for a human-started handoff worker. */
	sourceDeliverable?: { body: string; provenance: WorkerHandoffProvenance };
};

function workersRoot(): string {
	return path.join(getAgentDir(), "docket", "workers");
}

function workerDir(id: string): string {
	return path.join(workersRoot(), id);
}

function tmuxSafeId(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "worker";
	return safe.slice(0, 64);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const WORKER_EXIT_PATCH_SCRIPT = [
	`const fs = require("fs");`,
	`const file = process.argv[1];`,
	`const rawCode = process.argv[2] ?? "";`,
	`const runToken = process.argv[3] ?? "";`,
	`const lock = file + ".lock";`,
	`const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);`,
	`const until = Date.now() + 5000;`,
	`for (;;) { try { fs.mkdirSync(lock); break; } catch (err) { if (err.code !== "EEXIST") process.exit(0); try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmSync(lock,{recursive:true,force:true}); continue; } } catch {} if (Date.now() >= until) process.exit(0); sleep(20); } }`,
	`let status;`,
	`try { status = JSON.parse(fs.readFileSync(file, "utf8")); if (status && (!runToken || status.runToken === runToken) && !["needs_input", "ready", "failed", "error", "ended"].includes(status.state)) { const code = Number(rawCode); if (code === 0) status.state = "ended"; else { status.state = "failed"; const label = Number.isFinite(code) ? String(code) : rawCode; status.lastError = "worker process exited before reporting ready (exit " + label + ")"; } status.updatedAt = new Date().toISOString(); const tmp = file + "." + process.pid + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + "\\n", "utf8"); fs.renameSync(tmp,file); } } catch {} finally { try { fs.rmSync(lock,{recursive:true,force:true}); } catch {} }`,
].join("");

export function currentPiCommandParts(argv: string[] = process.argv, execPath = process.execPath): string[] {
	const script = argv[1];
	if (script && path.isAbsolute(script) && (path.basename(script) === "pi" || script.includes("pi-coding-agent"))) return [execPath, script];
	return ["pi"];
}

function workerExitPatchCommand(statusFile: string, runToken?: string): string {
	return `${shellQuote(process.execPath)} -e ${shellQuote(WORKER_EXIT_PATCH_SCRIPT)} ${shellQuote(statusFile)} "$code" ${shellQuote(runToken ?? "")}`;
}

export function buildWorkerLaunchCommand(input: { id: string; sessionDir: string; statusFile: string; initialPrompt: string; extensionArgs?: string[]; piCommandParts?: string[]; resumeSeeded?: boolean; runToken?: string; agentDir?: string }): string {
	const env = [
		`${DOCKET_WORKER_ENV}=${shellQuote(input.id)}`,
		...(input.agentDir ? [`PI_CODING_AGENT_DIR=${shellQuote(input.agentDir)}`] : []),
	];
	const piParts = [...env, ...(input.piCommandParts ?? currentPiCommandParts()).map(shellQuote), "--session-dir", shellQuote(input.sessionDir)];
	if (input.resumeSeeded) piParts.push("--continue");
	for (const arg of input.extensionArgs ?? []) piParts.push(shellQuote(arg));
	piParts.push(shellQuote(input.initialPrompt));
	return `${piParts.join(" ")}; code=$?; ${workerExitPatchCommand(input.statusFile, input.runToken)}`;
}

function ensureTmux(): void {
	const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
	if (result.error || result.status !== 0) throw new Error("tmux not found. Install tmux and try again.");
}

function tmuxSessionExists(name: string): boolean {
	return spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" }).status === 0;
}

function killTmux(target: string, windowId?: string): boolean {
	if (isSharedSessionTarget(target) || windowId) {
		if (!tmuxSessionExists(SHARED_TMUX_SESSION)) return false;
		// Prefer stable window id (e.g. "@7") when present so a renamed window still resolves.
		const primary = windowId ? ["kill-window", "-t", windowId] : ["kill-window", "-t", target];
		const result = spawnSync("tmux", primary, { stdio: "ignore" });
		if (result.status === 0) return true;
		if (windowId) {
			const fallback = spawnSync("tmux", ["kill-window", "-t", target], { stdio: "ignore" });
			return fallback.status === 0;
		}
		return false;
	}
	if (!tmuxSessionExists(target)) return false;
	const result = spawnSync("tmux", ["kill-session", "-t", target], { stdio: "ignore" });
	return result.status === 0;
}

function readWindowId(target: string): string | undefined {
	const result = spawnSync("tmux", ["display-message", "-p", "-t", target, "#{window_id}"], { encoding: "utf8" });
	if (result.error || result.status !== 0) return undefined;
	const trimmed = result.stdout.trim();
	return trimmed.startsWith("@") ? trimmed : undefined;
}

function currentTmuxTarget(): string | undefined {
	if (!process.env.TMUX) return undefined;
	const result = spawnSync("tmux", ["display-message", "-p", "#{session_name}:#{window_index}.#{pane_index}"], { encoding: "utf8" });
	if (result.error || result.status !== 0) return undefined;
	const target = result.stdout.trim();
	return target.length > 0 ? target : undefined;
}

export function sharedSessionExists(): boolean {
	return tmuxSessionExists(SHARED_TMUX_SESSION);
}

/**
 * Read-only snapshot of a worker's tmux pane (live or dead) for in-TUI peeking —
 * the "glass wall": observe without attaching. Undefined when the window is gone.
 */
export function captureWorkerPane(worker: Pick<WorkerStatus, "tmuxSession" | "tmuxWindowId">, lines = 60): string | undefined {
	return capturePaneTail(worker.tmuxWindowId ?? worker.tmuxSession, lines);
}

function gitOutput(cwd: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): string | undefined {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", input: options.input, env: options.env ? { ...process.env, ...options.env } : undefined, maxBuffer: 20 * 1024 * 1024 });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

function realpathKey(value: string): string {
	const resolved = path.resolve(value);
	try {
		return fsSync.realpathSync.native(resolved);
	} catch {
		try { return fsSync.realpathSync(resolved); } catch { return resolved; }
	}
}

export function projectKey(cwd: string): string {
	const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
	return realpathKey(root ?? cwd);
}

export function workerProjectKey(worker: WorkerStatus): string {
	return worker.projectRoot ? realpathKey(worker.projectRoot) : projectKey(worker.worktree?.baseRoot ?? worker.worktree?.parentCwd ?? worker.cwd);
}

export function workerInProject(worker: WorkerStatus, key: string): boolean {
	return workerProjectKey(worker) === realpathKey(key);
}

function gitStatus(cwd: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): { status: number | null; stderr: string; error?: Error } {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", input: options.input, env: options.env ? { ...process.env, ...options.env } : undefined, maxBuffer: 20 * 1024 * 1024 });
	return { status: result.status, stderr: result.stderr.trim(), ...(result.error ? { error: result.error } : {}) };
}

function gitRawOutput(cwd: string, args: string[]): string | undefined {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
	if (result.error || result.status !== 0 || result.stdout.length === 0) return undefined;
	return result.stdout;
}

function copyUntrackedFiles(baseRoot: string, targetRoot: string): void {
	const raw = gitRawOutput(baseRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (!raw) return;
	for (const rel of raw.split("\0").filter(Boolean)) {
		const from = path.join(baseRoot, rel);
		const to = path.join(targetRoot, rel);
		fsSync.mkdirSync(path.dirname(to), { recursive: true });
		fsSync.copyFileSync(from, to);
	}
}

function copyWorkspaceFiles(sourceRoot: string, targetRoot: string): void {
	fsSync.rmSync(targetRoot, { recursive: true, force: true });
	fsSync.mkdirSync(path.dirname(targetRoot), { recursive: true });
	fsSync.cpSync(sourceRoot, targetRoot, {
		recursive: true,
		errorOnExist: false,
		filter: (source) => !source.split(path.sep).includes(".git"),
	});
}

function createBaselineCommit(worktreePath: string, parent: string | undefined): string | undefined {
	gitStatus(worktreePath, ["add", "-A"]);
	const changed = gitStatus(worktreePath, ["diff", "--cached", "--quiet", parent ?? "HEAD"]).status !== 0;
	if (!changed) return parent;
	const tree = gitOutput(worktreePath, ["write-tree"]);
	if (!tree) return parent;
	const commit = gitOutput(worktreePath, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "Docket worker baseline"], {
		env: {
			GIT_AUTHOR_NAME: "Docket",
			GIT_AUTHOR_EMAIL: "docket@example.invalid",
			GIT_COMMITTER_NAME: "Docket",
			GIT_COMMITTER_EMAIL: "docket@example.invalid",
		},
	});
	if (!commit) return parent;
	gitStatus(worktreePath, ["reset", "--hard", commit]);
	return commit;
}

function createCopiedWorkspace(baseCwd: string, sourceRoot: string, target: string): WorkerWorktree {
	copyWorkspaceFiles(sourceRoot, target);
	gitStatus(target, ["init"]);
	const snapshotHead = createBaselineCommit(target, undefined);
	return { kind: "copy", path: target, baseCwd, baseRoot: sourceRoot, parentCwd: baseCwd, ...(snapshotHead ? { baseHead: snapshotHead, snapshotHead } : {}) };
}

export function createWorkerWorkspace(baseCwd: string, target: string): WorkerWorktree {
	const inRepo = gitOutput(baseCwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
	const baseRoot = inRepo ? gitOutput(baseCwd, ["rev-parse", "--show-toplevel"]) : undefined;
	const root = baseRoot ?? baseCwd;
	const baseHead = inRepo ? gitOutput(baseCwd, ["rev-parse", "--verify", "HEAD"]) : undefined;
	if (!inRepo || !baseHead) return createCopiedWorkspace(baseCwd, root, target);

	const result = spawnSync("git", ["worktree", "add", "--detach", target, baseHead], { cwd: baseCwd, encoding: "utf8" });
	if (result.error || result.status !== 0) throw new Error(result.stderr.trim() || result.error?.message || "git worktree add failed");
	try {
		const dirtyPatch = gitRawOutput(root, ["diff", "--binary", "HEAD"]);
		if (dirtyPatch) {
			const applied = gitStatus(target, ["apply", "--binary", "--whitespace=nowarn"], { input: dirtyPatch });
			if (applied.status !== 0) throw new Error(applied.stderr || "git apply parent changes failed");
		}
		copyUntrackedFiles(root, target);
		const snapshotHead = createBaselineCommit(target, baseHead);
		return { kind: "git", path: target, baseCwd, baseRoot: root, parentCwd: baseCwd, baseHead, ...(snapshotHead ? { snapshotHead } : {}) };
	} catch (err) {
		removeWorkerWorkspace({ kind: "git", path: target, baseCwd });
		throw err;
	}
}

function removeWorkerWorkspace(worktree: Pick<WorkerWorktree, "path" | "baseCwd" | "kind">): void {
	if (worktree.kind === "copy") {
		fsSync.rmSync(worktree.path, { recursive: true, force: true });
		return;
	}
	spawnSync("git", ["worktree", "remove", "--force", worktree.path], { cwd: worktree.baseCwd, stdio: "ignore" });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

async function writeJsonAtomic(file: string, payload: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${suffix}.tmp`);
	try {
		await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		await fs.rename(tmp, file);
	} catch (err) {
		await fs.rm(tmp, { force: true });
		throw err;
	}
}

const STATUS_LOCK_TIMEOUT_MS = 5_000;
const STATUS_LOCK_STALE_MS = 30_000;

async function withStatusLock<T>(file: string, run: () => Promise<T>): Promise<T> {
	const lock = `${file}.lock`;
	const deadline = Date.now() + STATUS_LOCK_TIMEOUT_MS;
	await fs.mkdir(path.dirname(file), { recursive: true });
	while (true) {
		try {
			await fs.mkdir(lock);
			break;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			try {
				const stat = await fs.stat(lock);
				if (Date.now() - stat.mtimeMs > STATUS_LOCK_STALE_MS) {
					await fs.rm(lock, { recursive: true, force: true });
					continue;
				}
			} catch (statErr: any) {
				if (statErr?.code !== "ENOENT") throw statErr;
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out acquiring worker status lock for ${path.basename(file)}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	try {
		return await run();
	} finally {
		await fs.rm(lock, { recursive: true, force: true });
	}
}

export function readWorkerStatusSync(id: string): WorkerStatus | undefined {
	if (!/^[a-z0-9_-]+$/i.test(id)) return undefined;
	try {
		const status = JSON.parse(fsSync.readFileSync(path.join(workerDir(id), "status.json"), "utf8")) as WorkerStatus;
		return status?.id ? status : undefined;
	} catch {
		return undefined;
	}
}

function makeWorkerId(task: string, hint?: string): string {
	const base = hint ?? task.split(/\s+/).slice(0, 4).join("-");
	const slug = tmuxSafeId(base);
	const suffix = randomBytes(2).toString("hex");
	return `${slug}-${suffix}`.slice(0, 80);
}

/**
 * Seed the worker's session dir with a fork of the parent's JSONL so the worker
 * starts with the parent's context (faster TTFT + reused prompt cache prefix).
 * Returns true when seeding succeeded and `--continue` should be passed to pi.
 */
export function seedWorkerSession(parentSessionFile: string, workerCwd: string, workerSessionDir: string): boolean {
	try {
		if (!fsSync.existsSync(parentSessionFile)) return false;
		fsSync.mkdirSync(workerCwd, { recursive: true });
		fsSync.mkdirSync(workerSessionDir, { recursive: true });
		SessionManager.forkFrom(parentSessionFile, workerCwd, workerSessionDir);
		return true;
	} catch {
		return false;
	}
}

export function buildWorkerInitialPrompt(input: { index: number; id: string; dir: string; worktreePath?: string; kind?: string }): string {
	return buildBackgroundWorkerInitialPrompt({
		label: workerShortLabel(input.index),
		id: input.id,
		taskFile: path.join(input.dir, "task.md"),
		artifactsFile: path.join(input.dir, "artifacts.json"),
		worktreePath: input.worktreePath,
		kind: input.kind,
	});
}

export function explicitExtensionArgs(): string[] {
	const out: string[] = [];
	for (let i = 0; i < process.argv.length; i++) {
		const arg = process.argv[i] ?? "";
		if (arg === "--no-extensions") {
			out.push(arg);
		} else if ((arg === "-e" || arg === "--extension") && process.argv[i + 1]) {
			out.push(arg, process.argv[++i]!);
		} else if (arg.startsWith("--extension=")) {
			out.push("--extension", arg.slice("--extension=".length));
		}
	}
	return out;
}

export function createWorkerStore(): WorkerStore {
	return {
		root() {
			return workersRoot();
		},
		dirFor(id: string) {
			return workerDir(id);
		},
		statusFile(id: string) {
			return path.join(workerDir(id), "status.json");
		},
		artifactsFile(id: string) {
			return path.join(workerDir(id), "artifacts.json");
		},
		taskFile(id: string) {
			return path.join(workerDir(id), "task.md");
		},
		deliverablesDir(id: string) {
			return workerDeliverablesDir(workersRoot(), id);
		},
		deliverableFile(id: string, version: number) {
			return workerDeliverableFile(workersRoot(), id, version);
		},
		async readDeliverable(id: string, version: number): Promise<WorkerDeliverable | undefined> {
			return readWorkerDeliverable(workersRoot(), id, version);
		},
		async readCurrentDeliverable(workerOrId: WorkerStatus | string): Promise<WorkerDeliverable | undefined> {
			const status = typeof workerOrId === "string" ? await this.find(workerOrId) : workerOrId;
			return status ? readCurrentWorkerDeliverable(workersRoot(), status) : undefined;
		},

		async list(options: { projectRoot?: string } = {}): Promise<WorkerStatus[]> {
			const root = workersRoot();
			let entries: string[];
			try {
				entries = await fs.readdir(root);
			} catch {
				return [];
			}
			const out: WorkerStatus[] = [];
			for (const name of entries) {
				const status = await readJson<WorkerStatus | undefined>(path.join(root, name, "status.json"), undefined);
				if (status?.id) out.push(status);
			}
			const projectRoot = options.projectRoot ? projectKey(options.projectRoot) : undefined;
			const scoped = projectRoot ? out.filter((worker) => workerInProject(worker, projectRoot)) : out;
			return scoped.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		},

		async find(id: string): Promise<WorkerStatus | undefined> {
			const all = await this.list();
			const trimmed = id.trim();
			const shortMatch = trimmed.match(/^w?(\d+)$/i);
			if (shortMatch) {
				const target = Number(shortMatch[1]);
				const byIndex = all.find((entry) => entry.index === target);
				if (byIndex) return byIndex;
			}
			const exact = await readJson<WorkerStatus | undefined>(this.statusFile(trimmed), undefined);
			if (exact) return exact;
			return all.find((entry) => entry.id === trimmed || entry.id.startsWith(trimmed));
		},

		async readArtifacts(id: string): Promise<Artifact[]> {
			return readJson<Artifact[]>(this.artifactsFile(id), []);
		},

		async writeStatus(snapshot: WorkerStatus): Promise<void> {
			const file = this.statusFile(snapshot.id);
			await withStatusLock(file, () => writeJsonAtomic(file, { ...snapshot, updatedAt: new Date().toISOString() }));
		},

		async patchStatus(id: string, patch: Partial<WorkerStatus>): Promise<WorkerStatus | undefined> {
			const result = await this.updateStatus(id, () => patch);
			return result.after;
		},

		async updateStatus(id: string, transition: WorkerTransition): Promise<{ before: WorkerStatus | undefined; after: WorkerStatus | undefined; changed: boolean }> {
			const file = this.statusFile(id);
			return withStatusLock(file, async () => {
				const before = await readJson<WorkerStatus | undefined>(file, undefined);
				if (!before) return { before, after: before, changed: false };
				const patch = transition(before);
				if (!patch) return { before, after: before, changed: false };
				const candidate = { ...before, ...patch, id: before.id };
				const changed = JSON.stringify({ ...before, updatedAt: undefined }) !== JSON.stringify({ ...candidate, updatedAt: undefined });
				if (!changed) return { before, after: before, changed: false };
				const after: WorkerStatus = { ...candidate, updatedAt: new Date().toISOString() };
				await writeJsonAtomic(file, after);
				return { before, after, changed: true };
			});
		},

		async writeArtifacts(id: string, artifacts: Artifact[]): Promise<void> {
			await writeJsonAtomic(this.artifactsFile(id), artifacts);
		},

		async addQuestion(id: string, text: string): Promise<WorkerStatus | undefined> {
			const current = await this.find(id);
			if (!current) return undefined;
			const question: WorkerQuestion = { id: `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`, text: text.trim(), createdAt: new Date().toISOString() };
			const patch = appendWorkerQuestionPatch(current, text, question);
			return patch ? this.patchStatus(current.id, patch) : current;
		},

		async sendInput(id: string, text: string): Promise<boolean> {
			const status = await this.find(id);
			if (!status) return false;
			const multiline = isMultilineInput(text);
			const payload = multiline ? normalizeMultilineInput(text) : sanitizeSingleLineInput(text);
			if (!payload) return false;
			const ok = sendKeysToWindow(status.tmuxSession, payload, status.tmuxWindowId, multiline);
			if (!ok) return false;
			await this.updateStatus(status.id, parentReplyAcceptedTransition(status));
			return true;
		},

		async countActive(): Promise<number> {
			const ACTIVE: Array<WorkerStatus["state"]> = ["starting", "active", "idle", "needs_input"];
			const workers = await this.list();
			return workers.filter((w) => ACTIVE.includes(w.state)).length;
		},

		async spawn(input: SpawnInput): Promise<WorkerStatus> {
			ensureTmux();
			const projectRoot = projectKey(input.cwd);
			const id = makeWorkerId(input.task, input.idHint);
			const dir = workerDir(id);
			await fs.mkdir(dir, { recursive: true });

			const sourceHandoff = input.sourceDeliverable
				? { ...input.sourceDeliverable.provenance, sidecarPath: path.join(dir, "source-deliverable.md") }
				: undefined;
			if (input.sourceDeliverable) await fs.writeFile(sourceHandoff!.sidecarPath, input.sourceDeliverable.body, "utf8");
			const worktree = input.worktree === false ? undefined : createWorkerWorkspace(input.cwd, path.join(dir, "workspace"));
			const workerCwd = worktree ? path.join(worktree.path, path.relative(worktree.baseRoot ?? worktree.baseCwd, input.cwd)) : input.cwd;
			if (worktree) await fs.mkdir(workerCwd, { recursive: true });

			const sessionDir = path.join(dir, "session");
			await fs.mkdir(sessionDir, { recursive: true });

			const resumeSeeded = input.fresh !== true && typeof input.parentSession === "string" && input.parentSession.length > 0
				? seedWorkerSession(input.parentSession, workerCwd, sessionDir)
				: false;

			const existing = await this.list();
			const index = existing.reduce((max, entry) => Math.max(max, entry.index ?? 0), 0) + 1;
			const target = workerWindowTarget(index);
			const windowName = `w${index}`;
			const parentTmuxTarget = currentTmuxTarget();
			await fs.writeFile(path.join(dir, "task.md"), buildWorkerTaskDocument({
				task: input.task,
				...(input.kind ? { kind: input.kind } : {}),
				...(typeof input.readOnly === "boolean" ? { readOnly: input.readOnly } : {}),
				worktree: input.worktree !== false,
				...(input.planGate ? { planGate: true } : {}),
				...(input.decisionRights?.length ? { decisionRights: input.decisionRights } : {}),
				...(sourceHandoff ? { sourceHandoff } : {}),
			}), "utf8");

			const initialPrompt = buildWorkerInitialPrompt({ index, id, dir, worktreePath: worktree?.path, kind: input.kind });

			const now = new Date().toISOString();
			const runToken = randomBytes(8).toString("hex");
			const status: WorkerStatus = {
				id,
				index,
				tmuxSession: target,
				task: input.task,
				cwd: workerCwd,
				projectRoot,
				git: input.git,
				worktree,
				createdAt: now,
				updatedAt: now,
				state: "starting",
				runToken,
				...(input.kind ? { kind: input.kind } : {}),
				...(input.model ? { model: input.model } : {}),
				...(input.thinking ? { thinking: input.thinking } : {}),
				...(sourceHandoff ? { sourceHandoff } : {}),
				...(parentTmuxTarget ? { parentTmuxTarget } : {}),
			};
			await this.writeStatus(status);

			const command = buildWorkerLaunchCommand({ id, sessionDir, statusFile: this.statusFile(id), initialPrompt, extensionArgs: input.extensionArgs ?? explicitExtensionArgs(), resumeSeeded, runToken, agentDir: getAgentDir() });
			const result = launchSharedWindow({ windowName, cwd: workerCwd, command });
			if (!result.ok) {
				if (worktree) removeWorkerWorkspace(worktree);
				await fs.rm(dir, { recursive: true, force: true });
				throw new Error(result.error || `tmux failed for ${id}`);
			}

			const windowId = readWindowId(target);
			if (windowId) await this.patchStatus(id, { tmuxWindowId: windowId });

			if (input.captureTerminal) {
				const log = path.join(dir, "pane.log");
				spawnSync("tmux", ["pipe-pane", "-o", "-t", windowId ?? target, `cat > ${shellQuote(log)}`], { stdio: "ignore" });
			}

			if (input.layout === "split-events") {
				const eventsPath = path.join(dir, "events.ndjson");
				const splitCmd = `touch ${shellQuote(eventsPath)} && tail -F ${shellQuote(eventsPath)}`;
				spawnSync("tmux", ["split-window", "-h", "-d", "-l", "30%", "-t", windowId ?? target, splitCmd], { stdio: "ignore" });
			}

			return windowId ? { ...status, tmuxWindowId: windowId } : status;
		},

		async kill(id: string): Promise<boolean> {
			const status = await this.find(id);
			if (!status) return false;
			killTmux(status.tmuxSession, status.tmuxWindowId);
			await this.patchStatus(status.id, { state: "ended" });
			return true;
		},

		async harvestPaneTail(id: string): Promise<PaneHarvestResult> {
			const status = await this.find(id);
			if (!status) return "not_found";
			if (status.paneCapturedAt) return "window_gone";
			const target = status.tmuxWindowId ?? status.tmuxSession;
			const probe = probeWorkerPane(target);
			if (probe.kind === "alive") return "alive";
			if (probe.kind === "dead") {
				const tail = capturePaneTail(probe.paneId, 200, { collapseBlankRuns: true });
				if (tail) {
					try {
						await fs.writeFile(path.join(workerDir(status.id), "pane-tail.txt"), `${tail}\n`, "utf8");
					} catch { /* capture is best-effort; still settle the window */ }
				}
				killTmux(status.tmuxSession, status.tmuxWindowId);
			}
			await this.updateStatus(status.id, paneHarvestedTransition(new Date().toISOString()));
			return probe.kind === "dead" ? "captured" : "window_gone";
		},

		async readPaneTail(id: string): Promise<string | undefined> {
			try {
				const text = await fs.readFile(path.join(workerDir(id), "pane-tail.txt"), "utf8");
				return text.trim() ? text : undefined;
			} catch {
				return undefined;
			}
		},

		async respawn(id: string): Promise<WorkerStatus | undefined> {
			ensureTmux();
			const status = await this.find(id);
			if (!status) return undefined;
			// remain-on-exit can leave the old dead window behind; clear it so the
			// relaunched window doesn't collide with a stale "wN".
			killTmux(status.tmuxSession, status.tmuxWindowId);
			const dir = workerDir(status.id);
			const sessionDir = path.join(dir, "session");
			const target = workerWindowTarget(status.index);
			const windowName = `w${status.index}`;
			const runToken = randomBytes(8).toString("hex");
			const starting = await this.updateStatus(status.id, respawnStartedTransition({ tmuxSession: target, runToken }));
			if (!starting.after) return undefined;
			const seeded = fsSync.existsSync(sessionDir) && fsSync.readdirSync(sessionDir).length > 0;
			const prompt = buildWorkerInitialPrompt({ index: status.index, id: status.id, dir, ...(status.worktree?.path ? { worktreePath: status.worktree.path } : {}), ...(status.kind ? { kind: status.kind } : {}) });
			const launchOverrides = [
				...(status.model ? ["--model", status.model] : []),
				...(status.thinking ? ["--thinking", status.thinking] : []),
			];
			const command = buildWorkerLaunchCommand({ id: status.id, sessionDir, statusFile: this.statusFile(status.id), initialPrompt: prompt, extensionArgs: [...explicitExtensionArgs(), ...launchOverrides], resumeSeeded: seeded, runToken, agentDir: getAgentDir() });
			const launch = launchSharedWindow({ windowName, cwd: status.cwd, command });
			if (!launch.ok) {
				await this.updateStatus(status.id, respawnFailedTransition(launch.error));
				throw new Error(launch.error);
			}
			const windowId = readWindowId(target);
			const launched = await this.updateStatus(status.id, (current) => current.state === "starting"
				? { ...(windowId ? { tmuxWindowId: windowId } : {}) }
				: undefined);
			return launched.after;
		},

		async purge(id: string): Promise<string[]> {
			const status = await this.find(id);
			if (!status) return [];
			killTmux(status.tmuxSession, status.tmuxWindowId);
			if (status.worktree) removeWorkerWorkspace(status.worktree);
			await fs.rm(workerDir(status.id), { recursive: true, force: true });
			return [status.id];
		},
	};
}

const DOCKET_INJECT_MARK = "[docket] ";
const DOCKET_PASTE_BUFFER = "docket-tell";

/** True when the payload spans more than one line and needs the paste-buffer path. */
export function isMultilineInput(text: string): boolean {
	return /\r?\n/.test(text.trim());
}

/** Collapse a one-liner's whitespace so stray tabs/newlines never break send-keys. */
export function sanitizeSingleLineInput(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Normalize a multiline payload: CRLF → LF, trim trailing space per line, drop edge blanks. */
export function normalizeMultilineInput(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, "");
}

function sendKeysToWindow(target: string, text: string, windowId?: string, multiline = false): boolean {
	if (!target) return false;
	const sendTarget = windowId ?? target;
	const shared = isSharedSessionTarget(target) || Boolean(windowId);
	const literal = shared ? `${DOCKET_INJECT_MARK}${text}` : text;
	// Multiline payloads go through a tmux buffer + bracketed paste so the worker's input
	// reader receives the whole block at once instead of executing on the first newline.
	if (multiline) return pasteToWindow(sendTarget, target, literal, Boolean(windowId));
	const literalResult = shared
		? spawnSync("tmux", ["send-keys", "-t", sendTarget, "-l", literal], { stdio: "ignore" })
		: spawnSync("tmux", ["send-keys", "-t", sendTarget, literal], { stdio: "ignore" });
	if (literalResult.status !== 0) {
		if (windowId) {
			// Fall back to name target if id resolution failed (e.g. window was renamed and id stale).
			const retry = spawnSync("tmux", ["send-keys", "-t", target, "-l", literal], { stdio: "ignore" });
			if (retry.status !== 0) return false;
		} else {
			return false;
		}
	}
	const enterResult = spawnSync("tmux", ["send-keys", "-t", sendTarget, "Enter"], { stdio: "ignore" });
	if (enterResult.status !== 0 && windowId) {
		const retry = spawnSync("tmux", ["send-keys", "-t", target, "Enter"], { stdio: "ignore" });
		return retry.status === 0;
	}
	return enterResult.status === 0;
}

function pasteToWindow(sendTarget: string, fallbackTarget: string, payload: string, hasWindowId: boolean): boolean {
	// Load the payload into a named buffer via stdin (no shell quoting hazards), then paste it
	// with -p (bracketed) and -d (delete the buffer afterwards). Enter submits the block.
	const load = spawnSync("tmux", ["load-buffer", "-b", DOCKET_PASTE_BUFFER, "-"], { input: payload, stdio: ["pipe", "ignore", "ignore"] });
	if (load.status !== 0) return false;
	const pasteArgs = (t: string) => ["paste-buffer", "-d", "-p", "-b", DOCKET_PASTE_BUFFER, "-t", t];
	let paste = spawnSync("tmux", pasteArgs(sendTarget), { stdio: "ignore" });
	if (paste.status !== 0 && hasWindowId) paste = spawnSync("tmux", pasteArgs(fallbackTarget), { stdio: "ignore" });
	if (paste.status !== 0) {
		spawnSync("tmux", ["delete-buffer", "-b", DOCKET_PASTE_BUFFER], { stdio: "ignore" });
		return false;
	}
	const enterResult = spawnSync("tmux", ["send-keys", "-t", sendTarget, "Enter"], { stdio: "ignore" });
	if (enterResult.status !== 0 && hasWindowId) {
		const retry = spawnSync("tmux", ["send-keys", "-t", fallbackTarget, "Enter"], { stdio: "ignore" });
		return retry.status === 0;
	}
	return enterResult.status === 0;
}

function launchSharedWindow(input: { windowName: string; cwd: string; command: string }): { ok: true } | { ok: false; error: string } {
	// remain-on-exit keeps the dead pane (and its scrollback) around after the worker
	// process exits, so the parent can capture a post-mortem tail before killing the
	// window. The harvest sweep in the dock is responsible for the eventual kill.
	const target = `${SHARED_TMUX_SESSION}:${input.windowName}`;
	if (!tmuxSessionExists(SHARED_TMUX_SESSION)) {
		const created = spawnSync("tmux", ["new-session", "-d", "-s", SHARED_TMUX_SESSION, "-n", input.windowName, "-c", input.cwd, input.command], { encoding: "utf8" });
		if (created.error || created.status !== 0) {
			return { ok: false, error: created.stderr?.trim() || created.error?.message || "tmux new-session failed" };
		}
		spawnSync("tmux", ["set-option", "-t", SHARED_TMUX_SESSION, "remain-on-exit", "on"], { stdio: "ignore" });
		return { ok: true };
	}
	const added = spawnSync("tmux", ["new-window", "-d", "-t", `${SHARED_TMUX_SESSION}:`, "-n", input.windowName, "-c", input.cwd, input.command], { encoding: "utf8" });
	if (added.error || added.status !== 0) {
		return { ok: false, error: added.stderr?.trim() || added.error?.message || "tmux new-window failed" };
	}
	// Window-level set covers sessions created by older versions that set the session option to off.
	spawnSync("tmux", ["set-option", "-w", "-t", target, "remain-on-exit", "on"], { stdio: "ignore" });
	return { ok: true };
}

type PaneProbe = { kind: "window_gone" } | { kind: "alive" } | { kind: "dead"; paneId: string };

/**
 * Probe per pane, not per window: split layouts (e.g. split-events) keep a live
 * helper pane next to the worker pane, so the window-level flag would lie.
 */
function probeWorkerPane(target: string): PaneProbe {
	const result = spawnSync("tmux", ["list-panes", "-t", target, "-F", "#{pane_id} #{pane_dead}"], { encoding: "utf8" });
	if (result.error || result.status !== 0) return { kind: "window_gone" };
	const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
	if (lines.length === 0) return { kind: "window_gone" };
	for (const line of lines) {
		const [paneId, dead] = line.split(" ");
		if (dead === "1" && paneId?.startsWith("%")) return { kind: "dead", paneId };
	}
	return { kind: "alive" };
}

function capturePaneTail(target: string, lines = 200, options: { collapseBlankRuns?: boolean } = {}): string | undefined {
	const result = spawnSync("tmux", ["capture-pane", "-p", "-S", `-${lines}`, "-t", target], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
	if (result.error || result.status !== 0) return undefined;
	// Dead panes pad the viewport with empty rows before tmux's "Pane is dead" line;
	// collapse those for stored post-mortems but keep live peeks screen-faithful.
	const cleaned = options.collapseBlankRuns ? result.stdout.replace(/\n{3,}/g, "\n\n") : result.stdout;
	const text = cleaned.replace(/\s+$/, "");
	return text.trim() ? text : undefined;
}
