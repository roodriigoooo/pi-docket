import test from "node:test";
import assert from "node:assert/strict";
import { filteredArtifacts, handleNavigatorKey, initialNavigatorState, navigatorViewModel } from "../extensions/trail-navigator.js";
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

test("Navigator defaults to sparse working set with preview off", () => {
	const state = initialNavigatorState();
	const artifacts = [
		artifact("r1", "response", 1),
		artifact("f1", "file", 2, { trailBucket: "needs" }),
		artifact("p1", "prompt", 3),
	];

	assert.equal(state.mode, "work");
	assert.equal(state.showDetail, false);
	assert.deepEqual(filteredArtifacts(state, artifacts).map((a) => a.id), ["f1"]);
});

test("Navigator memory mode shows answer units, not full artifact dump", () => {
	const artifacts = [
		artifact("r1", "response", 1),
		artifact("e1", "error", 2, { trailBucket: "needs" }),
		artifact("c1", "command", 3),
	];
	const recalled = handleNavigatorKey(initialNavigatorState(), artifacts, {
		raw: "m",
		isDown: false,
		isUp: false,
		isEnter: false,
		isTab: false,
		isEscape: false,
		isCtrlC: false,
	}).state;

	assert.equal(recalled.mode, "recall");
	assert.deepEqual(filteredArtifacts(recalled, artifacts).map((a) => a.id), ["r1"]);
});

test("Navigator review queue prioritizes unresolved items over recent", () => {
	const artifacts = [
		artifact("recent", "file", 30, { trailBucket: "recent" }),
		artifact("pinned", "response", 20, { trailBucket: "pinned" }),
		artifact("needs", "error", 10, { trailBucket: "needs" }),
	];
	const view = navigatorViewModel(initialNavigatorState(), artifacts);
	assert.deepEqual(view.items.map((a) => a.id), ["needs", "pinned"]);
});

test("Navigator review queue shows recent items when all clear", () => {
	const artifacts = [
		artifact("older", "file", 10, { trailBucket: "recent" }),
		artifact("recent", "file", 30, { trailBucket: "recent" }),
	];
	const view = navigatorViewModel(initialNavigatorState(), artifacts);
	assert.deepEqual(view.items.map((a) => a.id), ["recent", "older"]);
});

test("Navigator review queue ranks attention before timestamp", () => {
	const artifacts = [
		artifact("error", "error", 30, { trailBucket: "needs", trailAttentionRank: 2 }),
		artifact("question", "response", 10, { trailBucket: "needs", trailAttentionRank: 0 }),
	];
	const view = navigatorViewModel(initialNavigatorState(), artifacts);
	assert.deepEqual(view.items.map((a) => a.id), ["question", "error"]);
});

test("Navigator all mode restores access to non-working artifacts", () => {
	const artifacts = [
		artifact("r1", "response", 1),
		artifact("f1", "file", 2, { trailBucket: "needs" }),
	];
	const all = handleNavigatorKey(initialNavigatorState(), artifacts, {
		raw: "A",
		isDown: false,
		isUp: false,
		isEnter: false,
		isTab: false,
		isEscape: false,
		isCtrlC: false,
	}).state;

	assert.equal(all.mode, "all");
	assert.deepEqual(filteredArtifacts(all, artifacts).map((a) => a.id), ["r1", "f1"]);
});

test("Navigator slash requests search", () => {
	const transition = handleNavigatorKey(initialNavigatorState(), [], {
		raw: "/",
		isDown: false,
		isUp: false,
		isEnter: false,
		isTab: false,
		isEscape: false,
		isCtrlC: false,
	});
	assert.deepEqual(transition.action, { action: "search" });
});
