import type { Artifact } from "./types.js";
import { workerSourceLabel, type WorkerStatus } from "./background-work.js";

export type WorkerFileConflict = {
	workerId: string;
	workerLabel: string;
	files: string[];
};

function metaArgs(artifact: Artifact): Record<string, unknown> {
	const args = artifact.meta?.args;
	return args && typeof args === "object" ? args as Record<string, unknown> : {};
}

function normalizeFilePath(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
}

function filePathFromTitle(title: string): string | undefined {
	const match = title.match(/^(?:edit|write)\s+(.+)$/);
	return normalizeFilePath(match?.[1]);
}

function editedFileFromArtifact(artifact: Artifact): string | undefined {
	if (artifact.kind !== "file") return undefined;
	const tool = artifact.meta?.tool;
	if (tool !== "edit" && tool !== "write") return undefined;
	const args = metaArgs(artifact);
	const raw = typeof args.path === "string"
		? args.path
		: typeof args.file === "string"
			? args.file
			: undefined;
	return normalizeFilePath(raw) ?? filePathFromTitle(artifact.title);
}

function changedFilesFromArtifact(artifact: Artifact): string[] {
	const changed = artifact.meta?.changedFiles;
	if (!Array.isArray(changed)) return [];
	return changed
		.map((entry) => entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string" ? normalizeFilePath((entry as { path: string }).path) : undefined)
		.filter((file): file is string => file !== undefined);
}

export function workerEditedFiles(artifacts: Artifact[]): string[] {
	const files = new Set<string>();
	for (const artifact of artifacts) {
		const edited = editedFileFromArtifact(artifact);
		if (edited) files.add(edited);
		for (const changed of changedFilesFromArtifact(artifact)) files.add(changed);
	}
	return [...files].sort();
}

export function workerConflictMap(workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]>): Map<string, WorkerFileConflict[]> {
	const filesByWorker = new Map<string, Set<string>>();
	const workersByFile = new Map<string, WorkerStatus[]>();
	for (const worker of workers) {
		const files = new Set(workerEditedFiles(artifactsByWorker.get(worker.id) ?? []));
		filesByWorker.set(worker.id, files);
		for (const file of files) workersByFile.set(file, [...(workersByFile.get(file) ?? []), worker]);
	}

	const out = new Map<string, WorkerFileConflict[]>();
	for (const worker of workers) {
		const conflictsByWorker = new Map<string, { worker: WorkerStatus; files: string[] }>();
		for (const file of filesByWorker.get(worker.id) ?? []) {
			const peers = workersByFile.get(file) ?? [];
			for (const peer of peers) {
				if (peer.id === worker.id) continue;
				const entry = conflictsByWorker.get(peer.id) ?? { worker: peer, files: [] };
				entry.files.push(file);
				conflictsByWorker.set(peer.id, entry);
			}
		}
		const conflicts = [...conflictsByWorker.values()]
			.map((entry) => ({ workerId: entry.worker.id, workerLabel: workerSourceLabel(entry.worker), files: [...new Set(entry.files)].sort() }))
			.sort((a, b) => a.workerLabel.localeCompare(b.workerLabel));
		if (conflicts.length > 0) out.set(worker.id, conflicts);
	}
	return out;
}

export function conflictSummary(conflicts: WorkerFileConflict[], maxFiles = 2): string | undefined {
	if (conflicts.length === 0) return undefined;
	const first = conflicts[0]!;
	const files = first.files.slice(0, maxFiles).join(", ");
	const moreFiles = first.files.length > maxFiles ? ` +${first.files.length - maxFiles}` : "";
	const moreWorkers = conflicts.length > 1 ? ` +${conflicts.length - 1} worker${conflicts.length === 2 ? "" : "s"}` : "";
	return `overlap ${first.workerLabel}${files ? `: ${files}${moreFiles}` : ""}${moreWorkers}`;
}
