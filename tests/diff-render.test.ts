import test from "node:test";
import assert from "node:assert/strict";
import { coloredAdditions, coloredDeletions, coloredFileStat, renderGitDiff, renderGitDiffLine, type DiffTheme } from "../extensions/diff-render.js";

/** Fake theme: wraps each colored span in `<color:text>` so assertions are exact and TUI-free. */
function fakeTheme(): DiffTheme {
	return {
		fg: (color, text) => `<${color}:${text}>`,
	};
}

test("renderGitDiffLine classifies git diff lines by prefix", () => {
	const t = fakeTheme();
	assert.equal(renderGitDiffLine("diff --git a/x b/x", t), "<muted:diff --git a/x b/x>");
	assert.equal(renderGitDiffLine("index 123..456 100644", t), "<muted:index 123..456 100644>");
	assert.equal(renderGitDiffLine("--- a/x", t), "<muted:--- a/x>");
	assert.equal(renderGitDiffLine("+++ b/x", t), "<muted:+++ b/x>");
	assert.equal(renderGitDiffLine("@@ -1,3 +1,4 @@ context", t), "<accent:@@ -1,3 +1,4 @@ context>");
	assert.equal(renderGitDiffLine("+added line", t), "<toolDiffAdded:+added line>");
	assert.equal(renderGitDiffLine("-removed line", t), "<toolDiffRemoved:-removed line>");
	assert.equal(renderGitDiffLine(" context line", t), "<toolDiffContext: context line>");
	assert.equal(renderGitDiffLine("", t), "<toolDiffContext:>");
});

test("renderGitDiffLine does not misclassify +++/--- headers as content", () => {
	const t = fakeTheme();
	// `+++` header must be muted, not green; `---` header must be muted, not red.
	assert.equal(renderGitDiffLine("+++ b/src/x.ts", t), "<muted:+++ b/src/x.ts>");
	assert.equal(renderGitDiffLine("--- a/src/x.ts", t), "<muted:--- a/src/x.ts>");
	// A real added line starting with `++` (two plus signs, content) is still green.
	assert.equal(renderGitDiffLine("++ nested added", t), "<toolDiffAdded:++ nested added>");
});

test("renderGitDiff colors a whole blob preserving line order and blanks", () => {
	const t = fakeTheme();
	const blob = "diff --git a/x b/x\n@@ -1,2 +1,2 @@\n context\n-old\n+new";
	const out = renderGitDiff(blob, t);
	assert.equal(out, "<muted:diff --git a/x b/x>\n<accent:@@ -1,2 +1,2 @@>\n<toolDiffContext: context>\n<toolDiffRemoved:-old>\n<toolDiffAdded:+new>");
});

test("coloredAdditions / coloredDeletions wrap the +/- token in the right color", () => {
	const t = fakeTheme();
	assert.equal(coloredAdditions(t, 15), "<toolDiffAdded:+15>");
	assert.equal(coloredDeletions(t, 3), "<toolDiffRemoved:-3>");
	assert.equal(coloredAdditions(t, 0), "<toolDiffAdded:+0>");
});

test("coloredFileStat renders +N/-M and degrades to binary when counts are absent", () => {
	const t = fakeTheme();
	assert.equal(coloredFileStat(t, 8, 2), "<toolDiffAdded:+8>/<toolDiffRemoved:-2>");
	assert.equal(coloredFileStat(t, undefined, undefined), "<muted:binary>");
	assert.equal(coloredFileStat(t, 4, undefined), "<toolDiffAdded:+4>/<toolDiffRemoved:-0>");
});
