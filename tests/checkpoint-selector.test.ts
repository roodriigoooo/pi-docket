import test from "node:test";
import assert from "node:assert/strict";
import {
	checkpointSelectionStats,
	initialCheckpointSelection,
	selectAllCheckpointArtifacts,
	selectNoCheckpointArtifacts,
	selectedCheckpointArtifacts,
	toggleCheckpointSelection,
} from "../extensions/checkpoint-selector.js";
import type { Artifact } from "../extensions/types.js";

const artifacts: Artifact[] = [
	{ id: "e1", displayId: "e1", ref: "error:t1:0", kind: "error", title: "bash failed", subtitle: "npm test", body: "boom" },
	{ id: "f2", displayId: "f2", ref: "file:t2:0", kind: "file", title: "edit src/a.ts", subtitle: "1 edit", body: "changed file" },
];

test("checkpoint selection helpers default to all artifacts selected", () => {
	const state = initialCheckpointSelection(artifacts);
	assert.deepEqual(state.checked, [true, true]);
	assert.deepEqual(selectedCheckpointArtifacts(artifacts, state).map((artifact) => artifact.ref), ["error:t1:0", "file:t2:0"]);
});

test("checkpoint selection helpers toggle, clear, select all, and estimate tokens", () => {
	let state = initialCheckpointSelection(artifacts);
	state = toggleCheckpointSelection(state, 0);
	assert.deepEqual(selectedCheckpointArtifacts(artifacts, state).map((artifact) => artifact.ref), ["file:t2:0"]);

	state = selectNoCheckpointArtifacts(state);
	assert.deepEqual(selectedCheckpointArtifacts(artifacts, state), []);
	assert.deepEqual(checkpointSelectionStats(artifacts, state), { total: 2, selected: 0, estimatedTokens: 0 });

	state = selectAllCheckpointArtifacts(state);
	const stats = checkpointSelectionStats(artifacts, state);
	assert.equal(stats.total, 2);
	assert.equal(stats.selected, 2);
	assert.ok(stats.estimatedTokens > 0);
});
