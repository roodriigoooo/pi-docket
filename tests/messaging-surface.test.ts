import test from "node:test";
import assert from "node:assert/strict";
import { BROADCAST_ADVISOR_TIMEOUT_MS, installDocketExtensionSurface, messageObservationFromEvent, type BroadcastAdvisorInput, type WorkerMessageObservation } from "../extensions/docket-extension-surface.js";
import { createWorkerKindRegistry } from "../extensions/worker-kinds.js";
import { applyBroadcastSuggestions, type BroadcastRecipient } from "../extensions/worker-broadcast.js";
import { docketMessageChipIsFinal, type DocketMessageDetails } from "../extensions/docket.js";
import type { WorkerMessage } from "../extensions/worker-mailbox.js";
import type { WorkerStatus } from "../extensions/background-work.js";

function surface() {
	return installDocketExtensionSurface(createWorkerKindRegistry());
}

const messageEvent = {
	ts: 1_700_000_000_000,
	kind: "message" as const,
	payload: { direction: "in", id: "msg-1", kind: "answer", from: "parent-agent", delivery: "delivered", transport: "inbox", replyTo: "q2" },
};

test("a message event decodes into an observation without carrying the body", () => {
	const observation = messageObservationFromEvent("worker-1", messageEvent);

	assert.deepEqual(observation, {
		workerId: "worker-1",
		direction: "in",
		messageId: "msg-1",
		kind: "answer",
		from: "parent-agent",
		delivery: "delivered",
		transport: "inbox",
		replyTo: "q2",
		at: 1_700_000_000_000,
	} satisfies WorkerMessageObservation);
	assert.equal("body" in observation!, false);
});

test("non-message events and malformed payloads observe as nothing", () => {
	assert.equal(messageObservationFromEvent("worker-1", { ts: 1, kind: "todo", payload: { total: 2 } }), undefined);
	assert.equal(messageObservationFromEvent("worker-1", { ts: 1, kind: "message", payload: {} }), undefined);
});

test("observers see messages, and only through the stream that already emitted them", () => {
	const api = surface();
	const seen: WorkerMessageObservation[] = [];
	const unsubscribe = api.onMessage((observation) => seen.push(observation));

	api.emitWorkerEvent("worker-1", messageEvent);
	api.emitWorkerEvent("worker-1", { ts: 2, kind: "todo", payload: { total: 1 } });

	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.messageId, "msg-1");

	unsubscribe();
	api.emitWorkerEvent("worker-1", messageEvent);
	assert.equal(seen.length, 1);
});

test("a throwing observer cannot break Docket or starve the next one", () => {
	const api = surface();
	const seen: string[] = [];
	api.onMessage(() => { throw new Error("companion exploded"); });
	api.onMessage((observation) => seen.push(observation.messageId));

	assert.doesNotThrow(() => api.emitWorkerEvent("worker-1", messageEvent));
	assert.deepEqual(seen, ["msg-1"]);
});

const advisorInput: BroadcastAdvisorInput = {
	text: "auth middleware changed",
	source: { kind: "human" },
	candidates: [
		{ workerId: "worker-1", label: "w1", task: "fix auth", band: "unrelated", reason: "no overlap found" },
		{ workerId: "worker-2", label: "w2", task: "rate limits", band: "affected", reason: "touches src/auth" },
	],
};

test("advisors are additive: several register, all are consulted", async () => {
	const api = surface();
	api.registerBroadcastAdvisor(() => [{ workerId: "worker-1", reason: "shares the session cache" }]);
	api.registerBroadcastAdvisor(() => [{ workerId: "worker-2", reason: "also this" }]);

	const suggestions = await api.collectBroadcastSuggestions(advisorInput);

	assert.deepEqual(suggestions.map((suggestion) => suggestion.workerId).sort(), ["worker-1", "worker-2"]);
});

test("an advisor cannot invent a recipient Docket did not enumerate", async () => {
	const api = surface();
	api.registerBroadcastAdvisor(() => [{ workerId: "worker-99", reason: "not a candidate" }]);

	assert.deepEqual(await api.collectBroadcastSuggestions(advisorInput), []);
});

test("a throwing, hanging, or nonsense advisor yields nothing and blocks nobody", async () => {
	const api = surface();
	api.registerBroadcastAdvisor(() => { throw new Error("boom"); });
	api.registerBroadcastAdvisor(() => new Promise(() => {}));
	api.registerBroadcastAdvisor(() => "not an array" as unknown as []);
	api.registerBroadcastAdvisor(() => [{ workerId: "worker-1", reason: "   " }]);
	api.registerBroadcastAdvisor(() => [{ workerId: "worker-1", reason: "shares the session cache" }]);

	const started = Date.now();
	const suggestions = await api.collectBroadcastSuggestions(advisorInput, 20);

	assert.deepEqual(suggestions, [{ workerId: "worker-1", reason: "shares the session cache" }]);
	assert.ok(Date.now() - started < BROADCAST_ADVISOR_TIMEOUT_MS + 500);
});

function worker(index: number, task: string): WorkerStatus {
	return {
		id: `worker-${index}`,
		index,
		tmuxSession: "docket-workers",
		task,
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "active",
	};
}

const recipients: BroadcastRecipient[] = [
	{ worker: worker(1, "fix auth"), label: "w1", task: "fix auth", band: "unrelated", reason: "no overlap found", selected: false },
	{ worker: worker(2, "rate limits"), label: "w2", task: "rate limits", band: "affected", reason: "touches src/auth", selected: true },
	{ worker: worker(3, "docs"), label: "w3", task: "docs", band: "maybe", reason: "mentions authcontext", selected: false },
];

test("a suggestion lifts a candidate into maybe and says it was suggested", () => {
	const updated = applyBroadcastSuggestions(recipients, [{ workerId: "worker-1", reason: "shares the session cache" }]);
	const w1 = updated.find((recipient) => recipient.label === "w1")!;

	assert.equal(w1.band, "maybe");
	assert.equal(w1.selected, false);
	assert.match(w1.reason, /^suggested · shares the session cache$/);
});

test("a suggestion can never reach affected, so a companion can never cause a send", () => {
	const updated = applyBroadcastSuggestions(recipients, [
		{ workerId: "worker-1", reason: "a" },
		{ workerId: "worker-3", reason: "b" },
	]);

	assert.equal(updated.some((recipient) => recipient.band === "affected" && recipient.label !== "w2"), false);
	assert.deepEqual(updated.filter((recipient) => recipient.selected).map((recipient) => recipient.label), ["w2"]);
});

test("a suggestion cannot demote, deselect, or remove anything Docket proposed", () => {
	const updated = applyBroadcastSuggestions(recipients, [
		{ workerId: "worker-2", reason: "please drop this one" },
		{ workerId: "worker-3", reason: "and this one" },
	]);

	const w2 = updated.find((recipient) => recipient.label === "w2")!;
	const w3 = updated.find((recipient) => recipient.label === "w3")!;
	assert.equal(w2.band, "affected");
	assert.equal(w2.selected, true);
	assert.equal(w2.reason, "touches src/auth");
	assert.equal(w3.reason, "mentions authcontext");
	assert.equal(updated.length, recipients.length);
});

test("no suggestions leaves the proposal exactly as Docket scored it", () => {
	assert.equal(applyBroadcastSuggestions(recipients, []), recipients);
});

function sentChip(transport: "inbox" | "tmux" = "inbox"): DocketMessageDetails {
	return { kind: "action", sentMessage: { workerId: "worker-1", workerLabel: "w1", messageId: "msg-1", transport } };
}

function message(delivery: WorkerMessage["delivery"]): WorkerMessage {
	return { id: "msg-1", kind: "answer", from: "human", body: "hold the storage layer", deliverAs: "steer", createdAt: "2026-01-01T00:00:00.000Z", delivery };
}

test("a chip keeps looking while its message can still move", () => {
	assert.equal(docketMessageChipIsFinal(sentChip(), undefined, false), false);
	assert.equal(docketMessageChipIsFinal(sentChip(), message("queued"), false), false);
	assert.equal(docketMessageChipIsFinal(sentChip(), message("delivered"), false), false);
});

test("a chip stops looking once nothing it reports can change", () => {
	assert.equal(docketMessageChipIsFinal(sentChip(), message("read"), false), true);
	// A departed worker cannot advance a message it already took; a queued one still can, after
	// a respawn delivers it.
	assert.equal(docketMessageChipIsFinal(sentChip(), message("delivered"), true), true);
	assert.equal(docketMessageChipIsFinal(sentChip(), message("queued"), true), false);
	// tmux keystrokes were never observable, so re-reading them could only invent a fact.
	assert.equal(docketMessageChipIsFinal(sentChip("tmux"), undefined, false), true);
});

test("a chip with nothing live in it is painted once", () => {
	assert.equal(docketMessageChipIsFinal({ kind: "notice" }, undefined, false), true);
	assert.equal(docketMessageChipIsFinal({ kind: "action", workerId: "worker-1" }, undefined, false), false);
	assert.equal(docketMessageChipIsFinal({ kind: "action", workerId: "worker-1" }, undefined, true), true);
});
