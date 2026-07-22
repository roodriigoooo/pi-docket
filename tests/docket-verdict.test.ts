import test from "node:test";
import assert from "node:assert/strict";
import { DocketVerdictView, DocketWorkerReportView, diffBar, verdictVerbs, workerVerdictPayload } from "../extensions/docket.js";
import type { WorkerStatus } from "../extensions/worker-store.js";
import type { Artifact } from "../extensions/types.js";
import type { WorkerDeliverable } from "../extensions/worker-deliverable.js";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 1,
		tmuxSession: "docket-workers:w1",
		task: "inspect auth",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "ready",
		...partial,
	};
}

const changeSet: Artifact = {
	id: "changes",
	displayId: "changes",
	ref: "worker-changes:worker-1:0",
	kind: "response",
	title: "w1 change set · 2 files",
	subtitle: "inspect auth",
	body: "diff omitted",
	timestamp: 1,
	meta: {
		workerChangeSet: true,
		changedFiles: [
			{ path: "src/auth.ts", additions: 8, deletions: 2 },
			{ path: "test/auth.test.ts", additions: 4, deletions: 1 },
		],
		hunkCount: 3,
	},
};

test("verdictVerbs adapts labels and semantics by state", () => {
	assert.deepEqual(verdictVerbs("needs_input", false).map((verb) => [verb.label, verb.description]), [
		["Accept", "approve · worker continues"],
		["Reject", "redirect · stays alive"],
		["Reject & stop", "kill worker + remove workspace"],
		["Chat", "type a reply"],
	]);
	assert.equal(verdictVerbs("failed", false)[0]?.label, "Retry");
	assert.equal(verdictVerbs("failed", false)[1]?.label, "Dismiss");
	assert.equal(verdictVerbs("ready", true)[0]?.label, "Promote");
	assert.equal(verdictVerbs("ready", true)[1]?.label, "Discard");
	assert.equal(verdictVerbs("ready", false)[0]?.label, "Acknowledge");
	assert.equal(verdictVerbs("ready", false, [], false, true)[0]?.label, "Approve");
	assert.deepEqual(verdictVerbs("reviewed", false, [], true, true).map((verb) => verb.id), ["use", "save", "report"]);
	assert.deepEqual(verdictVerbs("ready", false, [], true, true).map((verb) => verb.id), ["use", "save", "report"], "ledger approval remains usable if reviewedAt persistence failed");
});

test("diffBar clamps width and proportions", () => {
	assert.equal(diffBar(0, 0, 4), "░░░░");
	assert.equal(diffBar(3, 1, 4), "███░");
	assert.equal(diffBar(1, 99, 4), "█░░░");
	assert.equal(diffBar(99, 1, 4), "███░");
	assert.equal(diffBar(1, 0, 0), "█");
});

test("workerVerdictPayload uses status fields for questions and failures", () => {
	const waiting = worker({ state: "needs_input", question: "Proceed with migration?" });
	assert.deepEqual(workerVerdictPayload(waiting).lines, ["Proceed with migration?"]);

	const failed = worker({ state: "failed", lastError: "npm test exited 1" });
	assert.deepEqual(workerVerdictPayload(failed).lines, ["npm test exited 1"]);
});

test("workerVerdictPayload summarizes deterministic change set metadata", () => {
	const payload = workerVerdictPayload(worker({ state: "ready" }), changeSet);
	assert.equal(payload.hasChangeSet, true);
	assert.equal(payload.additions, 12);
	assert.equal(payload.deletions, 3);
	assert.equal(payload.hunkCount, 3);
	assert.deepEqual(payload.lines, ["src/auth.ts   +8/-2", "test/auth.test.ts   +4/-1"]);
	assert.deepEqual(payload.fileEntries, [
		{ path: "src/auth.ts", additions: 8, deletions: 2 },
		{ path: "test/auth.test.ts", additions: 4, deletions: 1 },
	]);
});

test("workerVerdictPayload surfaces worker intent alongside a change set", () => {
	const withSummary = workerVerdictPayload(worker({ state: "ready", summary: "Added token-bucket limiter + tests\nfollow-up: wire config" }), changeSet);
	assert.equal(withSummary.intent, "Added token-bucket limiter + tests");
	assert.deepEqual(withSummary.lines, ["src/auth.ts   +8/-2", "test/auth.test.ts   +4/-1"]);
	assert.equal(workerVerdictPayload(worker({ state: "ready" }), changeSet).intent, undefined);
});

test("verdictVerbs renders worker-proposed options as send verbs", () => {
	const verbs = verdictVerbs("needs_input", false, ["Proceed as proposed", "Use migration-safe path"]);
	assert.deepEqual(verbs.map((verb) => verb.id), ["send", "send", "reject", "rejectStop", "chat"]);
	assert.deepEqual(verbs.slice(0, 2).map((verb) => verb.send), ["Proceed as proposed", "Use migration-safe path"]);
	assert.equal(verbs[2]?.label, "Steer");
	assert.deepEqual(verdictVerbs("needs_input", false).map((verb) => verb.label), ["Accept", "Reject", "Reject & stop", "Chat"]);
});

test("DocketVerdictView exposes Hunk review for worker change sets", () => {
	let action: unknown;
	const theme = {
		fg: (_token: string, s: string) => s,
		bg: (_token: string, s: string) => s,
		bold: (s: string) => s,
	};
	const view = new DocketVerdictView({ requestRender() {} } as never, theme, worker({ state: "ready" }), changeSet, (result) => { action = result; });
	const rendered = view.render(100).join("\n");
	assert.match(rendered, /Evidence/);
	assert.match(rendered, /Worker says/);
	assert.match(rendered, /Actions/);
	assert.match(rendered, /h Hunk[\s\S]*review/);
	assert.match(rendered, /r Report/);

	view.handleInput("h");

	assert.deepEqual(action, { verb: "hunk", worker: worker({ state: "ready" }), changeSet });
});

test("DocketVerdictView binds r to Report even without a change set", () => {
	let action: unknown;
	const theme = {
		fg: (_token: string, s: string) => s,
		bg: (_token: string, s: string) => s,
		bold: (s: string) => s,
	};
	const ready = worker({ state: "ready", summary: "Scouted auth callers", recommended: ["review src/auth.ts"] });
	const view = new DocketVerdictView({ requestRender() {} } as never, theme, ready, undefined, (result) => { action = result; });
	const rendered = view.render(100).join("\n");
	assert.match(rendered, /Evidence/);
	assert.match(rendered, /Worker says/);
	assert.match(rendered, /Scouted auth callers/);
	assert.match(rendered, /r Report/);
	assert.doesNotMatch(rendered, /d full diff/);

	view.handleInput("r");
	assert.deepEqual(action, { verb: "report", worker: ready });
});

test("DocketVerdictView keeps waiting cards on Question / Actions", () => {
	const theme = {
		fg: (_token: string, s: string) => s,
		bg: (_token: string, s: string) => s,
		bold: (s: string) => s,
	};
	const waiting = worker({
		state: "needs_input",
		questions: [{ id: "q1", text: "Proceed?", createdAt: "2026-01-01T00:00:00.000Z", risk: "touches auth" }],
	});
	const rendered = new DocketVerdictView({ requestRender() {} } as never, theme, waiting, undefined, () => {}).render(100).join("\n");
	assert.match(rendered, /Question/);
	assert.match(rendered, /Actions/);
	assert.doesNotMatch(rendered, /Worker says/);
	assert.doesNotMatch(rendered, /r Report/);
});

test("workerVerdictPayload surfaces structured risk on a waiting worker", () => {
	const waiting = worker({
		state: "needs_input",
		questions: [{ id: "q1", text: "Drop the sessions table?", createdAt: "2026-01-01T00:00:00.000Z", risk: "irreversible: drops sessions", options: ["Proceed", "Migration-safe path"], recommend: "Migration-safe path" }],
	});
	const payload = workerVerdictPayload(waiting);
	assert.equal(payload.risk, "irreversible: drops sessions");
	assert.deepEqual(payload.lines, ["Drop the sessions table?"]);
});

test("DocketVerdictView fits terminal height without slicing actions or frame", () => {
	const theme = {
		fg: (_token: string, s: string) => s,
		bg: (_token: string, s: string) => s,
		bold: (s: string) => s,
	};
	const tui = { terminal: { rows: 80 }, requestRender() {} };
	const current: WorkerDeliverable = {
		schemaVersion: 1,
		id: "worker-deliverable:worker-1",
		version: 1,
		ref: "worker-deliverable:worker-1:1",
		createdAt: "2026-01-01T00:00:00.000Z",
		source: { workerId: "worker-1", workerLabel: "w1", task: "inspect auth" },
		body: "# Proposal\n\nFull proposal body",
		summary: "Replace emergency bypass with one disabled-region guard before evaluating maintenance fallback behavior",
		outcome: "proposal",
		evidence: [
			"README.md requires disabled regions to remain unavailable during every release mode",
			"release-plan.js currently bypasses disabled checks whenever emergency is true",
			"emergency disabled-region test fails against current implementation",
		],
		recommendations: [
			"Move disabled-region fallback before emergency-specific maintenance handling",
			"Retain explicit tests for normal, maintenance, emergency, and unknown regions",
			"Run full release-plan test suite after implementation",
		],
		refs: Array.from({ length: 8 }, (_, index) => ({ displayId: `e${index + 1}`, ref: `evidence:${index + 1}`, kind: "file" as const, title: `evidence ${index + 1}`, subtitle: "captured" })),
	};
	const view = new DocketVerdictView(tui as never, theme, worker({ state: "ready", deliverable: { id: current.id, version: current.version, ref: current.ref } }), changeSet, () => {}, 0, undefined, [], current);

	view.render(100);
	tui.terminal.rows = 36;
	const lines = view.render(100);
	const rendered = lines.join("\n");

	assert.equal(lines.length, 25, "70% overlay cap is applied inside the component");
	assert.match(rendered, /preview compacted to fit/);
	assert.match(rendered, /Actions/);
	assert.match(rendered, /Request revision/);
	assert.match(rendered, /r Report/);
	assert.match(lines.at(-2) ?? "", /╰/, "bottom border remains visible");
});

test("DocketWorkerReportView keeps final lines reachable inside short overlays", () => {
	const theme = {
		fg: (_token: string, s: string) => s,
		bg: (_token: string, s: string) => s,
		bold: (s: string) => s,
	};
	const tui = { terminal: { rows: 80 }, requestRender() {} };
	const body = Array.from({ length: 60 }, (_, index) => `report line ${index + 1}`).join("\n");
	const view = new DocketWorkerReportView(tui as never, theme, "w1 · Report", body, () => {});

	view.render(100);
	tui.terminal.rows = 24;
	const compact = view.render(100);
	assert.equal(compact.length, 21, "88% overlay cap is applied inside the component");
	assert.match(compact.at(-2) ?? "", /╰/, "bottom border remains visible");

	view.handleInput("G");
	const bottom = view.render(100).join("\n");
	assert.match(bottom, /report line 60/, "last report line remains reachable");
});
