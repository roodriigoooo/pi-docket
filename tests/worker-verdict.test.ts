import test from "node:test";
import assert from "node:assert/strict";
import type { WorkerStatus } from "../extensions/background-work.js";
import type { DecisionRecord } from "../extensions/decision-log.js";
import type { Artifact } from "../extensions/types.js";
import { runWorkerVerdict, verdictCandidateRank, type WorkerVerdictDeps } from "../extensions/worker-verdict.js";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 1,
		tmuxSession: "docket-workers:w1",
		task: "review auth flow",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "ready",
		...partial,
	};
}

function depsFor(w: WorkerStatus, overrides: Partial<WorkerVerdictDeps> = {}): { deps: WorkerVerdictDeps; calls: string[]; decisions: DecisionRecord[] } {
	const calls: string[] = [];
	const decisions: DecisionRecord[] = [];
	const deps: WorkerVerdictDeps = {
		hasUI: true,
		workerStore: { find: async () => w, list: async () => [w], patchStatus: async (id, patch) => { calls.push(`patch:${id}:${JSON.stringify(patch)}`); return { ...w, ...patch }; } },
		workerCommands: {
			tell: async (ref: string, text: string) => { calls.push(`tell:${ref}:${text}`); },
			delete: async (ref: string) => { calls.push(`delete:${ref}`); },
			respawn: async (ref: string) => { calls.push(`respawn:${ref}`); },
		},
		notify: (text, level) => { calls.push(`notify:${level}:${text}`); },
		showVerdict: async () => ({ verb: "accept", worker: w }),
		confirmDeleteWorker: async () => true,
		showText: async (title, _text, options) => { calls.push(`showText:${title}:${options?.diff ? "diff" : "plain"}`); },
		formatArtifact: (artifact: Artifact) => artifact.body,
		input: async () => undefined,
		promoteWorkerChangeSet: async () => { calls.push("promote"); return true; },
		markArtifactDone: (artifact: Artifact) => { calls.push(`done:${artifact.ref}`); },
		refreshWorkerDockWidget: async () => { calls.push("refresh"); },
		recordDecision: async (record) => { decisions.push(record); },
		...overrides,
	};
	return { deps, calls, decisions };
}

test("verdictCandidateRank prioritizes blocked, failed, then ready workers", () => {
	assert.equal(verdictCandidateRank(worker({ state: "needs_input" })), 0);
	assert.equal(verdictCandidateRank(worker({ state: "failed" })), 1);
	assert.equal(verdictCandidateRank(worker({ state: "ready" })), 2);
	assert.equal(verdictCandidateRank(worker({ state: "active" })), 100);
});

test("runWorkerVerdict sends option text and records visible risk/evidence", async () => {
	const w = worker({
		state: "needs_input",
		questions: [{ id: "q1", text: "Use postgres?", risk: "touches migration order", createdAt: "2026-01-01T00:01:00.000Z" }],
	});
	const { deps, calls, decisions } = depsFor(w, {
		showVerdict: async () => ({ verb: "send", worker: w, text: "use postgres" }),
	});

	const outcome = await runWorkerVerdict(deps, w);

	assert.equal(outcome, "advance");
	assert.deepEqual(calls, ["tell:w1:use postgres", "refresh"]);
	assert.equal(decisions[0]?.verb, "send");
	assert.equal(decisions[0]?.option, "use postgres");
	assert.equal(decisions[0]?.risk, "touches migration order");
	assert.deepEqual(decisions[0]?.evidenceRefs, ["worker-status:worker-1:0"]);
});

test("runWorkerVerdict diff verb opens full diff in diff mode", async () => {
	const w = worker({ state: "ready" });
	const changeSet: Artifact = { id: "changes", displayId: "changes", ref: "worker-changes:worker-1:0", kind: "response", title: "x change set", subtitle: "", body: "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new", timestamp: 1, meta: { workerChangeSet: true, workerId: "worker-1", changedFiles: [{ path: "x", additions: 1, deletions: 1 }], hunkCount: 1 } };
	const seen: Array<{ verb: string; diff?: boolean }> = [];
	const { deps, calls } = depsFor(w, {
		showVerdict: async () => ({ verb: "diff", worker: w, changeSet }),
		showText: async (title, _text, options) => { seen.push({ verb: "diff", diff: options?.diff }); calls.push(`showText:${title}:${options?.diff ? "diff" : "plain"}`); },
		formatArtifact: (artifact) => artifact.body,
	});

	// diff verb re-enters the loop; follow it with accept to terminate.
	let first = true;
	const origShowVerdict = deps.showVerdict;
	deps.showVerdict = async () => first ? (first = false, { verb: "diff", worker: w, changeSet }) : { verb: "accept", worker: w };
	void origShowVerdict;

	await runWorkerVerdict(deps, w);

	assert.equal(seen.some((s) => s.diff === true), true, `expected showText called with diff:true, got: ${JSON.stringify(seen)}`);
	assert.ok(calls.some((c) => /showText:.*:diff$/.test(c)));
});

test("runWorkerVerdict marks ready worker reviewed on accept without changeset", async () => {
	const w = worker({ state: "ready" });
	const { deps, calls, decisions } = depsFor(w, {
		showVerdict: async () => ({ verb: "accept", worker: w }),
	});

	const outcome = await runWorkerVerdict(deps, w);

	assert.equal(outcome, "advance");
	assert.ok(calls.some((c) => /^patch:worker-1:.*reviewedAt/.test(c)), `expected reviewedAt patch, got: ${JSON.stringify(calls)}`);
	assert.equal(decisions[0]?.verb, "accept");
});

test("runWorkerVerdict marks ready worker reviewed on reject (dismiss)", async () => {
	const w = worker({ state: "ready" });
	const { deps, calls, decisions } = depsFor(w, {
		showVerdict: async () => ({ verb: "reject", worker: w }),
	});

	await runWorkerVerdict(deps, w);

	assert.ok(calls.some((c) => /^patch:worker-1:.*reviewedAt/.test(c)));
	assert.equal(decisions[0]?.verb, "reject");
});

test("runWorkerVerdict does NOT mark reviewed on needs_input send (worker still alive)", async () => {
	const w = worker({ state: "needs_input", questions: [{ id: "q1", text: "x?", createdAt: "2026-01-01T00:00:00.000Z" }] });
	const { deps, calls } = depsFor(w, {
		showVerdict: async () => ({ verb: "send", worker: w, text: "yes" }),
	});

	await runWorkerVerdict(deps, w);

	assert.equal(calls.some((c) => /^patch:worker-1:.*reviewedAt/.test(c)), false);
});

test("runWorkerVerdict does NOT mark reviewed on failed accept (retry respawn)", async () => {
	const w = worker({ state: "failed", lastError: "boom" });
	const { deps, calls } = depsFor(w, {
		showVerdict: async () => ({ verb: "accept", worker: w }),
	});

	await runWorkerVerdict(deps, w);

	assert.equal(calls.some((c) => /^patch:worker-1:.*reviewedAt/.test(c)), false);
	assert.ok(calls.some((c) => c.startsWith("respawn:")));
});

test("runWorkerVerdict marks failed worker reviewed on reject (dismiss)", async () => {
	const w = worker({ state: "failed", lastError: "boom" });
	const { deps, calls } = depsFor(w, {
		showVerdict: async () => ({ verb: "reject", worker: w }),
	});

	await runWorkerVerdict(deps, w);

	assert.ok(calls.some((c) => /^patch:worker-1:.*reviewedAt/.test(c)));
});

test("runWorkerVerdict stops without UI", async () => {
	const w = worker();
	const { deps, calls } = depsFor(w, { hasUI: false });

	const outcome = await runWorkerVerdict(deps, w);

	assert.equal(outcome, "stop");
	assert.deepEqual(calls, ["notify:error:Docket verdict needs UI. Use /docket tell, /docket load, or /docket delete."]);
});
