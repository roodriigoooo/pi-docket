import test from "node:test";
import assert from "node:assert/strict";
import { decisionDebtLine, renderDecisionLog, reviewedWorkerIds, summarizeDecisions, verbLabel, type DecisionEvent } from "../extensions/decision-log.js";

const NOW = Date.parse("2026-06-13T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function verdict(partial: Partial<Extract<DecisionEvent, { type: "verdict_resolved" }>> & { workerId: string; verb: Extract<DecisionEvent, { type: "verdict_resolved" }>["verb"] }): DecisionEvent {
	return {
		type: "verdict_resolved",
		timestamp: partial.timestamp ?? new Date(NOW - HOUR).toISOString(),
		workerId: partial.workerId,
		workerLabel: partial.workerLabel ?? "w1",
		state: partial.state ?? "ready",
		verb: partial.verb,
		evidenceRefs: partial.evidenceRefs ?? [],
		...(partial.option ? { option: partial.option } : {}),
		...(partial.risk ? { risk: partial.risk } : {}),
		...(partial.task ? { task: partial.task } : {}),
	};
}

function eviction(workerId: string, timestamp = new Date(NOW - HOUR).toISOString()): DecisionEvent {
	return { type: "worker_evicted_unreviewed", timestamp, workerId, workerLabel: workerId, state: "ended", reason: "pruned" };
}

test("reviewedWorkerIds collects only workers with a recorded verdict", () => {
	const events: DecisionEvent[] = [
		verdict({ workerId: "a", verb: "accept" }),
		verdict({ workerId: "b", verb: "reject" }),
		eviction("c"),
	];
	const ids = reviewedWorkerIds(events);
	assert.deepEqual([...ids].sort(), ["a", "b"]);
	assert.equal(ids.has("c"), false);
});

test("summarizeDecisions counts verbs and unreviewed evictions within the window", () => {
	const events: DecisionEvent[] = [
		verdict({ workerId: "a", verb: "accept" }),
		verdict({ workerId: "b", verb: "accept" }),
		verdict({ workerId: "c", verb: "rejectStop" }),
		eviction("d"),
		eviction("e"),
	];
	const summary = summarizeDecisions(events, NOW);
	assert.equal(summary.reviewed, 3);
	assert.equal(summary.unreviewedEvictions, 2);
	assert.equal(summary.byVerb.accept, 2);
	assert.equal(summary.byVerb.rejectStop, 1);
	assert.equal(summary.byVerb.reject, 0);
	assert.equal(summary.windowDays, 7);
});

test("summarizeDecisions drops events older than the window", () => {
	const events: DecisionEvent[] = [
		verdict({ workerId: "recent", verb: "accept", timestamp: new Date(NOW - DAY).toISOString() }),
		verdict({ workerId: "old", verb: "accept", timestamp: new Date(NOW - 30 * DAY).toISOString() }),
	];
	const summary = summarizeDecisions(events, NOW);
	assert.equal(summary.reviewed, 1);
});

test("summarizeDecisions honors a custom window", () => {
	const events: DecisionEvent[] = [
		verdict({ workerId: "a", verb: "accept", timestamp: new Date(NOW - 2 * DAY).toISOString() }),
	];
	assert.equal(summarizeDecisions(events, NOW, DAY).reviewed, 0);
	assert.equal(summarizeDecisions(events, NOW, 3 * DAY).reviewed, 1);
});

test("decisionDebtLine pluralizes and stays quiet at zero", () => {
	assert.equal(decisionDebtLine(summarizeDecisions([], NOW)), undefined);
	assert.equal(decisionDebtLine(summarizeDecisions([eviction("a")], NOW)), "1 worker evicted unreviewed this week");
	assert.equal(decisionDebtLine(summarizeDecisions([eviction("a"), eviction("b")], NOW)), "2 workers evicted unreviewed this week");
});

test("verbLabel maps rejectStop to a readable phrase", () => {
	assert.equal(verbLabel("rejectStop"), "reject & stop");
	assert.equal(verbLabel("send"), "option");
});

test("renderDecisionLog shows the headline, debt, and recent entries", () => {
	const events: DecisionEvent[] = [
		verdict({ workerId: "a", verb: "accept", workerLabel: "w1", state: "ready", evidenceRefs: ["worker-changeset:a:0"], option: "ship it" }),
		eviction("b"),
	];
	const report = renderDecisionLog(events, NOW);
	assert.match(report, /Decisions · last 7 days/);
	assert.match(report, /1 resolved · 1 evicted unreviewed/);
	assert.match(report, /decision debt: 1 worker evicted unreviewed/);
	assert.match(report, /w1\s+accept "ship it"/);
	assert.match(report, /evicted unreviewed/);
});

test("renderDecisionLog handles an empty ledger", () => {
	const report = renderDecisionLog([], NOW);
	assert.match(report, /No decisions recorded yet/);
});
