import test from "node:test";
import assert from "node:assert/strict";
import { deriveWorkerState, type WorkerStatus } from "../extensions/background-work.js";
import {
	WORKER_GONE_AFTER_MS,
	isAttentionWorker,
	isReviewableWorker,
	processExitedTransition,
	workerIsGone,
	workerLiveness,
	workerReportedDone,
} from "../extensions/worker-lifecycle.js";
import { pendingWorkerMessageLine, sentWorkerMessageChipSubject, sentWorkerMessageIsStuck, sentWorkerMessageStateLabel, sentWorkerMessageTimeline, workerMessageDeliveryGlyph, type WorkerMessage } from "../extensions/worker-mailbox.js";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "w1-abcd",
		index: 1,
		tmuxSession: "docket-workers",
		task: "add a per-tenant rate limit",
		cwd: "/tmp/orchard",
		createdAt: "2026-01-01T11:00:00.000Z",
		updatedAt: "2026-01-01T11:58:00.000Z",
		heartbeatAt: new Date(NOW - 5_000).toISOString(),
		state: "active",
		...partial,
	};
}

function message(partial: Partial<WorkerMessage> = {}): WorkerMessage {
	return {
		id: "msg-0000000000001-000000-abc",
		kind: "directive",
		from: "human",
		body: "the runbook should mention the new context arg",
		deliverAs: "steer",
		createdAt: "2026-01-01T11:59:00.000Z",
		delivery: "queued",
		...partial,
	};
}

test("liveness is an observation, and absence of proof is not proof of life", () => {
	assert.equal(workerLiveness(worker(), NOW), "live");
	// A worker that reported done keeps beating while its pi is open.
	assert.equal(workerLiveness(worker({ state: "ready", summary: "done" }), NOW), "live");
	// Statuses written before heartbeats existed prove nothing either way, and `unknown` must
	// never be rounded up to `live` — that rounding is the claim ADR-0008 removed.
	assert.equal(workerLiveness(worker({ heartbeatAt: undefined }), NOW), "unknown");
	assert.equal(workerIsGone(worker({ heartbeatAt: undefined }), NOW), false);
	assert.equal(workerLiveness(worker({ exitedAt: "2026-01-01T11:59:00.000Z" }), NOW), "gone");
	assert.equal(workerLiveness(worker({ state: "ended" }), NOW), "gone");
	assert.equal(workerLiveness(worker({ heartbeatAt: new Date(NOW - WORKER_GONE_AFTER_MS - 1).toISOString() }), NOW), "gone");
});

test("a worker that finished and was then quit is ready to review and gone, not both-or-neither", () => {
	const finishedThenQuit = worker({ state: "ready", summary: "stopped without edits", exitedAt: "2026-01-01T11:59:30.000Z" });

	// The work still stands: quitting the session did not withdraw the deliverable.
	assert.equal(deriveWorkerState(finishedThenQuit, NOW), "ready");
	assert.equal(isReviewableWorker(finishedThenQuit, NOW), true);
	// And it is unreachable, which is the fact every surface used to drop.
	assert.equal(workerIsGone(finishedThenQuit, NOW), true);
});

test("session end never overwrites what a worker reported", () => {
	// This is the transition the worker's own runtime applies when its pi exits. Patching
	// `state` directly here is what turned `ready` into `ended`, which then read as `ready`
	// again by way of artifact count — a round trip that lost the only fact that mattered.
	assert.equal(processExitedTransition(0)(worker({ state: "ready", summary: "done" })), undefined);
	assert.deepEqual(processExitedTransition(0)(worker({ state: "active" })), { state: "ended" });
});

test("only a reported outcome earns ready; a stopped process says so", () => {
	assert.equal(workerReportedDone(worker({ state: "ended", artifactCount: 40 })), false);
	assert.equal(deriveWorkerState(worker({ state: "ended", artifactCount: 40 }), NOW), "stopped");
	assert.equal(deriveWorkerState(worker({ state: "ended", artifactCount: 40, outcome: "completed" }), NOW), "ready");

	const stopped = worker({ state: "ended", artifactCount: 40 });
	// Openable, so its evidence and diff stay reachable...
	assert.equal(isReviewableWorker(stopped, NOW), true);
	// ...but not news: a worker the human stopped never colours the dock or earns a chip.
	assert.equal(isAttentionWorker(stopped, NOW), false);
});

test("an undeliverable message says so on the chip the human is looking at", () => {
	const queued = message();

	assert.equal(sentWorkerMessageStateLabel("inbox", queued, false), "queued");
	assert.equal(sentWorkerMessageStateLabel("inbox", queued, true), "undeliverable · worker is not running");
	// Before the message file has been read back, the worker's liveness is still known.
	assert.equal(sentWorkerMessageStateLabel("inbox", undefined, true), "undeliverable · worker is not running");
	assert.equal(sentWorkerMessageIsStuck("inbox", queued, true), true);
	assert.equal(sentWorkerMessageIsStuck("inbox", message({ delivery: "read" }), true), false);
	// A legacy tmux send is unobservable in both directions and must not borrow either claim.
	assert.equal(sentWorkerMessageIsStuck("tmux", queued, true), false);
});

test("a stuck message names the one action that unsticks it", () => {
	const timeline = sentWorkerMessageTimeline("inbox", message(), { workerIsGone: true, workerLabel: "w2" });

	assert.match(timeline!, /^queued /);
	assert.match(timeline!, /\/docket respawn w2 delivers it$/);
	// Nothing is added while delivery is proceeding normally.
	assert.doesNotMatch(sentWorkerMessageTimeline("inbox", message({ delivery: "read", readAt: "2026-01-01T11:59:30.000Z" }), { workerIsGone: false })!, /respawn/);
});

test("a sent message reads as correspondence, and the tick never replaces the word", () => {
	const queued = message();
	const delivered = message({ delivery: "delivered", deliveredAt: "2026-01-01T11:59:20.000Z" });
	const read = message({ delivery: "read", deliveredAt: "2026-01-01T11:59:20.000Z", readAt: "2026-01-01T11:59:30.000Z" });

	// One tick sent, two arrived — the vocabulary every messaging client already taught its users.
	assert.equal(workerMessageDeliveryGlyph("queued"), "✓");
	assert.equal(workerMessageDeliveryGlyph("delivered"), "✓✓");
	assert.equal(workerMessageDeliveryGlyph("read"), "✓✓");
	assert.equal(workerMessageDeliveryGlyph("undeliverable"), "⚠");

	// Direction, correspondent, state, time — a row in a mail client, not a log line.
	assert.match(sentWorkerMessageChipSubject("w2", "inbox", queued), /^→ w2 · ✓ queued · /);
	assert.match(sentWorkerMessageChipSubject("w2", "inbox", delivered), /^→ w2 · ✓✓ delivered · /);
	assert.match(sentWorkerMessageChipSubject("w2", "inbox", read), /^→ w2 · ✓✓ read · /);
	// A tick nobody can decode is worse than a word nobody shortened, so both always travel.
	for (const live of [queued, delivered, read]) {
		assert.match(sentWorkerMessageChipSubject("w2", "inbox", live), /queued|delivered|read/);
	}

	assert.match(sentWorkerMessageChipSubject("w2", "inbox", queued, true), /^→ w2 · ⚠ undeliverable · worker is not running/);
	// The legacy path borrows neither the ticks nor the language of a delivered message.
	assert.match(sentWorkerMessageChipSubject("w2", "tmux", undefined), /^→ w2 · ↗ sent to terminal · receipt unconfirmed/);
});

test("the dock and the chip agree about the same message", () => {
	const messages = [message()];

	assert.equal(pendingWorkerMessageLine(messages, true), "1 message undeliverable · worker is not running");
	assert.equal(sentWorkerMessageStateLabel("inbox", messages[0], true), "undeliverable · worker is not running");
	assert.equal(pendingWorkerMessageLine(messages, false), "1 message queued · not taken yet");
	assert.equal(sentWorkerMessageStateLabel("inbox", messages[0], false), "queued");
});
