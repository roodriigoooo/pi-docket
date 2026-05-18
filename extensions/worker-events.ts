import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const WORKER_EVENT_FILE = "events.ndjson";
export const WORKER_EVENT_ROTATE_BYTES = 5 * 1024 * 1024;

export type WorkerEventKind = "state" | "todo" | "tool" | "artifact" | "message";

export type WorkerEvent = {
	ts: number;
	kind: WorkerEventKind;
	payload: Record<string, unknown>;
};

export function workerEventFilePath(root: string, id: string): string {
	return path.join(root, id, WORKER_EVENT_FILE);
}

function rotateIfNeeded(file: string): void {
	try {
		const stat = fsSync.statSync(file);
		if (stat.size > WORKER_EVENT_ROTATE_BYTES) {
			const rotated = `${file}.1`;
			try {
				fsSync.rmSync(rotated, { force: true });
			} catch {
				// best-effort
			}
			fsSync.renameSync(file, rotated);
		}
	} catch {
		// file may not exist yet
	}
}

export function appendWorkerEventSync(root: string, id: string, event: { kind: WorkerEventKind; payload: Record<string, unknown>; ts?: number }): void {
	const file = workerEventFilePath(root, id);
	try {
		fsSync.mkdirSync(path.dirname(file), { recursive: true });
		rotateIfNeeded(file);
		const payload: WorkerEvent = { ts: event.ts ?? Date.now(), kind: event.kind, payload: event.payload };
		fsSync.appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
	} catch {
		// best-effort: never crash the worker because of event logging
	}
}

export type WorkerEventTailerState = { offset: number };

export type TailResult = { events: WorkerEvent[]; rotated: boolean; offset: number };

export async function tailWorkerEvents(root: string, id: string, state: WorkerEventTailerState): Promise<TailResult> {
	const file = workerEventFilePath(root, id);
	let stat: fsSync.Stats;
	try {
		stat = await fs.stat(file);
	} catch {
		return { events: [], rotated: false, offset: state.offset };
	}
	let offset = state.offset;
	let rotated = false;
	if (stat.size < offset) {
		offset = 0;
		rotated = true;
	}
	if (stat.size === offset) return { events: [], rotated, offset };
	const handle = await fs.open(file, "r");
	try {
		const buf = Buffer.alloc(stat.size - offset);
		await handle.read(buf, 0, buf.length, offset);
		const chunk = buf.toString("utf8");
		const events: WorkerEvent[] = [];
		for (const line of chunk.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				events.push(JSON.parse(trimmed) as WorkerEvent);
			} catch {
				// drop malformed line
			}
		}
		return { events, rotated, offset: stat.size };
	} finally {
		await handle.close();
	}
}
