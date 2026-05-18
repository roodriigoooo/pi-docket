import test from "node:test";
import assert from "node:assert/strict";
import { heartbeatArtifactSignature, HEARTBEAT_ARTIFACT_CAP } from "../extensions/background-work.js";
import type { Artifact } from "../extensions/types.js";

function artifact(ref: string, timestamp: number): Artifact {
	return { id: ref, displayId: ref, ref, kind: "response", title: ref, subtitle: "", body: "", timestamp };
}

test("heartbeatArtifactSignature stays stable when artifacts unchanged", () => {
	const list = [artifact("r1", 1000), artifact("r2", 2000)];
	assert.equal(heartbeatArtifactSignature(list), heartbeatArtifactSignature(list));
});

test("heartbeatArtifactSignature changes on new last artifact", () => {
	const before = [artifact("r1", 1000)];
	const after = [artifact("r1", 1000), artifact("r2", 2000)];
	assert.notEqual(heartbeatArtifactSignature(before), heartbeatArtifactSignature(after));
});

test("heartbeatArtifactSignature changes when last timestamp changes", () => {
	const before = [artifact("r1", 1000)];
	const after = [artifact("r1", 9999)];
	assert.notEqual(heartbeatArtifactSignature(before), heartbeatArtifactSignature(after));
});

test("HEARTBEAT_ARTIFACT_CAP is a sane cap", () => {
	assert.equal(typeof HEARTBEAT_ARTIFACT_CAP, "number");
	assert.equal(HEARTBEAT_ARTIFACT_CAP > 0, true);
	assert.equal(HEARTBEAT_ARTIFACT_CAP <= 1000, true);
});
