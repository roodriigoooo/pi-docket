import test from "node:test";
import assert from "node:assert/strict";
import { isDeliverableApproved, latestDeliverableJudgment, reviewedDeliverableRefs, type DecisionEvent } from "../extensions/decision-log.js";

const pointer = { id: "worker-deliverable:w1", version: 2, ref: "worker-deliverable:w1:2" };

function verdict(verb: "accept" | "reject" | "rejectStop", partial: Partial<Extract<DecisionEvent, { type: "verdict_resolved" }>> = {}): DecisionEvent {
	return {
		type: "verdict_resolved",
		id: partial.id,
		timestamp: partial.timestamp ?? "2026-01-01T00:00:00.000Z",
		workerId: "w1",
		workerLabel: "w1",
		state: partial.state ?? "ready",
		verb,
		evidenceRefs: [],
		deliverableId: partial.deliverableId ?? pointer.id,
		deliverableVersion: partial.deliverableVersion ?? pointer.version,
		deliverableRef: partial.deliverableRef ?? pointer.ref,
	};
}

test("approval is exact-generation and latest judgment wins", () => {
	const v1 = { ...pointer, version: 1, ref: "worker-deliverable:w1:1" };
	const events: DecisionEvent[] = [
		verdict("accept", { id: "v1", deliverableVersion: v1.version, deliverableRef: v1.ref }),
		verdict("accept", { id: "v2", timestamp: "2026-01-01T00:01:00.000Z" }),
		verdict("reject", { id: "v2-reject", timestamp: "2026-01-01T00:01:00.000Z" }),
	];

	assert.equal(isDeliverableApproved(events, v1), true);
	assert.equal(isDeliverableApproved(events, pointer), false);
	assert.equal(latestDeliverableJudgment(events, pointer)?.id, "v2-reject");
	assert.deepEqual([...reviewedDeliverableRefs(events)].sort(), [v1.ref, pointer.ref].sort());
});

test("needs-input accept and failed retry cannot approve a deliverable", () => {
	assert.equal(isDeliverableApproved([verdict("accept", { state: "needs_input" })], pointer), false);
	assert.equal(isDeliverableApproved([verdict("accept", { state: "failed" })], pointer), false);
});
