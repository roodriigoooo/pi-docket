import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir, SessionManager } from "@mariozechner/pi-coding-agent";
import { appendWorkerQuestionPatch, buildWorkerInitialPrompt as buildBackgroundWorkerInitialPrompt, workerInputAcceptedPatch, workerShortLabel, type WorkerQuestion, type WorkerStatus } from "./background-work.js";
import type { Artifact, GitSnapshot } from "./types.js";

export { workerShortLabel, workerSummaryName, type WorkerQuestion, type WorkerState, type WorkerStatus } from "./background-work.js";

export const WORKER_TMUX_PREFIX = "trail-worker-";
export const TRAIL_WORKER_ENV = "TRAIL_WORKER_ID";
export const WORKER_DASHBOARD_TMUX = "trail-workers";
/** Single tmux session that hosts every worker window. */
export const SHARED_TMUX_SESSION = "trail-workers";

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
	list(): Promise<WorkerStatus[]>;
	find(id: string): Promise<WorkerStatus | undefined>;
	readArtifacts(id: string): Promise<Artifact[]>;
	writeStatus(snapshot: WorkerStatus): Promise<void>;
	patchStatus(id: string, patch: Partial<WorkerStatus>): Promise<WorkerStatus | undefined>;
	writeArtifacts(id: string, artifacts: Artifact[]): Promise<void>;
	addQuestion(id: string, text: string): Promise<WorkerStatus | undefined>;
	sendInput(id: string, text: string): Promise<boolean>;
	spawn(input: SpawnInput): Promise<WorkerStatus>;
	kill(id: string): Promise<boolean>;
	purge(id: string): Promise<void>;
};

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
};

function workersRoot(): string {
	return path.join(getAgentDir(), "trail", "workers");
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
	`let status;`,
	`try { status = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }`,
	`if (!status || ["needs_input", "ready", "failed", "error", "ended"].includes(status.state)) process.exit(0);`,
	`const code = Number(rawCode);`,
	`status.updatedAt = new Date().toISOString();`,
	`if (code === 0) status.state = "ended";`,
	`else { status.state = "failed"; const label = Number.isFinite(code) ? String(code) : rawCode; status.lastError = "worker process exited before reporting ready (exit " + label + ")"; }`,
	`fs.writeFileSync(file, JSON.stringify(status, null, 2) + "\\n", "utf8");`,
].join("");

export function currentPiCommandParts(argv: string[] = process.argv, execPath = process.execPath): string[] {
	const script = argv[1];
	if (script && path.isAbsolute(script) && (path.basename(script) === "pi" || script.includes("pi-coding-agent"))) return [execPath, script];
	return ["pi"];
}

function workerExitPatchCommand(statusFile: string): string {
	return `${shellQuote(process.execPath)} -e ${shellQuote(WORKER_EXIT_PATCH_SCRIPT)} ${shellQuote(statusFile)} "$code"`;
}

export function buildWorkerLaunchCommand(input: { id: string; sessionDir: string; statusFile: string; initialPrompt: string; extensionArgs?: string[]; piCommandParts?: string[]; resumeSeeded?: boolean }): string {
	const piParts = [`${TRAIL_WORKER_ENV}=${shellQuote(input.id)}`, ...(input.piCommandParts ?? currentPiCommandParts()).map(shellQuote), "--session-dir", shellQuote(input.sessionDir)];
	if (input.resumeSeeded) piParts.push("--continue");
	for (const arg of input.extensionArgs ?? []) piParts.push(shellQuote(arg));
	piParts.push(shellQuote(input.initialPrompt));
	return `${piParts.join(" ")}; code=$?; ${workerExitPatchCommand(input.statusFile)}`;
}

function ensureTmux(): void {
	const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
	if (result.error || result.status !== 0) throw new Error("tmux not found. Install tmux and try again.");
}

function tmuxSessionExists(name: string): boolean {
	return spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" }).status === 0;
}

function killTmux(target: string): boolean {
	if (isSharedSessionTarget(target)) {
		if (!tmuxSessionExists(SHARED_TMUX_SESSION)) return false;
		const result = spawnSync("tmux", ["kill-window", "-t", target], { stdio: "ignore" });
		return result.status === 0;
	}
	if (!tmuxSessionExists(target)) return false;
	const result = spawnSync("tmux", ["kill-session", "-t", target], { stdio: "ignore" });
	return result.status === 0;
}

export function sharedSessionExists(): boolean {
	return tmuxSessionExists(SHARED_TMUX_SESSION);
}

function gitOutput(cwd: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): string | undefined {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", input: options.input, env: options.env ? { ...process.env, ...options.env } : undefined, maxBuffer: 20 * 1024 * 1024 });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim() || undefined;
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

function createBaselineCommit(worktreePath: string, parent: string | undefined): string | undefined {
	gitStatus(worktreePath, ["add", "-A"]);
	const changed = gitStatus(worktreePath, ["diff", "--cached", "--quiet", parent ?? "HEAD"]).status !== 0;
	if (!changed) return parent;
	const tree = gitOutput(worktreePath, ["write-tree"]);
	if (!tree) return parent;
	const commit = gitOutput(worktreePath, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "Trail worker baseline"], {
		env: {
			GIT_AUTHOR_NAME: "Trail",
			GIT_AUTHOR_EMAIL: "trail@example.invalid",
			GIT_COMMITTER_NAME: "Trail",
			GIT_COMMITTER_EMAIL: "trail@example.invalid",
		},
	});
	if (!commit) return parent;
	gitStatus(worktreePath, ["reset", "--hard", commit]);
	return commit;
}

export function createWorkerWorkspace(baseCwd: string, target: string): { path: string; baseCwd: string; baseRoot?: string; parentCwd?: string; baseHead?: string; snapshotHead?: string } | undefined {
	if (gitOutput(baseCwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") return undefined;
	const baseRoot = gitOutput(baseCwd, ["rev-parse", "--show-toplevel"]);
	const baseHead = gitOutput(baseCwd, ["rev-parse", "HEAD"]);
	const result = spawnSync("git", ["worktree", "add", "--detach", target, baseHead ?? "HEAD"], { cwd: baseCwd, encoding: "utf8" });
	if (result.error || result.status !== 0) throw new Error(result.stderr.trim() || result.error?.message || "git worktree add failed");
	try {
		const root = baseRoot ?? baseCwd;
		const dirtyPatch = gitRawOutput(root, ["diff", "--binary", "HEAD"]);
		if (dirtyPatch) {
			const applied = gitStatus(target, ["apply", "--binary", "--whitespace=nowarn"], { input: dirtyPatch });
			if (applied.status !== 0) throw new Error(applied.stderr || "git apply parent changes failed");
		}
		copyUntrackedFiles(root, target);
		const snapshotHead = createBaselineCommit(target, baseHead);
		return { path: target, baseCwd, baseRoot: root, parentCwd: baseCwd, ...(baseHead ? { baseHead } : {}), ...(snapshotHead ? { snapshotHead } : {}) };
	} catch (err) {
		removeGitWorktree({ path: target, baseCwd });
		throw err;
	}
}

function removeGitWorktree(worktree: { path: string; baseCwd: string }): void {
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

export function buildWorkerInitialPrompt(input: { index: number; id: string; dir: string; worktreePath?: string }): string {
	return buildBackgroundWorkerInitialPrompt({
		label: workerShortLabel(input.index),
		id: input.id,
		taskFile: path.join(input.dir, "task.md"),
		artifactsFile: path.join(input.dir, "artifacts.json"),
		worktreePath: input.worktreePath,
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

		async list(): Promise<WorkerStatus[]> {
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
			return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
			await writeJsonAtomic(this.statusFile(snapshot.id), { ...snapshot, updatedAt: new Date().toISOString() });
		},

		async patchStatus(id: string, patch: Partial<WorkerStatus>): Promise<WorkerStatus | undefined> {
			const current = await readJson<WorkerStatus | undefined>(this.statusFile(id), undefined);
			if (!current) return undefined;
			const next: WorkerStatus = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
			await writeJsonAtomic(this.statusFile(id), next);
			return next;
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
			const safeText = text.replace(/\s+/g, " ").trim();
			if (!safeText) return false;
			const ok = sendKeysToWindow(status.tmuxSession, safeText);
			if (!ok) return false;
			await this.patchStatus(status.id, workerInputAcceptedPatch());
			return true;
		},

		async spawn(input: SpawnInput): Promise<WorkerStatus> {
			ensureTmux();
			const id = makeWorkerId(input.task, input.idHint);
			const dir = workerDir(id);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, "task.md"), `${input.task.trim()}\n`, "utf8");

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

			const initialPrompt = buildWorkerInitialPrompt({ index, id, dir, worktreePath: worktree?.path });

			const now = new Date().toISOString();
			const status: WorkerStatus = {
				id,
				index,
				tmuxSession: target,
				task: input.task,
				cwd: workerCwd,
				git: input.git,
				worktree,
				createdAt: now,
				updatedAt: now,
				state: "starting",
			};
			await this.writeStatus(status);

			const command = buildWorkerLaunchCommand({ id, sessionDir, statusFile: this.statusFile(id), initialPrompt, extensionArgs: input.extensionArgs ?? explicitExtensionArgs(), resumeSeeded });
			const result = launchSharedWindow({ windowName, cwd: workerCwd, command });
			if (!result.ok) {
				if (worktree) removeGitWorktree(worktree);
				await fs.rm(dir, { recursive: true, force: true });
				throw new Error(result.error || `tmux failed for ${id}`);
			}

			return status;
		},

		async kill(id: string): Promise<boolean> {
			const status = await this.find(id);
			if (!status) return false;
			killTmux(status.tmuxSession);
			await this.patchStatus(status.id, { state: "ended" });
			return true;
		},

		async purge(id: string): Promise<void> {
			const status = await this.find(id);
			if (!status) return;
			killTmux(status.tmuxSession);
			if (status.worktree) removeGitWorktree(status.worktree);
			await fs.rm(workerDir(status.id), { recursive: true, force: true });
		},
	};
}

const TRAIL_INJECT_MARK = "[trail] ";

function sendKeysToWindow(target: string, text: string): boolean {
	if (!target) return false;
	const literal = isSharedSessionTarget(target) ? `${TRAIL_INJECT_MARK}${text}` : text;
	const literalResult = isSharedSessionTarget(target)
		? spawnSync("tmux", ["send-keys", "-t", target, "-l", literal], { stdio: "ignore" })
		: spawnSync("tmux", ["send-keys", "-t", target, literal], { stdio: "ignore" });
	if (literalResult.status !== 0) return false;
	const enterResult = spawnSync("tmux", ["send-keys", "-t", target, "Enter"], { stdio: "ignore" });
	return enterResult.status === 0;
}

function launchSharedWindow(input: { windowName: string; cwd: string; command: string }): { ok: true } | { ok: false; error: string } {
	if (!tmuxSessionExists(SHARED_TMUX_SESSION)) {
		const created = spawnSync("tmux", ["new-session", "-d", "-s", SHARED_TMUX_SESSION, "-n", input.windowName, "-c", input.cwd, input.command], { encoding: "utf8" });
		if (created.error || created.status !== 0) {
			return { ok: false, error: created.stderr?.trim() || created.error?.message || "tmux new-session failed" };
		}
		spawnSync("tmux", ["set-option", "-t", SHARED_TMUX_SESSION, "remain-on-exit", "off"], { stdio: "ignore" });
		return { ok: true };
	}
	const added = spawnSync("tmux", ["new-window", "-d", "-t", `${SHARED_TMUX_SESSION}:`, "-n", input.windowName, "-c", input.cwd, input.command], { encoding: "utf8" });
	if (added.error || added.status !== 0) {
		return { ok: false, error: added.stderr?.trim() || added.error?.message || "tmux new-window failed" };
	}
	return { ok: true };
}
