import test from "node:test";
import assert from "node:assert/strict";
import {
	broadcastBandCounts,
	broadcastProvenanceLine,
	broadcastSummary,
	extractBroadcastIdentifiers,
	extractBroadcastPaths,
	formatBroadcastBody,
	scoreBroadcastRecipients,
	shouldProposeBulletin,
	type BroadcastCandidate,
} from "../extensions/worker-broadcast.js";
import type { WorkerStatus } from "../extensions/background-work.js";

function worker(index: number, task: string, overrides: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: `worker-${index}`,
		index,
		tmuxSession: "docket-workers",
		task,
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "active",
		...overrides,
	};
}

const w1 = worker(1, "fix the failing auth test", { kind: "patcher" });
const w2 = worker(2, "add rate limiting to the public API");
const w3 = worker(3, "map session call sites", { kind: "scout" });
const w4 = worker(4, "document the deploy runbook");

function candidates(overrides: Record<number, Partial<BroadcastCandidate>> = {}): BroadcastCandidate[] {
	return [
		{ worker: w1, touchedPaths: ["src/auth/middleware.ts", "tests/auth.test.ts"], ...overrides[1] },
		{ worker: w2, touchedPaths: ["src/api/limit.ts"], ...overrides[2] },
		{ worker: w3, touchedPaths: ["src/session/store.ts"], ...overrides[3] },
		{ worker: w4, touchedPaths: ["docs/deploy.md"], ...overrides[4] },
	];
}

test("paths are pulled out of ordinary prose", () => {
	const paths = extractBroadcastPaths("auth middleware in `src/auth/middleware.ts` now takes a context arg; see also handler.ts");

	assert.ok(paths.includes("src/auth/middleware.ts"));
	assert.ok(paths.includes("handler.ts"));
});

test("identifiers come from backticks and cased names, not from every word", () => {
	const identifiers = extractBroadcastIdentifiers("the `retryWrapper` helper and request_context both changed, but the plan did not");

	assert.ok(identifiers.includes("retrywrapper"));
	assert.ok(identifiers.includes("request_context"));
	assert.equal(identifiers.includes("changed"), false);
});

test("a path the message names puts its workers in affected, with the reason", () => {
	const recipients = scoreBroadcastRecipients({
		text: "src/auth/middleware.ts now takes a context arg",
		source: { kind: "human" },
		candidates: candidates(),
	});

	const affected = recipients.filter((recipient) => recipient.band === "affected");
	assert.deepEqual(affected.map((recipient) => recipient.label), ["w1"]);
	assert.match(affected[0]!.reason, /touches src\/auth\/middleware\.ts/);
	assert.equal(affected[0]!.selected, true);
});

test("a worker matches on a path even from inside its own worktree", () => {
	const recipients = scoreBroadcastRecipients({
		text: "middleware.ts now takes a context arg",
		source: { kind: "human" },
		candidates: candidates({ 1: { touchedPaths: ["/tmp/wt/worker-1/src/auth/middleware.ts"] } }),
	});

	assert.equal(recipients.find((recipient) => recipient.label === "w1")?.band, "affected");
});

test("an approved plan's files count as affected even before the worker touches them", () => {
	const recipients = scoreBroadcastRecipients({
		text: "src/auth/middleware.ts now takes a context arg",
		source: { kind: "human" },
		candidates: candidates({ 1: { touchedPaths: [] }, 2: { touchedPaths: [], plannedPaths: ["src/auth/middleware.ts"] } }),
	});

	assert.equal(recipients.find((recipient) => recipient.label === "w2")?.band, "affected");
	assert.match(recipients.find((recipient) => recipient.label === "w2")!.reason, /plan names/);
});

test("a weaker signal lands in maybe, never preselected", () => {
	const recipients = scoreBroadcastRecipients({
		text: "the `sessionStore` lookup is now async",
		source: { kind: "human" },
		candidates: candidates({ 3: { touchedPaths: [], keywords: ["sessionStore lookup"] } }),
	});

	const w3Row = recipients.find((recipient) => recipient.label === "w3");
	assert.equal(w3Row?.band, "maybe");
	assert.equal(w3Row?.selected, false);
	assert.match(w3Row!.reason, /mentions sessionstore/);
});

test("every row carries task text, so a bare index is never the only handle", () => {
	for (const recipient of scoreBroadcastRecipients({ text: "anything", source: { kind: "human" }, candidates: candidates() })) {
		assert.ok(recipient.task.length > 0, recipient.label);
	}
});

test("the source worker and workers that cannot act are never proposed", () => {
	const stopped = worker(5, "already finished", { state: "ended" });
	const recipients = scoreBroadcastRecipients({
		text: "src/auth/middleware.ts changed",
		source: { kind: "worker", worker: w1, touchedPaths: ["src/auth/middleware.ts"], standing: "worktree" },
		candidates: [...candidates(), { worker: stopped, touchedPaths: ["src/auth/middleware.ts"] }],
	});

	assert.equal(recipients.some((recipient) => recipient.label === "w1"), false);
	assert.equal(recipients.some((recipient) => recipient.label === "w5"), false);
});

test("a worker blocked on a question is still a valid recipient", () => {
	const blocked = worker(6, "wire the auth middleware", { state: "needs_input" });
	const recipients = scoreBroadcastRecipients({
		text: "src/auth/middleware.ts changed",
		source: { kind: "human" },
		candidates: [{ worker: blocked, touchedPaths: ["src/auth/middleware.ts"] }],
	});

	assert.equal(recipients[0]?.band, "affected");
});

test("an addressed notice preselects the workers it names without deciding for the human", () => {
	const recipients = scoreBroadcastRecipients({
		text: "nothing in common with anyone",
		source: { kind: "worker", worker: w2, to: ["w4"], standing: "unreviewed" },
		candidates: candidates(),
	});

	const w4Row = recipients.find((recipient) => recipient.label === "w4");
	assert.equal(w4Row?.band, "affected");
	assert.match(w4Row!.reason, /addressed by w2/);
	// Preselected, but the picker still has to be confirmed — nothing is sent here.
	assert.equal(w4Row?.selected, true);
});

test("affected sorts first so the default action is the safe one", () => {
	const recipients = scoreBroadcastRecipients({
		text: "src/auth/middleware.ts and the `sessionStore` lookup changed",
		source: { kind: "human" },
		candidates: candidates({ 3: { touchedPaths: [], keywords: ["sessionStore"] } }),
	});

	assert.equal(recipients[0]?.band, "affected");
	assert.deepEqual(broadcastBandCounts(recipients).affected, 1);
});

test("no affected recipients means Docket proposes the bulletin instead of a grid", () => {
	const recipients = scoreBroadcastRecipients({
		text: "we are standardising on tabs",
		source: { kind: "human" },
		candidates: candidates(),
	});

	assert.equal(shouldProposeBulletin(recipients), true);
	assert.equal(recipients.every((recipient) => !recipient.selected), true);
});

test("standing rides with the claim so a worktree change is not mistaken for landed code", () => {
	assert.equal(broadcastProvenanceLine({ kind: "human" }), undefined);
	assert.match(broadcastProvenanceLine({ kind: "worker", worker: w2, standing: "worktree" })!, /in worktree, not promoted/);
	assert.match(broadcastProvenanceLine({ kind: "worker", worker: w2, standing: "unreviewed" })!, /notice, unreviewed/);
	assert.match(broadcastProvenanceLine({ kind: "worker", worker: w2, standing: "promoted" })!, /approved · promoted/);
});

test("the delivered body carries provenance inline, never as a separate note", () => {
	const body = formatBroadcastBody("rate limiting is in", { kind: "worker", worker: w2, standing: "promoted" });

	assert.match(body, /^rate limiting is in/);
	assert.match(body, /\(w2 · approved · promoted\)$/);
	assert.equal(formatBroadcastBody("plain", { kind: "human" }), "plain");
});

test("the ledger line names who received it and what they were told", () => {
	const recipients = scoreBroadcastRecipients({ text: "src/auth/middleware.ts changed", source: { kind: "human" }, candidates: candidates() });

	assert.match(broadcastSummary(recipients.filter((recipient) => recipient.selected), "src/auth/middleware.ts changed"), /^w1 · src\/auth\/middleware\.ts changed$/);
});
