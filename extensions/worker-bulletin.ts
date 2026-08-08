import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

/**
 * The standing project note every worker re-reads at its gates (ADR-0008).
 *
 * A broadcast reaches the workers running right now. The bulletin reaches the ones that start
 * tomorrow, and it is what Docket proposes when it cannot tell who is affected — handing the
 * human a grid of checkboxes and calling that a choice is not the same as helping.
 *
 * It deliberately lives under the agent directory rather than in the repo: workers run in
 * isolated worktrees, so a file inside the working copy would be a stale snapshot for exactly
 * the workers that most need it current. One absolute path, shared by every worktree.
 */

const BULLETIN_DIR = "bulletins";
const MAX_ENTRIES = 40;

export type BulletinEntry = {
	at: string;
	/** `w2` when a worker's notice prompted this, otherwise the human. */
	from: string;
	text: string;
};

export function bulletinFile(root: string, projectKey: string): string {
	const safe = projectKey.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "project";
	return path.join(root, BULLETIN_DIR, `${safe}.md`);
}

function formatEntry(entry: BulletinEntry): string {
	const body = entry.text.replace(/\r\n/g, "\n").trim();
	return `## ${entry.at} · from ${entry.from}\n\n${body}\n`;
}

/** Newest first: a worker skimming this should hit current constraints before historical ones. */
export function renderBulletin(entries: BulletinEntry[]): string {
	const header = [
		"# Docket bulletin",
		"",
		"Standing notes for every worker on this project. Re-read this before your first edit and",
		"whenever a plan gate opens. Entries are newest first; an older entry a newer one",
		"contradicts is superseded.",
		"",
	].join("\n");
	return `${header}\n${entries.slice(0, MAX_ENTRIES).map(formatEntry).join("\n")}`;
}

export function parseBulletin(markdown: string): BulletinEntry[] {
	const entries: BulletinEntry[] = [];
	const pattern = /^## (\S+) · from (\S+)\s*$/gm;
	const matches = [...markdown.matchAll(pattern)];
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index]!;
		const start = (match.index ?? 0) + match[0].length;
		const end = index + 1 < matches.length ? matches[index + 1]!.index ?? markdown.length : markdown.length;
		const text = markdown.slice(start, end).trim();
		if (text) entries.push({ at: match[1]!, from: match[2]!, text });
	}
	return entries;
}

export async function readBulletinEntries(file: string): Promise<BulletinEntry[]> {
	try {
		return parseBulletin(await fs.readFile(file, "utf8"));
	} catch {
		return [];
	}
}

/** Prepend one entry and rewrite. Small file, bounded history, no locking worth its weight. */
export async function appendBulletinEntry(file: string, entry: BulletinEntry): Promise<BulletinEntry[]> {
	const existing = await readBulletinEntries(file);
	const entries = [entry, ...existing].slice(0, MAX_ENTRIES);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(temp, renderBulletin(entries), "utf8");
	await fs.rename(temp, file);
	return entries;
}

export function bulletinExistsSync(file: string): boolean {
	try {
		return fsSync.statSync(file).size > 0;
	} catch {
		return false;
	}
}
