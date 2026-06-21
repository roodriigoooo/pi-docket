import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkerStatus } from "../extensions/background-work.js";
import type { Artifact } from "../extensions/types.js";
import { formatHunkReviewComments, launchHunkPatch, parseHunkComments, reviewWorkerChangeSetInHunk, workerChangeSetPatch } from "../extensions/worker-diff-review.js";

const patch = "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 1,
		tmuxSession: "docket-workers:w1",
		task: "patch app",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "ready",
		...partial,
	};
}

function changeSet(body = `worker: w1\n\nPatch:\n${patch}\n`): Artifact {
	return {
		id: "changes",
		displayId: "changes",
		ref: "worker-changes:worker-1:0",
		kind: "response",
		title: "w1 change set",
		subtitle: "patch app",
		body,
		timestamp: 1,
		meta: { workerChangeSet: true, workerId: "worker-1" },
	};
}

test("parseHunkComments accepts camelCase, snake_case, and wrapped payloads", () => {
	const comments = parseHunkComments(JSON.stringify({
		comments: [
			{ id: "a", filePath: "src/app.ts", newLine: 12, summary: "tighten guard", rationale: "avoids null" },
			{ file_path: "src/old.ts", old_line: "4", comment: "remove dead branch" },
			{ file: "src/empty.ts", new_line: 5, body: "" },
		],
	}));

	assert.deepEqual(comments, [
		{ id: "a", filePath: "src/app.ts", newLine: 12, summary: "tighten guard", rationale: "avoids null" },
		{ filePath: "src/old.ts", oldLine: 4, summary: "remove dead branch" },
	]);
});

test("workerChangeSetPatch extracts exact patch after Patch marker", () => {
	assert.equal(workerChangeSetPatch(changeSet()), patch);
	assert.equal(workerChangeSetPatch(changeSet("worker: w1\nno patch")), undefined);
});

test("formatHunkReviewComments creates revision message for worker", () => {
	const text = formatHunkReviewComments([
		{ filePath: "src/app.ts", newLine: 12, summary: "tighten guard", rationale: "avoids null" },
		{ filePath: "src/old.ts", oldLine: 4, summary: "remove dead branch" },
	]);

	assert.match(text, /^revise from Hunk review \(2 comments\):/);
	assert.match(text, /1\. src\/app\.ts:12\n   tighten guard\n   rationale: avoids null/);
	assert.match(text, /2\. src\/old\.ts:4 \(old line\)\n   remove dead branch/);
	assert.match(text, /Please address these comments/);
});

test("launchHunkPatch writes patch file for Hunk and harvests comments", async () => {
	const dir = await mkdtemp(join(tmpdir(), "docket-hunk-"));
	const capture = join(dir, "patch.txt");
	const argCapture = join(dir, "patch-arg.txt");
	const comments = join(dir, "comments.json");
	const hunk = join(dir, "hunk");
	await writeFile(comments, JSON.stringify([{ filePath: "src/app.ts", newLine: 8, summary: "review note" }]), "utf8");
	await writeFile(hunk, `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "patch" ]; then printf '%s' "$2" > "$HUNK_ARG_CAPTURE"; cat "$2" > "$HUNK_CAPTURE"; exit 0; fi
if [ "$1" = "session" ]; then cat "$HUNK_COMMENTS"; exit 0; fi
exit 1
`, "utf8");
	chmodSync(hunk, 0o755);

	const result = await launchHunkPatch(dir, patch, { hunkBin: hunk, env: { ...process.env, HUNK_CAPTURE: capture, HUNK_ARG_CAPTURE: argCapture, HUNK_COMMENTS: comments } });

	assert.equal(result.available, true);
	assert.deepEqual(result.comments, [{ filePath: "src/app.ts", newLine: 8, summary: "review note" }]);
	const fs = await import("node:fs/promises");
	assert.equal(await fs.readFile(capture, "utf8"), patch);
	const patchArg = await fs.readFile(argCapture, "utf8");
	assert.notEqual(patchArg, "-");
	await assert.rejects(fs.stat(patchArg));
});

test("reviewWorkerChangeSetInHunk uses worker workspace and exact change-set patch", async () => {
	const dir = await mkdtemp(join(tmpdir(), "docket-hunk-worktree-"));
	const capture = join(dir, "patch.txt");
	const comments = join(dir, "comments.json");
	const hunk = join(dir, "hunk");
	await writeFile(comments, "[]", "utf8");
	await writeFile(hunk, `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "patch" ]; then pwd > "$HUNK_CAPTURE.cwd"; cat "$2" > "$HUNK_CAPTURE"; exit 0; fi
if [ "$1" = "session" ]; then cat "$HUNK_COMMENTS"; exit 0; fi
exit 1
`, "utf8");
	chmodSync(hunk, 0o755);

	const result = await reviewWorkerChangeSetInHunk(worker({ worktree: { path: dir, baseCwd: "/repo" } }), changeSet(), { hunkBin: hunk, env: { ...process.env, HUNK_CAPTURE: capture, HUNK_COMMENTS: comments } });

	assert.equal(result.available, true);
	assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(`${capture}.cwd`, "utf8")), `${await realpath(dir)}\n`);
	assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(capture, "utf8")), patch);
});
