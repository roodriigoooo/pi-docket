import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Artifact, ArtifactKind } from "./types.js";

export type ArtifactSearchDocument = {
	id: string;
	artifact: Artifact;
	title: string;
	body: string;
	rankText: {
		primary: string;
		body: string;
		metadata: string;
	};
	content: string;
};

export type RipgrepAdapter = (query: string, documents: ArtifactSearchDocument[]) => Promise<Set<string>>;

export type ArtifactSearchOptions = {
	runRipgrep?: RipgrepAdapter;
};

const KIND_WEIGHT: Record<ArtifactKind, number> = {
	error: 700,
	file: 600,
	command: 500,
	code: 400,
	checkpoint: 300,
	prompt: 200,
	response: 100,
};

function includes(text: string, query: string): boolean {
	return text.toLowerCase().includes(query);
}

function formatSearchDocument(artifact: Artifact, metadata: string): string {
	return [
		`# Trail artifact ${artifact.displayId}`,
		`ref: ${artifact.ref}`,
		`kind: ${artifact.kind}`,
		artifact.entryId ? `entry: ${artifact.entryId}` : undefined,
		artifact.title ? `title: ${artifact.title}` : undefined,
		artifact.subtitle ? `subtitle: ${artifact.subtitle}` : undefined,
		"",
		artifact.title,
		"",
		artifact.body,
		"",
		"metadata:",
		metadata,
	].filter((line): line is string => line !== undefined).join("\n");
}

export function buildArtifactSearchDocument(artifact: Artifact): ArtifactSearchDocument {
	const metadata = JSON.stringify(artifact.meta ?? {}, null, 2);
	const primary = [artifact.displayId, artifact.ref, artifact.kind, artifact.title, artifact.subtitle].filter(Boolean).join("\n");
	return {
		id: artifact.displayId,
		artifact,
		title: artifact.title,
		body: artifact.body,
		rankText: { primary, body: artifact.body, metadata },
		content: formatSearchDocument(artifact, metadata),
	};
}

async function runCommand(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => (stdout += data.toString("utf8")));
		child.stderr.on("data", (data) => (stderr += data.toString("utf8")));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end();
	});
}

function safeFileName(index: number, document: ArtifactSearchDocument): string {
	const id = document.artifact.displayId.replace(/[^a-zA-Z0-9._-]/g, "_") || "artifact";
	return `${index}-${id}.md`;
}

async function runRipgrepAdapter(query: string, documents: ArtifactSearchDocument[]): Promise<Set<string>> {
	const tempDir = await fs.mkdtemp(path.join(tmpdir(), "pi-trail-search-"));
	try {
		const byFile = new Map<string, string>();
		for (let i = 0; i < documents.length; i++) {
			const document = documents[i]!;
			const fileName = safeFileName(i, document);
			byFile.set(fileName, document.id);
			await fs.writeFile(path.join(tempDir, fileName), document.content, "utf8");
		}

		const result = await runCommand("rg", ["--files-with-matches", "--fixed-strings", "--ignore-case", "-e", query, tempDir]);
		if (result.code === 0) {
			return new Set(result.stdout.split("\n").map((line) => byFile.get(path.basename(line))).filter((id): id is string => Boolean(id)));
		}
		if (result.code === 1) return new Set();
		throw new Error(result.stderr || `rg exited ${result.code}`);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

function scoreDocument(query: string, document: ArtifactSearchDocument): number {
	const primary = includes(document.rankText.primary, query);
	const body = includes(document.rankText.body, query);
	const metadata = includes(document.rankText.metadata, query);
	if (!primary && !body && !metadata) return 0;
	return KIND_WEIGHT[document.artifact.kind] + (primary ? 50 : 0) + (body ? 20 : 0) + (metadata ? 10 : 0);
}

function rankDocuments(query: string, documents: ArtifactSearchDocument[]): Artifact[] {
	return documents
		.map((document, index) => ({ document, index, score: scoreDocument(query, document) }))
		.filter((result) => result.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((result) => result.document.artifact);
}

export async function searchArtifacts(query: string, artifacts: Artifact[], options: ArtifactSearchOptions = {}): Promise<Artifact[]> {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];

	const documents = artifacts.map(buildArtifactSearchDocument);
	const runRipgrep = options.runRipgrep ?? runRipgrepAdapter;
	try {
		const ids = await runRipgrep(query, documents);
		const matches = documents.filter((document) => ids.has(document.id));
		return rankDocuments(needle, matches);
	} catch {
		return rankDocuments(needle, documents);
	}
}
