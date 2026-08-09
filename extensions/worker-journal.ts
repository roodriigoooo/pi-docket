import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { workerSourceLabel, type WorkerStatus } from "./background-work.js";
import { scoreBroadcastRecipients, type BroadcastCandidate } from "./worker-broadcast.js";
import { parseBulletin } from "./worker-bulletin.js";

/**
 * The project journal (P4).
 *
 * P0–P3 made *telling* honest: when the human decides to tell, Docket tells the right workers and
 * claims only what it observed. This is the other half — a worker finding out that something
 * changed under it without anyone having decided to tell it.
 *
 * The opening is that a promotion is already human-reviewed; that is what promotion means. So
 * propagating it crosses neither invariant in ADR-0008: no unreviewed premise reaches another
 * worker, and no worker content reaches the parent's context. It needs no confirmation and no
 * model spend, which is why it can be a fact Docket derives rather than a message someone had to
 * remember to send.
 *
 * Nothing here pushes. A worker mid-turn stays mid-turn; the journal reaches it at a gate it was
 * already going to stop at.
 */

const JOURNAL_DIR = "bulletins";
const MAX_ENTRIES = 120;

/**
 * `promoted` is written by Docket when a change set lands in the human's worktree. `standing` is
 * the human's bulletin post, which predates this file and keeps working unchanged. `note` is a
 * worker's notice the human chose to publish.
 */
export type JournalEntryKind = "promoted" | "standing" | "note";

export type JournalEntry = {
	at: string;
	kind: JournalEntryKind;
	/** `w2` or `you`. Displayed; never routed on. */
	from: string;
	text: string;
	/** Repo-relative paths a promotion landed. Absent on every other kind. */
	paths?: string[];
	/** Deliverable ref behind a promotion, so a worker can ask for the exact thing. */
	ref?: string;
	/** The worker whose work was promoted, so its own promotion never makes its own base stale. */
	workerId?: string;
};

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

function projectFileKey(projectKey: string): string {
	return projectKey.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "project";
}

export function journalFile(root: string, projectKey: string): string {
	return path.join(root, JOURNAL_DIR, `${projectFileKey(projectKey)}.ndjson`);
}

/**
 * The worker-facing view keeps the path the bulletin already had. Workers hold an absolute
 * pointer to it in their `task.md`, and a worker started yesterday must not be left reading a
 * file nothing writes any more.
 */
export function journalViewFile(root: string, projectKey: string): string {
	return path.join(root, JOURNAL_DIR, `${projectFileKey(projectKey)}.md`);
}

export function parseJournalEntry(line: string): JournalEntry | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const text = typeof record.text === "string" ? record.text.trim() : "";
	const at = typeof record.at === "string" ? record.at : undefined;
	if (!text || !at) return undefined;
	return {
		at,
		kind: record.kind === "promoted" || record.kind === "note" ? record.kind : "standing",
		from: typeof record.from === "string" && record.from ? record.from : "you",
		text,
		...(Array.isArray(record.paths) ? { paths: record.paths.filter((entry): entry is string => typeof entry === "string") } : {}),
		...(typeof record.ref === "string" ? { ref: record.ref } : {}),
		...(typeof record.workerId === "string" ? { workerId: record.workerId } : {}),
	};
}

/** Defensive: a half-written line, or an unrelated file, reads as fewer entries — never a throw. */
export function parseJournal(ndjson: string): JournalEntry[] {
	const entries: JournalEntry[] = [];
	for (const line of ndjson.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parsed = parseJournalEntry(trimmed);
		if (parsed) entries.push(parsed);
	}
	return entries;
}

/** Newest first, capped. Retention drops the oldest, which is also the least likely to still bind. */
export function orderedJournal(entries: JournalEntry[], max = MAX_ENTRIES): JournalEntry[] {
	return [...entries]
		.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
		.slice(0, max);
}

function entryHeading(entry: JournalEntry): string {
	if (entry.kind === "promoted") {
		const count = entry.paths?.length ?? 0;
		const files = count === 1 ? "1 file" : `${count} files`;
		return `## ${entry.at} · promoted from ${entry.from} · ${files}`;
	}
	if (entry.kind === "note") return `## ${entry.at} · shared by ${entry.from}`;
	return `## ${entry.at} · from ${entry.from}`;
}

function entryBody(entry: JournalEntry): string {
	const lines = [entry.text.replace(/\r\n/g, "\n").trim()];
	if (entry.kind === "promoted") {
		if (entry.paths?.length) lines.push("", `Files now changed on the project's base: ${entry.paths.join(", ")}`);
		if (entry.ref) lines.push(`Deliverable: ${entry.ref}`);
		// The single most load-bearing sentence in this file. A worker in an isolated worktree
		// still holds the old bytes, so "the file changed" without "not in your copy" invites it
		// to re-read its own stale version and conclude nothing happened.
		lines.push("", "Your workspace still holds the version from before this landed. Do not assume your copy of these files is current; if your work depends on one of them, say so in your outcome rather than building on the old version.");
	}
	return lines.join("\n");
}

/**
 * The whole file, regenerated from the entries every time. It is a view, never a source: there is
 * no code path that reads it back as truth, so it cannot drift from the ndjson behind it, and
 * hand-editing it survives exactly one append.
 */
export function renderJournal(entries: JournalEntry[]): string {
	const header = [
		"# Docket project journal",
		"",
		"Standing notes and landed changes for every worker on this project. Re-read this before",
		"your first edit and whenever a plan gate opens. Entries are newest first; an older entry a",
		"newer one contradicts is superseded.",
		"",
		"This file is generated. Editing it changes nothing.",
		"",
	].join("\n");
	const ordered = orderedJournal(entries);
	if (ordered.length === 0) return `${header}\n_No entries yet._\n`;
	return `${header}\n${ordered.map((entry) => `${entryHeading(entry)}\n\n${entryBody(entry)}\n`).join("\n")}`;
}

// ---------------------------------------------------------------------------
// Stale base
// ---------------------------------------------------------------------------

export type StaleBase = {
	/** Paths this worker touched or planned that have since landed under it. */
	paths: string[];
	/** How many promotions contributed. */
	entries: number;
	/** When the first of them landed. */
	since: string;
};

export type StaleBaseInput = {
	worker: WorkerStatus;
	candidate: BroadcastCandidate;
	entries: JournalEntry[];
};

/**
 * Whether a worker is building on a base that moved. Deliberately routed through the broadcast
 * scorer: there is one notion of "affected" in this codebase, and a second one that scored
 * slightly better would be a worse outcome than a shared one that sometimes scores worse.
 *
 * Only `affected` counts. `maybe` is task-text overlap, which is a fine reason to *propose* a
 * recipient to a human and a poor reason to tell a worker its ground has shifted.
 */
export function deriveStaleBase(input: StaleBaseInput): StaleBase | undefined {
	const startedAt = Date.parse(input.worker.createdAt);
	if (!Number.isFinite(startedAt)) return undefined;
	const paths = new Set<string>();
	let entries = 0;
	let since: number | undefined;

	for (const entry of input.entries) {
		if (entry.kind !== "promoted") continue;
		// A worker's own promotion is already in its workspace; it is the source, not a surprise.
		if (entry.workerId && entry.workerId === input.worker.id) continue;
		const landedAt = Date.parse(entry.at);
		// A promotion older than the worker is part of the base it started from.
		if (!Number.isFinite(landedAt) || landedAt <= startedAt) continue;

		const scored = scoreBroadcastRecipients({
			text: entry.text,
			paths: entry.paths ?? [],
			source: { kind: "human" },
			candidates: [input.candidate],
			// A finished worker is not a broadcast recipient — it can no longer act — but its
			// deliverable was still produced against a base that has since moved, and that is
			// exactly the fact the human needs before approving the diff.
			eligibleStates: STALE_ELIGIBLE_STATES,
		});
		if (scored[0]?.band !== "affected") continue;

		entries++;
		for (const raw of entry.paths ?? []) paths.add(raw);
		since = since === undefined ? landedAt : Math.min(since, landedAt);
	}

	if (entries === 0) return undefined;
	return { paths: [...paths], entries, since: new Date(since ?? Date.now()).toISOString() };
}

const STALE_ELIGIBLE_STATES = new Set<WorkerStatus["state"]>(["starting", "active", "idle", "needs_input", "ready"]);

/** Dock sub-line. Muted, not warning: the human is not the blocker on this. */
export function staleBaseLine(stale: StaleBase): string {
	const count = stale.paths.length;
	const files = count === 1 ? "1 file" : `${count} files`;
	return `base moved · ${files} it works on landed since it started`;
}

/** Verdict-card line for a deliverable produced against a base that has since moved. */
export function staleBaseVerdictLine(stale: StaleBase, max = 72): string {
	const list = stale.paths.join(", ");
	const clipped = list.length > max ? `${list.slice(0, max - 1)}…` : list;
	return `produced before ${clipped} landed · re-check before promoting`;
}

// ---------------------------------------------------------------------------
// Filesystem adapter
// ---------------------------------------------------------------------------

export async function readJournalEntries(root: string, projectKey: string): Promise<JournalEntry[]> {
	try {
		return orderedJournal(parseJournal(await fs.readFile(journalFile(root, projectKey), "utf8")));
	} catch {
		// Nothing written yet on this project: fall back to whatever the bulletin already held so
		// an upgrade never looks like the standing notes were thrown away.
		return migratedBulletinEntries(root, projectKey);
	}
}

async function migratedBulletinEntries(root: string, projectKey: string): Promise<JournalEntry[]> {
	try {
		const markdown = await fs.readFile(journalViewFile(root, projectKey), "utf8");
		// A previously rendered journal is regenerated, not re-parsed; only a real legacy
		// bulletin has entries worth recovering, and it never carried the generated marker.
		if (markdown.includes("This file is generated.")) return [];
		return parseBulletin(markdown).map((entry): JournalEntry => ({ at: entry.at, kind: "standing", from: entry.from, text: entry.text }));
	} catch {
		return [];
	}
}

/**
 * Append one entry, then rewrite the view in full. Small file, bounded history; a lock would cost
 * more than the collision it prevents, and the worst case is one lost standing note rather than a
 * corrupt file, because the ndjson is only ever rewritten from entries that parsed.
 */
export async function appendJournalEntry(root: string, projectKey: string, entry: JournalEntry): Promise<JournalEntry[]> {
	const entries = orderedJournal([entry, ...(await readJournalEntries(root, projectKey))]);
	const source = journalFile(root, projectKey);
	await fs.mkdir(path.dirname(source), { recursive: true });
	await writeAtomic(source, `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`);
	await writeAtomic(journalViewFile(root, projectKey), renderJournal(entries));
	return entries;
}

async function writeAtomic(file: string, contents: string): Promise<void> {
	const temp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(temp, contents, "utf8");
	await fs.rename(temp, file);
}

export function journalViewExistsSync(root: string, projectKey: string): boolean {
	try {
		return fsSync.statSync(journalViewFile(root, projectKey)).size > 0;
	} catch {
		return false;
	}
}

/** One line for the journal from a promotion Docket just applied. */
export function promotionJournalEntry(input: { worker: WorkerStatus; paths: string[]; ref?: string; summary?: string; at?: string }): JournalEntry {
	const label = workerSourceLabel(input.worker);
	const summary = input.summary?.replace(/\s+/g, " ").trim();
	return {
		at: input.at ?? new Date().toISOString(),
		kind: "promoted",
		from: label,
		text: summary || `${label}'s changes were approved and promoted into the project.`,
		...(input.paths.length ? { paths: input.paths } : {}),
		...(input.ref ? { ref: input.ref } : {}),
		workerId: input.worker.id,
	};
}
