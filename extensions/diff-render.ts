/**
 * Git-diff line coloring for Docket review surfaces.
 *
 * Pure over a minimal theme interface so it is unit-testable without a TUI.
 * Pi exposes the same theme colors (`toolDiffAdded`/`toolDiffRemoved`/`toolDiffContext`)
 * that its own diff renderer uses, so Docket's full-diff view matches the editor's palette.
 */

export type DiffTheme = {
	fg: (color: string, text: string) => string;
};

// Hunk header: `@@ -l,s +l,s @@ context`
const HUNK_HEADER = /^@@/;
// File-header / metadata lines that git emits before each hunk (`diff --git`, `index`,
// `---`, `+++`, `new file`, `deleted file`, `rename ...`). These are structural, not content.
const META_PREFIX = /^(diff --git |index |--- |\+\+\+ |new file |deleted file |rename from |rename to |copy from |copy to |old mode |new mode |similarity index |dissimilarity index )/;
// Added content line: a single `+` not followed by `++` (which would be the `+++` header).
const ADDED_LINE = /^\+(?!\+\+)/;
// Removed content line: a single `-` not followed by `--` (which would be `---` header).
const REMOVED_LINE = /^-(?!--)/;

/** Color a single git-diff line. Context and non-diff lines pass through colored as context. */
export function renderGitDiffLine(line: string, theme: DiffTheme): string {
	if (HUNK_HEADER.test(line)) return theme.fg("accent", line);
	if (META_PREFIX.test(line)) return theme.fg("muted", line);
	if (ADDED_LINE.test(line)) return theme.fg("toolDiffAdded", line);
	if (REMOVED_LINE.test(line)) return theme.fg("toolDiffRemoved", line);
	return theme.fg("toolDiffContext", line);
}

/** Color a whole git-diff blob, preserving blank lines. */
export function renderGitDiff(text: string, theme: DiffTheme): string {
	return text.split("\n").map((line) => renderGitDiffLine(line, theme)).join("\n");
}

/** `+N` colored green. */
export function coloredAdditions(theme: DiffTheme, additions: number): string {
	return theme.fg("toolDiffAdded", `+${additions}`);
}

/** `-M` colored red. */
export function coloredDeletions(theme: DiffTheme, deletions: number): string {
	return theme.fg("toolDiffRemoved", `-${deletions}`);
}

/** `+N/-M` with each side colored; `binary` when counts are absent. */
export function coloredFileStat(theme: DiffTheme, additions: number | undefined, deletions: number | undefined): string {
	if (additions === undefined && deletions === undefined) return theme.fg("muted", "binary");
	return `${coloredAdditions(theme, additions ?? 0)}/${coloredDeletions(theme, deletions ?? 0)}`;
}
