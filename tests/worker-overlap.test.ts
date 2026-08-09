import test from "node:test";
import assert from "node:assert/strict";
import {
	composeOverlapPatch,
	contestedPaths,
	gradeOverlapFiles,
	gradeRanges,
	overlapCardLine,
	overlapConfirmationLines,
	overlapNeedsConfirmation,
	overlapSummaryLine,
	parsePatchRanges,
	splitPatchByPath,
	strongestGrade,
	type WorkerOverlap,
} from "../extensions/worker-overlap.js";

function patch(path: string, hunks: string[]): string {
	return [
		`diff --git a/${path} b/${path}`,
		"index 1111111..2222222 100644",
		`--- a/${path}`,
		`+++ b/${path}`,
		...hunks,
	].join("\n");
}

function hunk(oldStart: number, oldCount: number, body = " context\n+added"): string {
	return `@@ -${oldStart},${oldCount} +${oldStart},${oldCount + 1} @@\n${body}`;
}

test("parsePatchRanges reads old-file ranges, which is the space both workers share", () => {
	const ranges = parsePatchRanges(patch("src/api/limit.ts", [hunk(40, 8), hunk(120, 3)]));

	assert.deepEqual(ranges.byPath.get("src/api/limit.ts"), [{ start: 40, count: 8 }, { start: 120, count: 3 }]);
	assert.equal(ranges.created.size, 0);
});

test("parsePatchRanges records a created file and reads a one-line hunk header", () => {
	const created = [
		"diff --git a/src/new.ts b/src/new.ts",
		"new file mode 100644",
		"--- /dev/null",
		"+++ b/src/new.ts",
		"@@ -0,0 +1,3 @@",
		"+one",
	].join("\n");
	const ranges = parsePatchRanges(created);
	assert.equal(ranges.created.has("src/new.ts"), true);

	// `@@ -12 +12,2 @@` omits the count, which means exactly one line.
	const single = parsePatchRanges(patch("a.ts", ["@@ -12 +12,2 @@\n context"]));
	assert.deepEqual(single.byPath.get("a.ts"), [{ start: 12, count: 1 }]);
});

test("parsePatchRanges survives truncated and unreadable patches without throwing", () => {
	assert.equal(parsePatchRanges("").byPath.size, 0);
	assert.equal(parsePatchRanges("Binary files a/x.png and b/x.png differ").byPath.size, 0);
	assert.doesNotThrow(() => parsePatchRanges(patch("a.ts", ["@@ -nonsense @@"])));
});

test("gradeRanges separates touching the same file from contesting the same lines", () => {
	// The failure this whole module exists to fix: different functions in one file.
	assert.equal(gradeRanges([{ start: 10, count: 5 }], [{ start: 200, count: 4 }]), "same-file");
	assert.equal(gradeRanges([{ start: 40, count: 8 }], [{ start: 44, count: 3 }]), "contested");
	// Abutting counts as meeting: line 45 is the last of the first range.
	assert.equal(gradeRanges([{ start: 40, count: 6 }], [{ start: 45, count: 2 }]), "contested");
	assert.equal(gradeRanges([{ start: 40, count: 5 }], [{ start: 49, count: 2 }]), "adjacent");
	assert.equal(gradeRanges([{ start: 40, count: 5 }], [{ start: 60, count: 2 }]), "same-file");
});

test("gradeRanges never grades absence as separation", () => {
	assert.equal(gradeRanges([], [{ start: 40, count: 8 }]), "same-file");
	assert.equal(gradeRanges([{ start: 40, count: 8 }], []), "same-file");
});

test("a pure insertion is measured at its anchor rather than vanishing", () => {
	assert.equal(gradeRanges([{ start: 40, count: 0 }], [{ start: 40, count: 3 }]), "contested");
	assert.equal(gradeRanges([{ start: 40, count: 0 }], [{ start: 100, count: 3 }]), "same-file");
});

test("gradeOverlapFiles keeps an ungradeable file at the claim the path already supports", () => {
	const mine = parsePatchRanges(patch("src/api/limit.ts", [hunk(40, 8)]));

	const unknown = gradeOverlapFiles(["src/api/limit.ts"], mine, undefined);
	assert.deepEqual(unknown, [{ path: "src/api/limit.ts", grade: "same-file" }]);
	assert.equal(unknown[0]!.ranges, undefined, "no ranges means Docket could not tell, and says so by omission");

	const theirs = parsePatchRanges(patch("src/api/limit.ts", [hunk(41, 2)]));
	const graded = gradeOverlapFiles(["src/api/limit.ts"], mine, theirs);
	assert.equal(graded[0]!.grade, "contested");
	assert.deepEqual(graded[0]!.ranges?.theirs, [{ start: 41, count: 2 }]);
});

test("two workers creating the same file are contested with no arithmetic", () => {
	const create = (path: string) => parsePatchRanges([
		`diff --git a/${path} b/${path}`,
		"new file mode 100644",
		"--- /dev/null",
		`+++ b/${path}`,
		"@@ -0,0 +1,2 @@",
		"+one",
	].join("\n"));

	assert.equal(gradeOverlapFiles(["src/new.ts"], create("src/new.ts"), create("src/new.ts"))[0]!.grade, "contested");
});

test("strongestGrade reports the worst thing found, not the last", () => {
	assert.equal(strongestGrade([{ path: "a", grade: "same-file" }, { path: "b", grade: "contested" }, { path: "c", grade: "adjacent" }]), "contested");
	assert.equal(strongestGrade([]), "same-file");
});

function overlap(partial: Partial<WorkerOverlap> = {}): WorkerOverlap {
	return {
		workerId: "peer",
		workerLabel: "w2",
		taskLabel: "add a per-tenant rate limit",
		files: [{ path: "src/api/limit.ts", grade: "contested", ranges: { mine: [{ start: 40, count: 8 }], theirs: [{ start: 44, count: 3 }] } }],
		grade: "contested",
		...partial,
	};
}

test("a confirmation is owed unless Docket observed the edits do not meet", () => {
	assert.equal(overlapNeedsConfirmation([]), false);
	assert.equal(overlapNeedsConfirmation([overlap()]), true);
	assert.equal(overlapNeedsConfirmation([overlap({ grade: "adjacent", files: [{ path: "a", grade: "adjacent", ranges: { mine: [], theirs: [] } }] })]), true);

	// Observed separation, and only that, buys silence.
	const apart = overlap({ grade: "same-file", files: [{ path: "a", grade: "same-file", ranges: { mine: [{ start: 1, count: 1 }], theirs: [{ start: 90, count: 1 }] } }] });
	assert.equal(overlapNeedsConfirmation([apart]), false);
	// The same shape without ranges is "we could not tell", which still asks.
	assert.equal(overlapNeedsConfirmation([overlap({ grade: "same-file", files: [{ path: "a", grade: "same-file" }] })]), true);
	// And an observed apply failure asks whatever the ranges said.
	assert.equal(overlapNeedsConfirmation([{ ...apart, stillApplies: false }]), true);
});

test("the confirmation names who, what, and what promoting does to them", () => {
	const lines = overlapConfirmationLines([overlap({ stillApplies: false })]);
	const text = lines.join("\n");

	assert.match(text, /contested: src\/api\/limit\.ts/);
	assert.match(text, /this worker · lines 40-47/);
	assert.match(text, /w2 · add a per-tenant rate limit · lines 44-46/, "rows carry task text, never an index alone");
	assert.match(text, /w2's change set no longer applies once this lands/);
	assert.match(text, /promoting this leaves w2 building on the old version/);
});

test("an ungradeable peer says why rather than implying separation", () => {
	const text = overlapConfirmationLines([overlap({ grade: "same-file", files: [{ path: "src/api/limit.ts", grade: "same-file" }] })]).join("\n");

	assert.match(text, /line ranges unknown · that worker has not frozen a change set yet/);
	assert.doesNotMatch(text, /still applies/);
});

test("splitPatchByPath keeps each file's bytes as git wrote them", () => {
	const two = [patch("src/api/limit.ts", [hunk(40, 8)]), patch("src/auth/middleware.ts", [hunk(10, 2)])].join("\n");
	const sections = splitPatchByPath(two);

	assert.deepEqual([...sections.keys()].sort(), ["src/api/limit.ts", "src/auth/middleware.ts"]);
	assert.match(sections.get("src/api/limit.ts")!, /^diff --git a\/src\/api\/limit\.ts/);
	assert.match(sections.get("src/api/limit.ts")!, /@@ -40,8/);
	assert.doesNotMatch(sections.get("src/api/limit.ts")!, /middleware/);
});

test("composeOverlapPatch shows the contested path only, attributed by worker and task", () => {
	const mine = { label: "w6", taskLabel: "give authenticate() a context argument", patch: [patch("src/api/limit.ts", [hunk(40, 8)]), patch("docs/untouched.md", [hunk(1, 1)])].join("\n") };
	const theirs = { label: "w2", taskLabel: "add a per-tenant rate limit", patch: patch("src/api/limit.ts", [hunk(44, 3)]) };

	const composed = composeOverlapPatch(["src/api/limit.ts"], mine, [theirs]);

	assert.match(composed, /# w6 · give authenticate\(\) a context argument/);
	assert.match(composed, /# w2 · add a per-tenant rate limit/, "every section names a worker and its task, never an index alone");
	assert.doesNotMatch(composed, /untouched/, "only the paths they contest");
	assert.equal(composed.indexOf("# w6") < composed.indexOf("# w2"), true, "the worker being reviewed goes first");
	assert.equal((composed.match(/diff --git/g) ?? []).length, 2, "one section per worker for the one path");
});

test("composeOverlapPatch is empty when only one side has bytes", () => {
	const mine = { label: "w6", taskLabel: "t", patch: patch("src/api/limit.ts", [hunk(40, 8)]) };
	assert.equal(composeOverlapPatch(["src/other.ts"], mine, []), "");
});

test("contestedPaths is what is worth putting in front of a human", () => {
	const graded = overlap({
		files: [
			{ path: "quiet.ts", grade: "same-file", ranges: { mine: [{ start: 1, count: 1 }], theirs: [{ start: 90, count: 1 }] } },
			{ path: "close.ts", grade: "adjacent", ranges: { mine: [{ start: 1, count: 1 }], theirs: [{ start: 6, count: 1 }] } },
			{ path: "unknown.ts", grade: "same-file" },
		],
	});

	assert.deepEqual(contestedPaths([graded]), ["close.ts", "unknown.ts"], "observed separation drops out; ungraded stays");
});

test("overlapCardLine says nothing when there is nothing to look at", () => {
	assert.equal(overlapCardLine([]), undefined);
	const apart = overlap({ grade: "same-file", files: [{ path: "a.ts", grade: "same-file", ranges: { mine: [{ start: 1, count: 1 }], theirs: [{ start: 90, count: 1 }] } }] });
	assert.equal(overlapCardLine([apart]), undefined);
	assert.equal(overlapCardLine([overlap()]), "contested w2: limit.ts · o to see both diffs");
});

test("overlapSummaryLine leads with the worst grade and names the file, not the path", () => {
	const mild = overlap({ workerLabel: "w4", grade: "same-file", files: [{ path: "src/api/limit.ts", grade: "same-file" }] });
	assert.equal(overlapSummaryLine([mild, overlap()]), "contested w2: limit.ts +1 worker");
	assert.equal(overlapSummaryLine([mild]), "same file w4: limit.ts");
	assert.equal(overlapSummaryLine([]), undefined);
});
