import test from "node:test";
import assert from "node:assert/strict";
import { availableSources, episodesFromItems, filteredReviewItems, handleNavigatorIntent, initialNavigatorState, navigatorSourceLabel, navigatorViewModel, reviewItemForArtifact, sameNavigatorSource } from "../extensions/docket-navigator.js";
import type { Artifact, ArtifactKind } from "../extensions/types.js";

function artifact(id: string, kind: ArtifactKind, timestamp: number, meta: Record<string, unknown> = {}, source?: string): Artifact {
	return {
		id,
		displayId: id,
		ref: `${kind}:entry:${id}`,
		kind,
		title: `${kind} ${id}`,
		subtitle: "",
		body: "body",
		timestamp,
		meta,
		source,
	};
}

function queue(pinnedRefs: string[] = [], doneRefs: string[] = []) {
	return { pinnedRefs: new Set(pinnedRefs), doneRefs: new Set(doneRefs) };
}

test("Navigator inbox drops bare assistant edits but keeps worker-attached patches", () => {
	const state = { ...initialNavigatorState(), source: { kind: "all" as const } };
	const artifacts = [
		artifact("r1", "response", 1),
		artifact("f1", "file", 2, { tool: "edit" }),
		artifact("p1", "prompt", 3),
		artifact("f2", "file", 4, { tool: "edit", diff: "+ line" }, "w1"),
	];

	assert.equal(state.mode, "review");
	assert.equal(state.showDetail, false);
	assert.deepEqual(filteredReviewItems(state, artifacts).map((item) => item.artifact.id), ["f2"]);
});

test("Navigator answers mode shows answer units, not full artifact dump", () => {
	const artifacts = [
		artifact("r1", "response", 1),
		artifact("e1", "error", 2),
		artifact("c1", "command", 3),
	];
	const recalled = handleNavigatorIntent(initialNavigatorState(), artifacts, queue(), { kind: "setMode", mode: "answers" }).state;

	assert.equal(recalled.mode, "answers");
	assert.deepEqual(filteredReviewItems(recalled, artifacts).map((item) => item.artifact.id), ["r1"]);
});

test("Navigator Review queue prioritizes unresolved items over recent", () => {
	const recent = artifact("recent", "file", 30);
	const pinned = artifact("pinned", "response", 20);
	const needs = artifact("needs", "error", 10);
	const artifacts = [recent, pinned, needs];
	const view = navigatorViewModel(initialNavigatorState(), artifacts, queue([pinned.ref], [recent.ref]));

	assert.deepEqual(view.items.map((item) => item.artifact.id), ["needs", "pinned"]);
	assert.deepEqual(view.items.map((item) => item.bucket), ["needs", "pinned"]);
});

test("Navigator Review queue shows done items when all clear", () => {
	const older = artifact("older", "file", 10);
	const recent = artifact("recent", "file", 30);
	const artifacts = [older, recent];
	const view = navigatorViewModel(initialNavigatorState(), artifacts, queue([], [older.ref, recent.ref]));

	assert.deepEqual(view.items.map((item) => item.artifact.id), ["recent", "older"]);
	assert.deepEqual(view.items.map((item) => item.bucket), ["recent", "recent"]);
});

test("Navigator Review queue ranks attention before timestamp", () => {
	const artifacts = [
		artifact("error", "error", 30),
		artifact("question", "response", 10, { workerStatus: "needs_input", workerLabel: "w2" }),
	];
	const view = navigatorViewModel(initialNavigatorState(), artifacts);

	assert.deepEqual(view.items.map((item) => item.artifact.id), ["question", "error"]);
	assert.equal(view.items[0]?.primaryAction, "openVerdict");
	assert.equal(view.items[0]?.reasonId, "workerNeedsInput");
});

test("Navigator log mode restores access to non-Review artifacts grouped by episode", () => {
	const artifacts = [
		artifact("r1", "response", 1),
		artifact("f1", "file", 2, { tool: "edit" }),
		artifact("w1r1", "response", 5, {}, "w1"),
		artifact("w1f1", "file", 4, { tool: "edit" }, "w1"),
	];
	const log = handleNavigatorIntent({ ...initialNavigatorState(), source: { kind: "all" as const } }, artifacts, queue(), { kind: "setMode", mode: "log" }).state;

	assert.equal(log.mode, "log");
	assert.deepEqual(filteredReviewItems(log, artifacts).map((item) => item.artifact.id), ["r1", "f1", "w1f1", "w1r1"]);
});

test("Navigator search intent requests search", () => {
	const transition = handleNavigatorIntent(initialNavigatorState(), [], queue(), { kind: "search" });
	assert.deepEqual(transition.action, { action: "search" });
});

test("Navigator wraps source selectors", () => {
	const sources = availableSources([artifact("current", "file", 1), artifact("worker", "response", 2, {}, "w1")]);
	assert.deepEqual(sources.map(navigatorSourceLabel), ["current", "all", "w1"]);
	assert.equal(sameNavigatorSource(sources[0]!, { kind: "current" }), true);
	assert.equal(sameNavigatorSource(sources[2]!, { kind: "artifactSource", source: "w1" }), true);
});

function workerReadyArtifact(summary: string): { id: string; displayId: string; ref: string; kind: "response"; title: string; subtitle: string; body: string; timestamp: number; meta: Record<string, unknown>; source: string } {
	return {
		id: "status",
		displayId: "status",
		ref: "worker-status:w1:0",
		kind: "response",
		title: `w1 ready: Recommended workflow ToC, fewer commands, add GIFs`,
		subtitle: "README improvements review",
		body: `worker: w1\nstate: ready\ntask: README review\nmessage:\nRecommended:\n- short workflow-oriented table of contents\n- fewer commands in README\n- GIFs for core flows`,
		timestamp: 1000,
		meta: { workerStatus: "ready", workerLabel: "w1", summary: "Recommended:\n- short workflow-oriented table of contents\n- fewer commands in README\n- GIFs for core flows" },
		source: "w1",
	};
}

test("Worker ready card extracts headline, bullets, chip, and provenance", () => {
	const item = reviewItemForArtifact(workerReadyArtifact("ignored"));

	assert.equal(item.category, "ready-for-review");
	assert.equal(item.statusChip, "ready");
	assert.equal(item.provenance, "worker w1");
	assert.equal(item.headline.startsWith("w1 finished"), true, `unexpected headline ${item.headline}`);
	assert.deepEqual(item.recommendations, [
		"short workflow-oriented table of contents",
		"fewer commands in README",
		"GIFs for core flows",
	]);
});

test("Worker needs input card surfaces question as bullet and needs-decision category", () => {
	const item = reviewItemForArtifact({
		id: "status",
		displayId: "status",
		ref: "worker-status:w2:0",
		kind: "response",
		title: "w2 needs input: Which migration order should I use?",
		subtitle: "Migration audit",
		body: "worker: w2\nstate: needs_input\nmessage:\nWhich migration order should I use?",
		timestamp: 2000,
		meta: { workerStatus: "needs_input", workerLabel: "w2", question: "Which migration order should I use?" },
		source: "w2",
	});

	assert.equal(item.category, "needs-decision");
	assert.equal(item.statusChip, "needs reply");
	assert.equal(item.primaryAction, "openVerdict");
	assert.ok(item.headline.startsWith("w2 needs input"), `headline=${item.headline}`);
});

test("Worker failed card maps to failed-blocked", () => {
	const item = reviewItemForArtifact({
		id: "status",
		displayId: "status",
		ref: "worker-status:w3:0",
		kind: "error",
		title: "w3 failed: Migration command exited 1",
		subtitle: "Migration apply",
		body: "worker: w3\nstate: failed\nmessage:\nMigration command exited 1 · likely missing env var",
		timestamp: 3000,
		meta: { workerStatus: "failed", workerLabel: "w3", lastError: "Migration command exited 1 · likely missing env var" },
		source: "w3",
	});

	assert.equal(item.category, "failed-blocked");
	assert.equal(item.statusChip, "failed");
	assert.equal(item.primaryAction, "openVerdict");
	assert.ok(item.headline.startsWith("w3 failed"), `headline=${item.headline}`);
});

test("Changed file artifact with worker source maps to patch-proposed", () => {
	const item = reviewItemForArtifact({
		id: "f9",
		displayId: "f9",
		ref: "file:entry:f9",
		kind: "file",
		title: "src/auth.ts",
		subtitle: "",
		body: "edit",
		timestamp: 4000,
		meta: { tool: "edit", diff: "+ line" },
		source: "w2",
	});

	assert.equal(item.category, "patch-proposed");
	assert.equal(item.statusChip, "changed");
	assert.equal(item.headline, "Edited src/auth.ts");
});

test("Worker change set artifact maps to promoteable patch card", () => {
	const item = reviewItemForArtifact({
		id: "changes",
		displayId: "changes",
		ref: "worker-changes:w2:0",
		kind: "response",
		title: "w2 change set · 2 files",
		subtitle: "auth fix",
		body: "patch",
		timestamp: 4500,
		meta: { workerChangeSet: true, workerStatus: "ready", workerLabel: "w2", changedFiles: [{ path: "src/auth.ts", additions: 3, deletions: 1 }] },
		source: "w2",
	});

	assert.equal(item.category, "patch-proposed");
	assert.equal(item.statusChip, "change set");
	assert.equal(item.primaryAction, "openVerdict");
	assert.equal(item.actions.includes("promoteWorker"), true);
});

test("episodesFromItems groups current and worker artifacts and counts each", () => {
	const items = [
		reviewItemForArtifact(artifact("f1", "file", 10, { tool: "edit" })),
		reviewItemForArtifact(artifact("w1f1", "file", 20, { tool: "edit" }, "w1")),
		reviewItemForArtifact(artifact("w1r1", "response", 30, {}, "w1")),
		reviewItemForArtifact(artifact("w2r1", "response", 40, {}, "w2")),
	];
	const episodes = episodesFromItems(items);
	assert.deepEqual(episodes.map((ep) => ep.id), ["current", "w1", "w2"]);
	assert.deepEqual(episodes.map((ep) => ep.artifactCount), [1, 2, 1]);
	assert.equal(episodes[1]?.label, "Worker w1");
});

test("Error artifact maps to failed-blocked with error chip", () => {
	const item = reviewItemForArtifact(artifact("e1", "error", 5));
	assert.equal(item.category, "failed-blocked");
	assert.equal(item.statusChip, "error");
});
