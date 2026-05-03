import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { CheckpointIndexEntry } from "./types.js";

export type CheckpointEvent =
	| { type: "checkpoint_saved"; timestamp: string; entry: CheckpointIndexEntry }
	| { type: "checkpoint_consumed"; timestamp: string; id: string; consumedAt: string }
	| { type: "checkpoint_unconsumed"; timestamp: string; id: string }
	| { type: "checkpoint_purged"; timestamp: string; id: string }
	| { type: "checkpoint_swept"; timestamp: string; ids: string[]; retentionDays: number };

export type EventLog = {
	append(event: CheckpointEvent): Promise<void>;
	read(): Promise<CheckpointEvent[]>;
	rebuildIndex(): Promise<CheckpointIndexEntry[]>;
	backfillFromIndex(entries: CheckpointIndexEntry[]): Promise<void>;
	path(): string;
};

function eventLogFile(): string {
	return path.join(getAgentDir(), "trail", "events.ndjson");
}

async function ensureParent(file: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
}

async function fileExists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

function applyEvent(state: Map<string, CheckpointIndexEntry>, event: CheckpointEvent): void {
	if (event.type === "checkpoint_saved") {
		state.set(event.entry.id, { ...event.entry });
		return;
	}
	if (event.type === "checkpoint_consumed") {
		const entry = state.get(event.id);
		if (entry && !entry.consumedAt) state.set(event.id, { ...entry, consumedAt: event.consumedAt });
		return;
	}
	if (event.type === "checkpoint_unconsumed") {
		const entry = state.get(event.id);
		if (entry?.consumedAt) {
			const { consumedAt: _drop, ...rest } = entry;
			state.set(event.id, rest);
		}
		return;
	}
	if (event.type === "checkpoint_purged") {
		state.delete(event.id);
		return;
	}
	if (event.type === "checkpoint_swept") {
		for (const id of event.ids) state.delete(id);
		return;
	}
}

export function replayEvents(events: CheckpointEvent[]): CheckpointIndexEntry[] {
	const state = new Map<string, CheckpointIndexEntry>();
	for (const event of events) applyEvent(state, event);
	return [...state.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function parseLine(line: string): CheckpointEvent | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as Partial<CheckpointEvent> & { type?: string };
		if (typeof parsed.type !== "string") return undefined;
		return parsed as CheckpointEvent;
	} catch {
		return undefined;
	}
}

export function createEventLog(): EventLog {
	const file = eventLogFile();
	return {
		path() {
			return file;
		},
		async append(event: CheckpointEvent): Promise<void> {
			await ensureParent(file);
			await fs.appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
		},
		async read(): Promise<CheckpointEvent[]> {
			if (!(await fileExists(file))) return [];
			const raw = await fs.readFile(file, "utf8");
			const events: CheckpointEvent[] = [];
			for (const line of raw.split("\n")) {
				const event = parseLine(line);
				if (event) events.push(event);
			}
			return events;
		},
		async rebuildIndex(): Promise<CheckpointIndexEntry[]> {
			return replayEvents(await this.read());
		},
		async backfillFromIndex(entries: CheckpointIndexEntry[]): Promise<void> {
			if (entries.length === 0) return;
			if (await fileExists(file)) return;
			await ensureParent(file);
			const lines: string[] = [];
			for (const entry of entries) {
				lines.push(JSON.stringify({ type: "checkpoint_saved", timestamp: entry.createdAt, entry } satisfies CheckpointEvent));
				if (entry.consumedAt) {
					lines.push(JSON.stringify({ type: "checkpoint_consumed", timestamp: entry.consumedAt, id: entry.id, consumedAt: entry.consumedAt } satisfies CheckpointEvent));
				}
			}
			await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
		},
	};
}
