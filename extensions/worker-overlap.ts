/**
 * Grading worker overlap.
 *
 * `worker-conflicts.ts` answers "did two workers touch the same path". That is the cheap
 * question and the dock's question, but it is not the one a promotion turns on: two workers
 * editing different functions in one file collide with nothing, and warning about them exactly
 * as loudly as two rewriting the same five lines is how a warning stops being read.
 *
 * This module answers the expensive question, from bytes Docket already froze. Both workers
 * branched from the same base, so their patches' **old-file** line ranges live in one coordinate
 * space and can be compared directly; the new-file numbers cannot, because each side's numbering
 * has already absorbed its own edits.
 *
 * Everything here is pure. Nothing reads git, the filesystem, or tmux — the observed form of the
 * same question lives in `worker-changes.ts`, where git is asked whether one patch still applies
 * once the other has landed.
 */

/** A half-open range of pre-image lines a hunk replaces. `count: 0` marks a pure insertion. */
export type PatchRange = { start: number; count: number };

/** Old-file ranges per path, plus the paths a patch creates outright. */
export type PatchRanges = {
	byPath: Map<string, PatchRange[]>;
	created: Set<string>;
};

export type OverlapGrade = "same-file" | "adjacent" | "contested";

export type OverlapFile = {
	path: string;
	grade: OverlapGrade;
	/** Absent when a side's patch is unknown; the grade is then `same-file` by default. */
	ranges?: { mine: PatchRange[]; theirs: PatchRange[] };
};

export type WorkerOverlap = {
	workerId: string;
	workerLabel: string;
	taskLabel: string;
	files: OverlapFile[];
	/** The strongest grade across the files, which is what a confirmation turns on. */
	grade: OverlapGrade;
	/**
	 * What git observed about whether this worker's change set still applies once the promoted
	 * one lands. Absent means it was never asked, or the base itself had already moved and the
	 * question could not be put honestly.
	 */
	stillApplies?: boolean;
};

/** Lines of separation below which two edits are close enough to be worth mentioning. */
export const OVERLAP_ADJACENCY_LINES = 8;

const HUNK = /^@@+ (?:-(\d+)(?:,(\d+))?) /;
const OLD_FILE = /^--- (?:a\/)?(.+?)\s*$/;
const NEW_FILE = /^\+\+\+ (?:b\/)?(.+?)\s*$/;

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Defensive parse: a truncated or binary patch reads as fewer ranges, never as a throw. A file
 * Docket cannot read ranges for still overlaps at path level, which is the honest fallback.
 */
export function parsePatchRanges(patch: string): PatchRanges {
	const byPath = new Map<string, PatchRange[]>();
	const created = new Set<string>();
	let path: string | undefined;
	let isNew = false;
	for (const line of patch.split(/\r?\n/)) {
		if (line.startsWith("diff --git ")) {
			path = undefined;
			isNew = false;
			continue;
		}
		if (line.startsWith("new file mode")) {
			isNew = true;
			continue;
		}
		const old = OLD_FILE.exec(line);
		if (old?.[1]) {
			if (old[1] === "/dev/null") isNew = true;
			continue;
		}
		const next = NEW_FILE.exec(line);
		if (next?.[1]) {
			path = next[1] === "/dev/null" ? undefined : normalizePath(next[1]);
			if (path && isNew) created.add(path);
			if (path && !byPath.has(path)) byPath.set(path, []);
			continue;
		}
		const hunk = HUNK.exec(line);
		if (!hunk || !path) continue;
		const start = Number(hunk[1]);
		const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
		if (!Number.isFinite(start) || !Number.isFinite(count)) continue;
		byPath.set(path, [...(byPath.get(path) ?? []), { start, count }]);
	}
	return { byPath, created };
}

/** Distance in pre-image lines between two ranges. Zero means they touch or intersect. */
function gap(a: PatchRange, b: PatchRange): number {
	// A pure insertion occupies no lines, so it is measured at its anchor.
	const aEnd = a.start + Math.max(a.count, 1) - 1;
	const bEnd = b.start + Math.max(b.count, 1) - 1;
	if (a.start <= bEnd && b.start <= aEnd) return 0;
	return a.start > bEnd ? a.start - bEnd : b.start - aEnd;
}

export function gradeRanges(mine: PatchRange[], theirs: PatchRange[], adjacency = OVERLAP_ADJACENCY_LINES): OverlapGrade {
	// No ranges on either side is not evidence of separation, so it never grades below the
	// weakest claim the path itself already supports.
	if (mine.length === 0 || theirs.length === 0) return "same-file";
	let closest = Number.POSITIVE_INFINITY;
	for (const a of mine) for (const b of theirs) closest = Math.min(closest, gap(a, b));
	if (closest === 0) return "contested";
	return closest <= adjacency ? "adjacent" : "same-file";
}

const RANK: Record<OverlapGrade, number> = { "same-file": 0, adjacent: 1, contested: 2 };

export function strongestGrade(files: readonly OverlapFile[]): OverlapGrade {
	return files.reduce<OverlapGrade>((acc, file) => RANK[file.grade] > RANK[acc] ? file.grade : acc, "same-file");
}

/**
 * Grade every path two workers share. `mine`/`theirs` are the two patches when Docket has them;
 * a worker still mid-task has no frozen change set, and its files stay at `same-file` rather than
 * being quietly cleared — silence about a collision has to be earned by evidence, not by absence.
 */
export function gradeOverlapFiles(
	sharedPaths: readonly string[],
	mine: PatchRanges | undefined,
	theirs: PatchRanges | undefined,
	adjacency = OVERLAP_ADJACENCY_LINES,
): OverlapFile[] {
	return sharedPaths.map((path) => {
		const mineRanges = mine?.byPath.get(path);
		const theirRanges = theirs?.byPath.get(path);
		// Both sides creating the same file is a collision no line arithmetic improves on.
		if (mine?.created.has(path) && theirs?.created.has(path)) {
			return { path, grade: "contested", ranges: { mine: mineRanges ?? [], theirs: theirRanges ?? [] } };
		}
		if (!mineRanges || !theirRanges) return { path, grade: "same-file" };
		return { path, grade: gradeRanges(mineRanges, theirRanges, adjacency), ranges: { mine: mineRanges, theirs: theirRanges } };
	});
}

/**
 * A confirmation is owed unless Docket observed that the edits do not meet. An overlap it could
 * not grade still asks, because "we could not tell" and "they are apart" are different facts.
 */
export function overlapNeedsConfirmation(overlaps: readonly WorkerOverlap[]): boolean {
	return overlaps.some((overlap) => overlap.grade !== "same-file" || overlap.stillApplies === false || overlap.files.some((file) => !file.ranges));
}

function rangeLabel(ranges: PatchRange[]): string {
	if (ranges.length === 0) return "";
	const first = ranges[0]!;
	const last = ranges[ranges.length - 1]!;
	const span = `lines ${first.start}-${last.start + Math.max(last.count, 1) - 1}`;
	return ranges.length > 1 ? `${span} · ${ranges.length} hunks` : span;
}

const GRADE_WORD: Record<OverlapGrade, string> = {
	"same-file": "same file",
	adjacent: "adjacent",
	contested: "contested",
};

/**
 * The body of the promote confirmation. It names who, what, and — the part that was missing —
 * what promoting does to them, which is a fact P4 already makes true the moment the promotion
 * lands. Rows carry task text, never an index alone.
 */
export function overlapConfirmationLines(overlaps: readonly WorkerOverlap[]): string[] {
	const lines: string[] = [];
	for (const overlap of overlaps) {
		for (const file of overlap.files) {
			lines.push(`${GRADE_WORD[file.grade]}: ${file.path}`);
			const mine = file.ranges ? rangeLabel(file.ranges.mine) : "";
			const theirs = file.ranges ? rangeLabel(file.ranges.theirs) : "line ranges unknown · that worker has not frozen a change set yet";
			lines.push(`  this worker${mine ? ` · ${mine}` : ""}`);
			lines.push(`  ${overlap.workerLabel} · ${overlap.taskLabel}${theirs ? ` · ${theirs}` : ""}`);
		}
		if (overlap.stillApplies === false) lines.push(`${overlap.workerLabel}'s change set no longer applies once this lands`);
		else if (overlap.stillApplies === true) lines.push(`${overlap.workerLabel}'s change set still applies once this lands`);
		lines.push(`promoting this leaves ${overlap.workerLabel} building on the old version`);
		lines.push("");
	}
	return lines.filter((line, index, all) => line !== "" || index !== all.length - 1);
}

/**
 * Split a patch into its per-path sections, keeping each section's bytes exactly as git wrote
 * them. Used to show only the paths two workers contest rather than two whole change sets.
 */
export function splitPatchByPath(patch: string): Map<string, string> {
	const out = new Map<string, string>();
	let path: string | undefined;
	let section: string[] = [];
	const flush = (): void => {
		if (path && section.length > 0) out.set(path, `${[...(out.get(path) ? [out.get(path)!.trimEnd()] : []), section.join("\n").trimEnd()].join("\n")}\n`);
		section = [];
		path = undefined;
	};
	for (const line of patch.split(/\r?\n/)) {
		if (line.startsWith("diff --git ")) {
			flush();
			section = [line];
			continue;
		}
		if (section.length === 0) continue;
		section.push(line);
		const next = NEW_FILE.exec(line);
		if (next?.[1] && next[1] !== "/dev/null") path = normalizePath(next[1]);
		// A deletion has no b-side path; fall back to the a-side so the section is still findable.
		const old = OLD_FILE.exec(line);
		if (!path && old?.[1] && old[1] !== "/dev/null") path = normalizePath(old[1]);
	}
	flush();
	return out;
}

export type OverlapSide = { label: string; taskLabel: string; patch: string };

/**
 * Both workers' hunks for the contested paths only, each section headed by whose it is.
 *
 * This is a reading surface, not something anyone applies: two sections for one path would be
 * applied twice by git, which is exactly why the human is looking at it. The header comments are
 * ordinary leading text in a unified diff, so the built-in viewer and Hunk both render it.
 *
 * Every section names a worker *and its task*, never an index alone.
 */
export function composeOverlapPatch(paths: readonly string[], mine: OverlapSide, theirs: readonly OverlapSide[]): string {
	const sides = [mine, ...theirs];
	const sections = sides.map((side) => ({ side, byPath: splitPatchByPath(side.patch) }));
	const blocks: string[] = [];
	for (const path of paths) {
		for (const { side, byPath } of sections) {
			const body = byPath.get(path);
			if (!body) continue;
			blocks.push(`# ${side.label} · ${side.taskLabel}\n${body.trimEnd()}`);
		}
	}
	return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

/** The paths worth putting in front of a human: everything that graded above `same file`. */
export function contestedPaths(overlaps: readonly WorkerOverlap[]): string[] {
	const paths = new Set<string>();
	for (const overlap of overlaps) {
		for (const file of overlap.files) {
			if (file.grade !== "same-file" || !file.ranges) paths.add(file.path);
		}
	}
	return [...paths].sort();
}

/** The verdict card's one line about this, or nothing when there is nothing to say. */
export function overlapCardLine(overlaps: readonly WorkerOverlap[]): string | undefined {
	const summary = overlapSummaryLine(overlaps);
	if (!summary || contestedPaths(overlaps).length === 0) return undefined;
	return `${summary} · o to see both diffs`;
}

/** One line for a surface that has room for one: the strongest thing observed, and who with. */
export function overlapSummaryLine(overlaps: readonly WorkerOverlap[]): string | undefined {
	if (overlaps.length === 0) return undefined;
	const ranked = [...overlaps].sort((a, b) => RANK[b.grade] - RANK[a.grade]);
	const first = ranked[0]!;
	const file = first.files.find((entry) => entry.grade === first.grade)?.path ?? first.files[0]?.path;
	const short = file ? file.slice(file.lastIndexOf("/") + 1) : "";
	const more = ranked.length > 1 ? ` +${ranked.length - 1} worker${ranked.length === 2 ? "" : "s"}` : "";
	return `${GRADE_WORD[first.grade]} ${first.workerLabel}${short ? `: ${short}` : ""}${more}`;
}
