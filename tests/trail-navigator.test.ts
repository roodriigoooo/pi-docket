import test from "node:test";
import assert from "node:assert/strict";
import { availableSources, filteredReviewItems, handleNavigatorIntent, initialNavigatorState, navigatorSourceLabel, navigatorViewModel, sameNavigatorSource } from "../extensions/trail-navigator.js";
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

test("Navigator defaults to sparse Review with preview off", () => {
	const state = initialNavigatorState();
	const artifacts = [
		artifact("r1", "response", 1),
		artifact("f1", "file", 2, { tool: "edit" }),
		artifact("p1", "prompt", 3),
	];

	assert.equal(state.mode, "review");
	assert.equal(state.showDetail, false);
	assert.deepEqual(filteredReviewItems(state, artifacts).map((item) => item.artifact.id), ["f1"]);
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
	assert.equal(view.items[0]?.primaryAction, "tellWorker");
	assert.equal(view.items[0]?.reasonId, "workerNeedsInput");
});

test("Navigator all mode restores access to non-Review artifacts", () => {
	const artifacts = [
		artifact("r1", "response", 1),
		artifact("f1", "file", 2, { tool: "edit" }),
	];
	const all = handleNavigatorIntent(initialNavigatorState(), artifacts, queue(), { kind: "setMode", mode: "all" }).state;

	assert.equal(all.mode, "all");
	assert.deepEqual(filteredReviewItems(all, artifacts).map((item) => item.artifact.id), ["r1", "f1"]);
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
