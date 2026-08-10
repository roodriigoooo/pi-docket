import test from "node:test";
import assert from "node:assert/strict";
import {
	countConflictRegions,
	parseMergeTreeOutput,
	reconcileChoiceLabel,
	reconcileDecisionOption,
	reconcileEditorTitle,
	reconcileHandoffMessage,
	reconcileResultLines,
	reconcileSummaryOf,
	reconcileUnavailableLine,
	reconciledJournalText,
	relabelConflictMarkers,
	unquoteGitPath,
	unresolvedConflictLines,
	type ReconcileSummary,
} from "../extensions/worker-reconcile.js";

const MINE = { label: "w2", taskLabel: "add a per-tenant rate limit" };
const THEIRS = { label: "w3", taskLabel: "give authenticate() an AuthContext" };

function merged(labels = { ours: "0c78c5c4", base: "146c0ea", theirs: "d182a0bd" }): string {
	return [
		"import { authenticate, type AuthContext } from \"../auth/middleware.js\";",
		"",
		`<<<<<<< ${labels.ours}`,
		"const tenantLimits = new Map<string, number>();",
		`||||||| ${labels.base}`,
		"export function limitFor(token: string): number {",
		"=======",
		"export function limitFor(token: string, context: AuthContext): number {",
		`>>>>>>> ${labels.theirs}`,
		"}",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

test("conflict markers are relabelled by worker and task, never by object id", () => {
	const relabelled = relabelConflictMarkers(merged(), {
		ours: "w2 · add a per-tenant rate limit",
		base: "base · what both started from",
		theirs: "w3 · give authenticate() an AuthContext",
	});

	assert.match(relabelled, /^<<<<<<< w2 · add a per-tenant rate limit$/m);
	assert.match(relabelled, /^\|\|\|\|\|\|\| base · what both started from$/m);
	assert.match(relabelled, /^>>>>>>> w3 · give authenticate\(\) an AuthContext$/m);
	// The roles are fixed by the glyph, so nothing of git's own labelling survives to be read.
	assert.equal(relabelled.includes("0c78c5c4"), false);
	assert.equal(relabelled.includes("d182a0bd"), false);
	// The content between the markers is untouched.
	assert.match(relabelled, /^const tenantLimits = new Map<string, number>\(\);$/m);
});

test("one region is one two-sided decision, however many lines it spans", () => {
	assert.equal(countConflictRegions(merged()), 1);
	assert.equal(countConflictRegions(`${merged()}\n${merged()}`), 2);
	assert.equal(countConflictRegions("nothing contested here\n"), 0);
});

test("the leftover-marker gate finds every marker and ignores a markdown underline", () => {
	assert.deepEqual(unresolvedConflictLines(merged()), [3, 5, 9]);
	assert.deepEqual(unresolvedConflictLines("resolved by hand\n"), []);
	// Seven equals signs is a heading underline in ordinary prose. A gate that read it as an
	// unresolved conflict would refuse to promote documentation.
	assert.deepEqual(unresolvedConflictLines("Title\n=======\nbody\n"), []);
});

// ---------------------------------------------------------------------------
// merge-tree output
// ---------------------------------------------------------------------------

test("a conflicted merge-tree run yields its tree, its paths once, and its messages", () => {
	const parsed = parseMergeTreeOutput([
		"54d45ba927d5efc0c5aec5850c246dcfece00c99",
		"100644 5e8b687707751dccd137c73efc39a92b22e27316 1\tsrc/api/limit.ts",
		"100644 1e653e5ef98f0f75fe696f8b23b8541b648b04ff 2\tsrc/api/limit.ts",
		"100644 6db3fafcb6a9532cc791f03b7890da8752b35372 3\tsrc/api/limit.ts",
		"",
		"Auto-merging src/api/limit.ts",
		"CONFLICT (content): Merge conflict in src/api/limit.ts",
		"",
	].join("\n"));

	assert.equal(parsed.tree, "54d45ba927d5efc0c5aec5850c246dcfece00c99");
	// Three index stages are one contested file, not three.
	assert.deepEqual(parsed.conflicted, ["src/api/limit.ts"]);
	assert.deepEqual(parsed.messages, ["Auto-merging src/api/limit.ts", "CONFLICT (content): Merge conflict in src/api/limit.ts"]);
});

test("a clean merge-tree run is a tree and nothing else", () => {
	const parsed = parseMergeTreeOutput("54d45ba927d5efc0c5aec5850c246dcfece00c99\n");
	assert.equal(parsed.tree, "54d45ba927d5efc0c5aec5850c246dcfece00c99");
	assert.deepEqual(parsed.conflicted, []);
});

test("unrecognised output reads as no tree rather than as a throw", () => {
	// No tree is read everywhere as "could not tell", which is the honest degrade.
	assert.equal(parseMergeTreeOutput("fatal: not a git repository\n").tree, undefined);
	assert.equal(parseMergeTreeOutput("").tree, undefined);
});

test("a C-quoted path is unquoted back to the path git meant", () => {
	// git escapes per byte in octal, so one accented character is two escapes.
	assert.equal(unquoteGitPath("\"src/api/\\303\\251t\\303\\251.ts\""), "src/api/été.ts");
	assert.equal(unquoteGitPath("\"src/a b/\\\"q\\\".ts\""), "src/a b/\"q\".ts");
	assert.equal(unquoteGitPath("\"src/api/tab\\there.ts\""), "src/api/tab\there.ts");
	assert.equal(unquoteGitPath("src/api/limit.ts"), "src/api/limit.ts");
});

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

const CLEAN: ReconcileSummary = reconcileSummaryOf(["src/api/limit.ts", "src/auth/middleware.ts"], []);
const CONTESTED: ReconcileSummary = reconcileSummaryOf(["src/api/limit.ts"], [{ path: "src/api/limit.ts", regions: 2 }]);

test("a clean merge says so before the human commits to it", () => {
	assert.equal(
		reconcileChoiceLabel(THEIRS, CLEAN),
		"Combine with w3 · give authenticate() an AuthContext · merges clean, 2 files",
	);
});

test("a contested merge states how much judgment it is asking for", () => {
	assert.equal(
		reconcileChoiceLabel(THEIRS, CONTESTED),
		"Combine with w3 · give authenticate() an AuthContext · 2 conflicts to resolve in 1 file",
	);
});

test("every surface that names a worker names its task in the same breath", () => {
	const rows = [
		reconcileChoiceLabel(THEIRS, CLEAN),
		reconcileDecisionOption(MINE, CONTESTED),
		...reconcileResultLines(MINE, THEIRS, CONTESTED),
		reconciledJournalText([MINE, THEIRS]),
	];
	for (const row of rows) {
		if (!row.includes("w2") && !row.includes("w3")) continue;
		assert.ok(
			row.includes(MINE.taskLabel) || row.includes(THEIRS.taskLabel),
			`row names a worker without its task: ${row}`,
		);
	}
});

test("the editor title orients on the file, and the markers inside carry the tasks", () => {
	// The one surface where the label is short: it is the frame around content whose every
	// marker names a worker and its task, one line into the file the human is about to read.
	assert.equal(reconcileEditorTitle("src/api/limit.ts", MINE, THEIRS), "Resolve src/api/limit.ts · w2 + w3");
	const relabelled = relabelConflictMarkers(merged(), {
		ours: `${MINE.label} · ${MINE.taskLabel}`,
		base: "base · what both started from",
		theirs: `${THEIRS.label} · ${THEIRS.taskLabel}`,
	});
	assert.match(relabelled, /<<<<<<< w2 · add a per-tenant rate limit/);
	assert.match(relabelled, />>>>>>> w3 · give authenticate\(\) an AuthContext/);
});

test("the confirmation names both sides and what is still owed a decision", () => {
	const lines = reconcileResultLines(MINE, THEIRS, CONTESTED);
	assert.ok(lines.includes("w2 · add a per-tenant rate limit"));
	assert.ok(lines.includes("w3 · give authenticate() an AuthContext"));
	assert.ok(lines.some((line) => line.includes("1 file left contested")));
	assert.ok(lines.some((line) => line.includes("src/api/limit.ts · 2 regions")));
	// The point of the whole lane: neither worker is being asked to redo anything.
	assert.ok(lines.some((line) => line.includes("both are told their work is already in")));
});

test("a clean confirmation claims nothing was contested", () => {
	const lines = reconcileResultLines(MINE, THEIRS, CLEAN);
	assert.ok(lines.some((line) => line.includes("nothing contested")));
	assert.equal(lines.some((line) => line.includes("left contested")), false);
});

test("the ledger row reads as a sentence about the other party", () => {
	assert.equal(
		reconcileDecisionOption(MINE, CONTESTED),
		"reconciled with w2 · add a per-tenant rate limit · 1 file, 1 file resolved by hand",
	);
	assert.equal(
		reconcileDecisionOption(MINE, CLEAN),
		"reconciled with w2 · add a per-tenant rate limit · 2 files",
	);
});

test("the journal tells both workers their work is in, not that their base moved", () => {
	const text = reconciledJournalText([MINE, THEIRS]);
	assert.match(text, /w2 \(add a per-tenant rate limit\) and w3 \(give authenticate\(\) an AuthContext\)/);
	assert.match(text, /neither was discarded and neither needs redoing/);
});

// ---------------------------------------------------------------------------
// Handing it to a worker
// ---------------------------------------------------------------------------

test("a reconciliation handed to a worker carries its provenance, not a settled premise", () => {
	const message = reconcileHandoffMessage({
		other: MINE,
		paths: ["src/api/limit.ts"],
		bothDiffs: "# w2 · add a per-tenant rate limit\ndiff --git a/src/api/limit.ts b/src/api/limit.ts",
		merged: merged(),
		directive: "keep w2's signature and fold the tenant map into it",
	});

	// ADR-0008: another worker's unreviewed change never enters as fact.
	assert.match(message, /under human review and is not in the project yet/);
	assert.match(message, /Treat it as a proposal/);
	assert.match(message, /your workspace still holds the version from before either of you started/);
	// The human's directive and both sides travel together, attributed.
	assert.match(message, /keep w2's signature and fold the tenant map into it/);
	assert.match(message, /# w2 · add a per-tenant rate limit/);
	assert.match(message, /docket_done/);
});

test("a handoff without a merged residue simply omits it", () => {
	const message = reconcileHandoffMessage({
		other: MINE,
		paths: ["src/api/limit.ts"],
		bothDiffs: "diff --git a/src/api/limit.ts b/src/api/limit.ts",
		directive: "reconcile both",
	});
	assert.equal(message.includes("Where git could not merge them"), false);
});

// ---------------------------------------------------------------------------
// Summary shaping
// ---------------------------------------------------------------------------

test("a merge that could not be opened says which peer and why", () => {
	// Silence would be the one dishonest degrade here: the human would see the older exits and
	// assume combining was never possible for this collision.
	assert.equal(reconcileUnavailableLine([]), undefined);
	assert.equal(
		reconcileUnavailableLine(["w3: this git predates 2.38, where merging without a checkout arrived"]),
		"Docket could not merge this overlap · w3: this git predates 2.38, where merging without a checkout arrived",
	);
	assert.match(reconcileUnavailableLine(["w3: no base", "w4: no base"])!, /^Docket could not merge these overlaps · w3: no base · w4: no base$/);
});

test("a summary is clean exactly when nothing conflicted, and is ordered", () => {
	assert.equal(reconcileSummaryOf(["b.ts", "a.ts"], []).kind, "clean");
	assert.deepEqual(reconcileSummaryOf(["b.ts", "a.ts"], []).paths, ["a.ts", "b.ts"]);
	assert.equal(reconcileSummaryOf(["a.ts"], [{ path: "a.ts", regions: 1 }]).kind, "conflicted");
});
