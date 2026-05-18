import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { Artifact } from "./types.js";
import type { WorkerStatus } from "./background-work.js";

type Entry = {
	id: string;
	statusMtime: number;
	artifactsMtime: number;
	status: WorkerStatus | undefined;
	artifacts: Artifact[];
};

export type WorkerSnapshot = { workers: WorkerStatus[]; artifactsByWorker: Map<string, Artifact[]> };

async function safeStat(file: string): Promise<fsSync.Stats | undefined> {
	try {
		return await fs.stat(file);
	} catch {
		return undefined;
	}
}

export class WorkerSnapshotCache {
	private entries = new Map<string, Entry>();

	constructor(private root: string) {}

	async snapshot(): Promise<WorkerSnapshot> {
		let names: string[];
		try {
			names = await fs.readdir(this.root);
		} catch {
			this.entries.clear();
			return { workers: [], artifactsByWorker: new Map() };
		}
		const active = new Set(names);
		for (const id of [...this.entries.keys()]) if (!active.has(id)) this.entries.delete(id);

		const workers: WorkerStatus[] = [];
		const artifactsByWorker = new Map<string, Artifact[]>();
		await Promise.all(names.map(async (id) => {
			const dir = path.join(this.root, id);
			const statusFile = path.join(dir, "status.json");
			const artifactsFile = path.join(dir, "artifacts.json");
			const [statusStat, artifactsStat] = await Promise.all([safeStat(statusFile), safeStat(artifactsFile)]);
			if (!statusStat) {
				this.entries.delete(id);
				return;
			}
			const existing = this.entries.get(id);
			const entry: Entry = existing ?? { id, statusMtime: -1, artifactsMtime: -1, status: undefined, artifacts: [] };
			if (entry.statusMtime !== statusStat.mtimeMs) {
				try {
					entry.status = JSON.parse(await fs.readFile(statusFile, "utf8")) as WorkerStatus;
				} catch {
					entry.status = undefined;
				}
				entry.statusMtime = statusStat.mtimeMs;
			}
			if (artifactsStat) {
				if (entry.artifactsMtime !== artifactsStat.mtimeMs) {
					try {
						entry.artifacts = JSON.parse(await fs.readFile(artifactsFile, "utf8")) as Artifact[];
					} catch {
						entry.artifacts = [];
					}
					entry.artifactsMtime = artifactsStat.mtimeMs;
				}
			} else {
				entry.artifacts = [];
				entry.artifactsMtime = -1;
			}
			this.entries.set(id, entry);
			if (entry.status) {
				workers.push(entry.status);
				artifactsByWorker.set(entry.status.id, entry.artifacts);
			}
		}));
		workers.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		return { workers, artifactsByWorker };
	}

	invalidate(id?: string): void {
		if (id) this.entries.delete(id);
		else this.entries.clear();
	}

	size(): number {
		return this.entries.size;
	}
}

export type Unwatcher = () => void;

export function watchWorkersRoot(
	root: string,
	onChange: () => void,
	options: { fallbackMs?: number; debounceMs?: number } = {},
): Unwatcher {
	const debounceMs = options.debounceMs ?? 150;
	const fallbackMs = options.fallbackMs ?? 3000;
	let timer: NodeJS.Timeout | undefined;
	const fire = (): void => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => onChange(), debounceMs);
		timer.unref?.();
	};
	let watcher: fsSync.FSWatcher | undefined;
	try {
		fsSync.mkdirSync(root, { recursive: true });
		watcher = fsSync.watch(root, { recursive: true }, () => fire());
	} catch {
		// fall back to polling-only
	}
	const fallback = setInterval(fire, fallbackMs);
	fallback.unref?.();
	fire();
	return () => {
		watcher?.close();
		clearInterval(fallback);
		if (timer) clearTimeout(timer);
	};
}
