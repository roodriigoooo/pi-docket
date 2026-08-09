import test from "node:test";
import assert from "node:assert/strict";
import { conflictSummary, workerConflictMap, workerEditedFiles, workerFileRoot } from "../extensions/worker-conflicts.js";
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

test("a worker's own workspace prefix is not part of the path it shares with anyone", () => {
	const inWorktree: WorkerStatus = { ...worker("one", 1), worktree: { path: "/workers/one/workspace", baseCwd: "/repo" } };
	const files = workerEditedFiles([file("edit", "/workers/one/workspace/src/shared.ts")], workerFileRoot(inWorktree));

	assert.deepEqual(files, ["src/shared.ts"]);
	// The worktree is where the worker actually writes; cwd only answers when it has none.
	assert.equal(workerFileRoot(inWorktree), "/workers/one/workspace");
	assert.equal(workerFileRoot(worker("two", 2)), "/repo");
});

test("a live worker's absolute edits still overlap a peer's frozen change set", () => {
	// The case the verdict card used to miss: one worker has published (repo-relative paths in a
	// frozen change set), the other is still editing (absolute paths inside its own workspace).
	const publisher = worker("publisher", 3);
	const editor: WorkerStatus = { ...worker("editor", 2), worktree: { path: "/workers/editor/workspace", baseCwd: "/repo" } };
	const frozen: Artifact = {
		id: "changes",
		displayId: "changes",
		ref: "worker-changes:w3:0",
		kind: "response",
		title: "w3 change set",
		subtitle: "",
		body: "",
		meta: { workerChangeSet: true, deliverableRef: "worker-deliverable:w3:1", changedFiles: [{ path: "src/api/limit.ts" }] },
	};
	const conflicts = workerConflictMap([publisher, editor], new Map<string, Artifact[]>([
		[publisher.id, [frozen]],
		[editor.id, [file("edit", "/workers/editor/workspace/src/api/limit.ts")]],
	]));

	assert.deepEqual(conflicts.get(publisher.id), [{ workerId: editor.id, workerLabel: "w2", files: ["src/api/limit.ts"] }]);
	assert.deepEqual(conflicts.get(editor.id), [{ workerId: publisher.id, workerLabel: "w3", files: ["src/api/limit.ts"] }]);
});
