import test from "node:test";
import assert from "node:assert/strict";
import { parseBulletin } from "../extensions/worker-bulletin.js";
import { buildWorkerTaskDocument } from "../extensions/background-work.js";
import { buildWorkerMessage, workerMessageRedirects } from "../extensions/worker-mailbox.js";
import { messageDeliveredTransition } from "../extensions/worker-lifecycle.js";
import type { WorkerStatus } from "../extensions/background-work.js";

test("a bulletin written before the journal existed is still readable", () => {
	// The only reason this format survives: reading an existing one once, so a project's standing
	// notes are not silently dropped by an upgrade. Nothing writes it any more — a second writer
	// would produce a file the journal's migration would import again on the next upgrade.
	const legacy = [
		"# Docket bulletin",
		"",
		"## 2026-01-02T00:00:00.000Z · from you",
		"",
		"line one\nline two",
		"",
		"## 2026-01-01T00:00:00.000Z · from w2",
		"",
		"auth middleware changed",
		"",
	].join("\n");

	assert.deepEqual(parseBulletin(legacy), [
		{ at: "2026-01-02T00:00:00.000Z", from: "you", text: "line one\nline two" },
		{ at: "2026-01-01T00:00:00.000Z", from: "w2", text: "auth middleware changed" },
	]);
	assert.deepEqual(parseBulletin("no entries here"), []);
});

test("a worker is pointed at the journal by absolute path, and only when there is one", () => {
	const withJournal = buildWorkerTaskDocument({ task: "fix auth", bulletinPath: "/agent/docket/bulletins/repo.md" });
	assert.match(withJournal, /Project journal: \/agent\/docket\/bulletins\/repo\.md/);
	assert.match(withJournal, /Read it before your first edit/);
	// A worker in an isolated worktree reading "these files changed" would otherwise re-read its
	// own stale copy, see the old bytes, and conclude nothing happened.
	assert.match(withJournal, /your isolated workspace does not contain them/);

	assert.equal(/Project journal/.test(buildWorkerTaskDocument({ task: "fix auth" })), false);
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
