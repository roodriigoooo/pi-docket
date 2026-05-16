import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { appendWorkerQuestionPatch, buildWorkerInitialPrompt as buildBackgroundWorkerInitialPrompt, workerInputAcceptedPatch, workerShortLabel, type WorkerQuestion, type WorkerStatus } from "./background-work.js";
import type { Artifact } from "./types.js";

export { workerShortLabel, workerSummaryName, type WorkerQuestion, type WorkerState, type WorkerStatus } from "./background-work.js";

export const WORKER_TMUX_PREFIX = "trail-worker-";
export const TRAIL_WORKER_ENV = "TRAIL_WORKER_ID";
export const WORKER_DASHBOARD_TMUX = "trail-workers";

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
	parentSession?: string;
	extensionArgs?: string[];
	idHint?: string;
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

function tmuxSessionName(id: string): string {
	return `${WORKER_TMUX_PREFIX}${id}`.slice(0, 100);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function ensureTmux(): void {
	const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
	if (result.error || result.status !== 0) throw new Error("tmux not found. Install tmux and try again.");
}

function tmuxSessionExists(name: string): boolean {
	return spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" }).status === 0;
}

function killTmux(name: string): boolean {
	if (!tmuxSessionExists(name)) return false;
	const result = spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
	return result.status === 0;
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

function makeWorkerId(task: string, hint?: string): string {
	const base = hint ?? task.split(/\s+/).slice(0, 4).join("-");
	const slug = tmuxSafeId(base);
	const suffix = randomBytes(2).toString("hex");
	return `${slug}-${suffix}`.slice(0, 80);
}

export function buildWorkerInitialPrompt(input: { index: number; id: string; dir: string }): string {
	return buildBackgroundWorkerInitialPrompt({
		label: workerShortLabel(input.index),
		id: input.id,
		taskFile: path.join(input.dir, "task.md"),
		artifactsFile: path.join(input.dir, "artifacts.json"),
	});
}

export function explicitExtensionArgs(): string[] {
	const out: string[] = [];
	for (let i = 0; i < process.argv.length; i++) {
		const arg = process.argv[i] ?? "";
		if ((arg === "-e" || arg === "--extension") && process.argv[i + 1]) {
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
			const result = spawnSync("tmux", ["send-keys", "-t", status.tmuxSession, safeText, "Enter"], { stdio: "ignore" });
			if (result.status !== 0) return false;
			await this.patchStatus(status.id, workerInputAcceptedPatch());
			return true;
		},

		async spawn(input: SpawnInput): Promise<WorkerStatus> {
			ensureTmux();
			const id = makeWorkerId(input.task, input.idHint);
			const dir = workerDir(id);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, "task.md"), `${input.task.trim()}\n`, "utf8");

			const tmuxName = tmuxSessionName(id);
			if (tmuxSessionExists(tmuxName)) throw new Error(`tmux session ${tmuxName} already exists`);

			const sessionDir = path.join(dir, "session");
			await fs.mkdir(sessionDir, { recursive: true });

			const existing = await this.list();
			const index = existing.reduce((max, entry) => Math.max(max, entry.index ?? 0), 0) + 1;

			const initialPrompt = buildWorkerInitialPrompt({ index, id, dir });

			const extensionArgs = input.extensionArgs ?? explicitExtensionArgs();
			const piParts = ["exec env", `${TRAIL_WORKER_ENV}=${shellQuote(id)}`, "pi", "--session-dir", shellQuote(sessionDir)];
			for (const arg of extensionArgs) piParts.push(shellQuote(arg));
			piParts.push(shellQuote(initialPrompt));

			const command = piParts.join(" ");
			const result = spawnSync("tmux", ["new-session", "-d", "-s", tmuxName, "-c", input.cwd, command], { encoding: "utf8" });
			if (result.error || result.status !== 0) {
				throw new Error(result.stderr.trim() || result.error?.message || `tmux failed for ${id}`);
			}

			const now = new Date().toISOString();
			const status: WorkerStatus = {
				id,
				index,
				tmuxSession: tmuxName,
				task: input.task,
				cwd: input.cwd,
				createdAt: now,
				updatedAt: now,
				state: "starting",
			};
			await this.writeStatus(status);
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
			await fs.rm(workerDir(status.id), { recursive: true, force: true });
		},
	};
}
