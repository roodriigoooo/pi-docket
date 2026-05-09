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

test("Navigator recall mode shows answer units, not full artifact dump", () => {
	const artifacts = [
		artifact("r1", "response", 1),
		artifact("e1", "error", 2, { trailBucket: "needs" }),
		artifact("c1", "command", 3),
	];
	const recalled = handleNavigatorKey(initialNavigatorState(), artifacts, {
		raw: "/",
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

test("Navigator working set sorts needs, pinned, recent", () => {
	const artifacts = [
		artifact("recent", "file", 30, { trailBucket: "recent" }),
		artifact("pinned", "response", 20, { trailBucket: "pinned" }),
		artifact("needs", "error", 10, { trailBucket: "needs" }),
	];
	const view = navigatorViewModel(initialNavigatorState(), artifacts);
	assert.deepEqual(view.items.map((a) => a.id), ["needs", "pinned", "recent"]);
});

test("Navigator all mode restores access to non-working artifacts", () => {
	const artifacts = [
		artifact("r1", "response", 1),
		artifact("f1", "file", 2, { trailBucket: "needs" }),
	];
	const all = handleNavigatorKey(initialNavigatorState(), artifacts, {
		raw: "a",
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
