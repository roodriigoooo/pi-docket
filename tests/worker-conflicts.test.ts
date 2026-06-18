import test from "node:test";
import assert from "node:assert/strict";
import { conflictSummary, workerConflictMap, workerEditedFiles } from "../extensions/worker-conflicts.js";
import type { WorkerStatus } from "../extensions/background-work.js";
import type { Artifact } from "../extensions/types.js";

function worker(id: string, index: number): WorkerStatus {
	return {
		id,
		index,
		tmuxSession: `docket-workers:w${index}`,
		task: "edit shared file",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "ready",
	};
}

function file(tool: "edit" | "write" | "read", path: string): Artifact {
	return {
		id: `${tool}-${path}`,
		displayId: `${tool}-${path}`,
		ref: `${tool}:${path}:0`,
		kind: "file",
		title: `${tool} ${path}`,
		subtitle: "",
		body: "",
		meta: { tool, args: { path } },
	};
}

test("workerEditedFiles includes edits, writes, and change-set metadata", () => {
	const changeSet: Artifact = {
		id: "changes",
		displayId: "changes",
		ref: "worker-changes:w1:0",
		kind: "response",
		title: "w1 change set",
		subtitle: "",
		body: "",
		meta: { changedFiles: [{ path: "src/from-diff.ts" }] },
	};
	assert.deepEqual(workerEditedFiles([file("edit", "./src/a.ts"), file("write", "src/b.ts"), file("read", "src/c.ts"), changeSet]), ["src/a.ts", "src/b.ts", "src/from-diff.ts"]);
});

test("workerConflictMap reports peer file overlaps", () => {
	const w1 = worker("one", 1);
	const w2 = worker("two", 2);
	const w3 = worker("three", 3);
	const artifacts = new Map<string, Artifact[]>([
		[w1.id, [file("edit", "src/shared.ts"), file("edit", "src/only-one.ts")]],
		[w2.id, [file("write", "src/shared.ts")]],
		[w3.id, [file("edit", "src/other.ts")]],
	]);
	const conflicts = workerConflictMap([w1, w2, w3], artifacts);

	assert.deepEqual(conflicts.get(w1.id), [{ workerId: w2.id, workerLabel: "w2", files: ["src/shared.ts"] }]);
	assert.deepEqual(conflicts.get(w2.id), [{ workerId: w1.id, workerLabel: "w1", files: ["src/shared.ts"] }]);
	assert.equal(conflicts.get(w3.id), undefined);
	assert.equal(conflictSummary(conflicts.get(w1.id) ?? []), "overlap w2: src/shared.ts");
});
