import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { createEventLog, type EventLog, replayEvents } from "./event-log.js";
import type { Artifact, CheckpointIndexEntry, CheckpointMode } from "./types.js";

type CheckpointSaveInput = {
	id: string;
	mode: CheckpointMode;
	markdown: string;
	artifacts: Artifact[];
	cwd: string;
	sourceSession?: string;
	note?: string;
	consumeOnUse?: boolean;
};

export type CheckpointSummary = {
	entry: CheckpointIndexEntry;
	artifactCount: number;
	files: number;
	errors: number;
	commands: number;
	estimatedTokens: number;
};

type ListOptions = { includeConsumed?: boolean };

export type CheckpointStore = {
	save(input: CheckpointSaveInput): Promise<CheckpointIndexEntry>;
	find(idOrLast: string, options?: ListOptions): Promise<CheckpointIndexEntry | undefined>;
	list(options?: ListOptions): Promise<CheckpointIndexEntry[]>;
	listSummaries(options?: ListOptions): Promise<CheckpointSummary[]>;
	readMarkdown(checkpoint: CheckpointIndexEntry): Promise<string>;
	readArtifacts(checkpoint: CheckpointIndexEntry): Promise<Artifact[]>;
	markConsumed(checkpoint: CheckpointIndexEntry, timestamp?: string): Promise<void>;
	purge(checkpoint: CheckpointIndexEntry): Promise<void>;
	sweepConsumed(retentionDays: number): Promise<number>;
	artifactsFile(id: string): string;
};

function checkpointDir(): string {
	return path.join(getAgentDir(), "trail", "checkpoints");
}

function checkpointIndexFile(): string {
	return path.join(getAgentDir(), "trail", "index.json");
}

function checkpointMarkdownFile(id: string): string {
	return path.join(checkpointDir(), `${id}.md`);
}

function checkpointArtifactsFile(id: string): string {
	return path.join(checkpointDir(), `${id}.artifacts.json`);
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

async function fileExists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
	const tempFile = path.join(path.dirname(file), `.${path.basename(file)}.${suffix}.tmp`);
	try {
		await fs.writeFile(tempFile, content, "utf8");
		await fs.rename(tempFile, file);
	} catch (err) {
		await fs.rm(tempFile, { force: true });
		throw err;
	}
}

async function loadLegacyIndex(): Promise<CheckpointIndexEntry[]> {
	return readJsonFile<CheckpointIndexEntry[]>(checkpointIndexFile(), []);
}

async function writeIndexSnapshot(entries: CheckpointIndexEntry[]): Promise<void> {
	await writeFileAtomic(checkpointIndexFile(), `${JSON.stringify(entries, null, 2)}\n`);
}

async function existingMarkdownEntries(entries: CheckpointIndexEntry[]): Promise<CheckpointIndexEntry[]> {
	const checks = await Promise.all(entries.map((entry) => fileExists(entry.file)));
	return entries.filter((_, index) => checks[index]);
}

async function checkpointArtifacts(id: string): Promise<Artifact[]> {
	return readJsonFile<Artifact[]>(checkpointArtifactsFile(id), []);
}

async function checkpointSummary(entry: CheckpointIndexEntry): Promise<CheckpointSummary> {
	const [markdown, artifacts] = await Promise.all([
		fs.readFile(entry.file, "utf8").catch(() => ""),
		checkpointArtifacts(entry.id),
	]);
	const fileNames = new Set(artifacts.filter((artifact) => artifact.kind === "file").map((artifact) => artifact.title));
	return {
		entry,
		artifactCount: artifacts.length,
		files: fileNames.size,
		errors: artifacts.filter((artifact) => artifact.kind === "error").length,
		commands: artifacts.filter((artifact) => artifact.kind === "command").length,
		estimatedTokens: Math.ceil(markdown.length / 4),
	};
}

function applyConsumedFilter(entries: CheckpointIndexEntry[], options?: ListOptions): CheckpointIndexEntry[] {
	if (options?.includeConsumed) return entries;
	return entries.filter((entry) => !entry.consumedAt);
}

async function loadIndexFromEvents(log: EventLog): Promise<CheckpointIndexEntry[]> {
	const events = await log.read();
	if (events.length > 0) return replayEvents(events);
	const legacy = await loadLegacyIndex();
	if (legacy.length > 0) {
		await log.backfillFromIndex(legacy);
		return replayEvents(await log.read());
	}
	return [];
}

export function createCheckpointStore(): CheckpointStore {
	const log = createEventLog();
	return {
		async save(input: CheckpointSaveInput): Promise<CheckpointIndexEntry> {
			const file = checkpointMarkdownFile(input.id);
			await writeFileAtomic(file, `${input.markdown.trim()}\n`);
			await writeFileAtomic(checkpointArtifactsFile(input.id), `${JSON.stringify(input.artifacts, null, 2)}\n`);

			const entry: CheckpointIndexEntry = {
				id: input.id,
				mode: input.mode,
				file,
				createdAt: new Date().toISOString(),
				cwd: input.cwd,
				sourceSession: input.sourceSession,
				note: input.note,
				consumeOnUse: input.consumeOnUse,
			};
			await log.append({ type: "checkpoint_saved", timestamp: entry.createdAt, entry });
			await writeIndexSnapshot(await loadIndexFromEvents(log));
			return entry;
		},

		async find(idOrLast: string, options?: ListOptions): Promise<CheckpointIndexEntry | undefined> {
			const index = await this.list(options);
			if (index.length === 0) return undefined;
			if (!idOrLast || idOrLast === "last") return index[index.length - 1];
			return [...index].reverse().find((entry) => entry.id === idOrLast || entry.id.startsWith(idOrLast));
		},

		async list(options?: ListOptions): Promise<CheckpointIndexEntry[]> {
			const present = await existingMarkdownEntries(await loadIndexFromEvents(log));
			return applyConsumedFilter(present, options);
		},

		async listSummaries(options?: ListOptions): Promise<CheckpointSummary[]> {
			return Promise.all((await this.list(options)).map((entry) => checkpointSummary(entry)));
		},

		async readMarkdown(checkpoint: CheckpointIndexEntry): Promise<string> {
			return fs.readFile(checkpoint.file, "utf8");
		},

		async readArtifacts(checkpoint: CheckpointIndexEntry): Promise<Artifact[]> {
			return checkpointArtifacts(checkpoint.id);
		},

		async markConsumed(checkpoint: CheckpointIndexEntry, timestamp?: string): Promise<void> {
			const stamp = timestamp ?? new Date().toISOString();
			const current = await loadIndexFromEvents(log);
			const known = current.find((entry) => entry.id === checkpoint.id);
			if (!known || known.consumedAt) return;
			await log.append({ type: "checkpoint_consumed", timestamp: stamp, id: checkpoint.id, consumedAt: stamp });
			await writeIndexSnapshot(await loadIndexFromEvents(log));
		},

		async purge(checkpoint: CheckpointIndexEntry): Promise<void> {
			await log.append({ type: "checkpoint_purged", timestamp: new Date().toISOString(), id: checkpoint.id });
			await writeIndexSnapshot(await loadIndexFromEvents(log));
			await fs.rm(checkpoint.file, { force: true });
			await fs.rm(checkpointArtifactsFile(checkpoint.id), { force: true });
		},

		async sweepConsumed(retentionDays: number): Promise<number> {
			if (!Number.isFinite(retentionDays) || retentionDays < 0) return 0;
			const current = await loadIndexFromEvents(log);
			const cutoff = Date.now() - retentionDays * 86400000;
			const expired: CheckpointIndexEntry[] = [];
			for (const entry of current) {
				const consumed = entry.consumedAt ? Date.parse(entry.consumedAt) : NaN;
				if (Number.isFinite(consumed) && consumed <= cutoff) expired.push(entry);
			}
			if (expired.length === 0) return 0;
			await log.append({
				type: "checkpoint_swept",
				timestamp: new Date().toISOString(),
				ids: expired.map((entry) => entry.id),
				retentionDays,
			});
			await writeIndexSnapshot(await loadIndexFromEvents(log));
			await Promise.all(expired.flatMap((entry) => [
				fs.rm(entry.file, { force: true }),
				fs.rm(checkpointArtifactsFile(entry.id), { force: true }),
			]));
			return expired.length;
		},

		artifactsFile(id: string): string {
			return checkpointArtifactsFile(id);
		},
	};
}
