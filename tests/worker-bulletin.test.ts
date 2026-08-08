import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendBulletinEntry, bulletinExistsSync, bulletinFile, parseBulletin, readBulletinEntries, renderBulletin } from "../extensions/worker-bulletin.js";
import { buildWorkerTaskDocument } from "../extensions/background-work.js";
import { buildWorkerMessage, workerMessageRedirects } from "../extensions/worker-mailbox.js";
import { messageDeliveredTransition } from "../extensions/worker-lifecycle.js";
import type { WorkerStatus } from "../extensions/background-work.js";

test("the bulletin lives outside the repo so every worktree reads the same file", () => {
	const file = bulletinFile("/agent/docket", "/Users/me/Code/my project");

	assert.match(file, /^\/agent\/docket\/bulletins\//);
	assert.match(path.basename(file), /^[a-zA-Z0-9_-]+\.md$/);
});

test("entries render newest first and say who wrote them", () => {
	const markdown = renderBulletin([
		{ at: "2026-01-02T00:00:00.000Z", from: "you", text: "we standardised on the context arg" },
		{ at: "2026-01-01T00:00:00.000Z", from: "w2", text: "auth middleware changed" },
	]);

	assert.ok(markdown.indexOf("standardised") < markdown.indexOf("auth middleware"));
	assert.match(markdown, /from you/);
	assert.match(markdown, /from w2/);
	assert.match(markdown, /newest first/);
});

test("what is written can be read back", () => {
	const entries = [
		{ at: "2026-01-02T00:00:00.000Z", from: "you", text: "line one\nline two" },
		{ at: "2026-01-01T00:00:00.000Z", from: "w2", text: "auth middleware changed" },
	];

	assert.deepEqual(parseBulletin(renderBulletin(entries)), entries);
	assert.deepEqual(parseBulletin("no entries here"), []);
});

test("appending prepends and survives a missing file", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "docket-bulletin-"));
	try {
		const file = bulletinFile(root, "/repo");
		assert.equal(bulletinExistsSync(file), false);
		assert.deepEqual(await readBulletinEntries(file), []);

		await appendBulletinEntry(file, { at: "2026-01-01T00:00:00.000Z", from: "w2", text: "auth middleware changed" });
		await appendBulletinEntry(file, { at: "2026-01-02T00:00:00.000Z", from: "you", text: "standardised on the context arg" });

		const entries = await readBulletinEntries(file);
		assert.deepEqual(entries.map((entry) => entry.from), ["you", "w2"]);
		assert.equal(bulletinExistsSync(file), true);
		assert.match(await readFile(file, "utf8"), /# Docket bulletin/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a worker is pointed at the bulletin by absolute path, and only when there is one", () => {
	const withBulletin = buildWorkerTaskDocument({ task: "fix auth", bulletinPath: "/agent/docket/bulletins/repo.md" });
	assert.match(withBulletin, /Project bulletin: \/agent\/docket\/bulletins\/repo\.md/);
	assert.match(withBulletin, /Read it before your first edit/);

	assert.equal(/Project bulletin/.test(buildWorkerTaskDocument({ task: "fix auth" })), false);
});

const blocked: WorkerStatus = {
	id: "worker-1",
	index: 1,
	tmuxSession: "docket-workers",
	task: "wire the auth middleware",
	cwd: "/repo",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	state: "needs_input",
	questions: [{ id: "q1", text: "which config?", createdAt: "2026-01-01T00:00:00.000Z" }],
};

test("a broadcast defaults to not interrupting", () => {
	assert.equal(buildWorkerMessage({ body: "middleware changed", kind: "broadcast" })?.deliverAs, "nextTurn");
	assert.equal(buildWorkerMessage({ body: "focus on auth" })?.deliverAs, "steer");
});

test("a broadcast never redirects the worker it reaches", () => {
	const broadcast = buildWorkerMessage({ body: "middleware changed", kind: "broadcast" })!;
	const directive = buildWorkerMessage({ body: "focus on auth" })!;

	assert.equal(workerMessageRedirects(broadcast), false);
	assert.equal(workerMessageRedirects(directive), true);

	// The blocked worker must still be blocked on its question afterwards.
	assert.equal(messageDeliveredTransition({ redirects: false })(blocked), undefined);
	assert.equal(messageDeliveredTransition({ redirects: true })(blocked)?.state, "active");
});
