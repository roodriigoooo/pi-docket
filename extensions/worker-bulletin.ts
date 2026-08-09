/**
 * The legacy bulletin format (ADR-0008, P2), kept only so an existing one can be read once.
 *
 * The bulletin was the standing project note every worker re-read at its gates. P4 folded it into
 * the project journal, which carries standing notes and landed changes in one append-only store
 * and regenerates the worker-facing markdown from it. Nothing writes this format any more: a
 * second writer would produce a file the journal's migration would import again on the next
 * upgrade, duplicating every entry it recovered.
 *
 * What survives is the parser, so a project that had a bulletin before the journal existed does
 * not look like its standing notes were thrown away.
 */

export type BulletinEntry = {
	at: string;
	/** `w2` when a worker's notice prompted this, otherwise the human. */
	from: string;
	text: string;
};

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
