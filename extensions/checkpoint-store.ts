import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
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

export type CheckpointStore = {
	save(input: CheckpointSaveInput): Promise<CheckpointIndexEntry>;
	find(idOrLast: string): Promise<CheckpointIndexEntry | undefined>;
	list(): Promise<CheckpointIndexEntry[]>;
	listSummaries(): Promise<CheckpointSummary[]>;
	readMarkdown(checkpoint: CheckpointIndexEntry): Promise<string>;
	consume(checkpoint: CheckpointIndexEntry): Promise<void>;
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

async function loadCheckpointIndex(): Promise<CheckpointIndexEntry[]> {
	return readJsonFile<CheckpointIndexEntry[]>(checkpointIndexFile(), []);
}

async function saveCheckpointIndex(entries: CheckpointIndexEntry[]): Promise<void> {
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

export function createCheckpointStore(): CheckpointStore {
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
			const index = await loadCheckpointIndex();
			index.push(entry);
			await saveCheckpointIndex(index);
			return entry;
		},

		async find(idOrLast: string): Promise<CheckpointIndexEntry | undefined> {
			const index = await this.list();
			if (index.length === 0) return undefined;
			if (!idOrLast || idOrLast === "last") return index[index.length - 1];
			return [...index].reverse().find((entry) => entry.id === idOrLast || entry.id.startsWith(idOrLast));
		},

		async list(): Promise<CheckpointIndexEntry[]> {
			return existingMarkdownEntries(await loadCheckpointIndex());
		},

		async listSummaries(): Promise<CheckpointSummary[]> {
			return Promise.all((await this.list()).map((entry) => checkpointSummary(entry)));
		},

		async readMarkdown(checkpoint: CheckpointIndexEntry): Promise<string> {
			return fs.readFile(checkpoint.file, "utf8");
		},

		async consume(checkpoint: CheckpointIndexEntry): Promise<void> {
			const index = await loadCheckpointIndex();
			await saveCheckpointIndex(index.filter((entry) => entry.id !== checkpoint.id));
			await fs.rm(checkpoint.file, { force: true });
			await fs.rm(checkpointArtifactsFile(checkpoint.id), { force: true });
		},

		artifactsFile(id: string): string {
			return checkpointArtifactsFile(id);
		},
	};
}
