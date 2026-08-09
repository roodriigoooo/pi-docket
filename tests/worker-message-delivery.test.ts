import test from "node:test";
import assert from "node:assert/strict";
import { messageDeliveredTransition } from "../extensions/worker-lifecycle.js";
import { workerUsesMailbox } from "../extensions/worker-store.js";
import { dockEventSubLine } from "../extensions/worker-activity.js";
import { buildWorkerMessage } from "../extensions/worker-mailbox.js";
import type { WorkerStatus } from "../extensions/background-work.js";

const base: WorkerStatus = {
	id: "worker-1",
	index: 1,
	tmuxSession: "docket-workers",
	task: "fix the failing auth test",
	cwd: "/repo",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	state: "needs_input",
	questions: [
		{ id: "q1", text: "Which config file?", createdAt: "2026-01-01T00:00:00.000Z" },
		{ id: "q2", text: "Update the tests too?", createdAt: "2026-01-01T00:01:00.000Z" },
	],
	question: "2 questions",
};

test("a bound answer resolves one question and leaves the worker blocked on the rest", () => {
	const patch = messageDeliveredTransition({ replyTo: "q2" })(base);

	assert.equal(patch?.state, "needs_input");
	assert.deepEqual(patch?.questions?.map((question) => question.id), ["q1"]);
	assert.equal(patch?.question, "Which config file?");
});

test("answering the last open question resumes the worker", () => {
	const single = { ...base, questions: [base.questions![1]!] };

	const patch = messageDeliveredTransition({ replyTo: "q2" })(single);

	assert.equal(patch?.state, "active");
	assert.deepEqual(patch?.questions, []);
});

test("an unbound message redirects the worker and clears its backlog", () => {
	const patch = messageDeliveredTransition()(base);

	assert.equal(patch?.state, "active");
	assert.deepEqual(patch?.questions, []);
	assert.equal(patch?.question, undefined);
});

test("an answer naming a question that is already gone still resumes the worker", () => {
	const patch = messageDeliveredTransition({ replyTo: "q9" })(base);

	assert.equal(patch?.state, "active");
	assert.deepEqual(patch?.questions, []);
});

test("delivering to a terminal worker changes nothing", () => {
	for (const state of ["ready", "failed", "error", "ended"] as const) {
		assert.equal(messageDeliveredTransition()({ ...base, state }), undefined, state);
		assert.equal(messageDeliveredTransition({ replyTo: "q1" })({ ...base, state }), undefined, state);
	}
});

test("the transport is chosen from what the worker advertised, not from hope", () => {
	// A live reader: queue it.
	assert.equal(workerUsesMailbox({ mailboxAt: "2026-01-01T00:00:00.000Z", heartbeatAt: "2026-01-01T00:00:05.000Z" }), true);
	// Still booting — no heartbeat yet — so a current build will drain the inbox on start.
	assert.equal(workerUsesMailbox({}), true);
	// Proven running and never advertised a mailbox: a pre-mailbox build.
	assert.equal(workerUsesMailbox({ heartbeatAt: "2026-01-01T00:00:05.000Z" }), false);
});

test("an untaken message outranks every other dock hint", () => {
	const queued = [buildWorkerMessage({ body: "focus on src/auth" })!];
	const stale = { ...base, state: "needs_input" as const, updatedAt: "2020-01-01T00:00:00.000Z" };

	const line = dockEventSubLine([], "needs_input", { worker: stale, messages: queued, now: Date.now() });

	assert.match(line!, /^1 message queued/);
});

test("a stopped worker's inbox reports as undeliverable rather than pending", () => {
	const queued = [buildWorkerMessage({ body: "focus on src/auth" })!];

	const line = dockEventSubLine([], "failed", { worker: { ...base, state: "failed" }, messages: queued });

	assert.match(line!, /undeliverable · worker is not running/);
});

test("delivered messages leave the dock exactly as quiet as before", () => {
	const delivered = [{ ...buildWorkerMessage({ body: "focus on src/auth" })!, delivery: "delivered" as const }];

	assert.equal(dockEventSubLine([], "thinking", { worker: { ...base, state: "active" }, messages: delivered, now: Date.parse(base.updatedAt) }), undefined);
});
