import test from "node:test";
import assert from "node:assert/strict";
import type { WorkerStatus } from "../extensions/background-work.js";
import type { DecisionRecord } from "../extensions/decision-log.js";
import type { Artifact } from "../extensions/types.js";
import type { WorkerDeliverable } from "../extensions/worker-deliverable.js";
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

function changeSet(): Artifact {
	return { id: "changes", displayId: "changes", ref: "worker-changes:worker-1:0", kind: "response", title: "x change set", subtitle: "", body: "worker: w1\n\nPatch:\ndiff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new", timestamp: 1, meta: { workerChangeSet: true, workerId: "worker-1", changedFiles: [{ path: "x", additions: 1, deletions: 1 }], hunkCount: 1 } };
}

function depsFor(w: WorkerStatus, overrides: Partial<WorkerVerdictDeps> = {}): { deps: WorkerVerdictDeps; calls: string[]; decisions: DecisionRecord[] } {
	const calls: string[] = [];
	const decisions: DecisionRecord[] = [];
	const deps: WorkerVerdictDeps = {
		hasUI: true,
		workerStore: {
			find: async () => w,
			list: async () => [w],
			updateStatus: async (id, transition) => {
				const patch = transition(w);
				calls.push(`update:${id}:${JSON.stringify(patch)}`);
				return { before: w, after: patch ? { ...w, ...patch } : w, changed: Boolean(patch) };
			},
		},
		workerCommands: {
			tell: async (ref: string, text: string) => { calls.push(`tell:${ref}:${text}`); },
			delete: async (ref: string) => { calls.push(`delete:${ref}`); },
			respawn: async (ref: string) => { calls.push(`respawn:${ref}`); },
		},
		notify: (text, level) => { calls.push(`notify:${level}:${text}`); },
		showVerdict: async () => ({ verb: "accept", worker: w }),
		showReport: async () => { calls.push("showReport"); },
		confirmDeleteWorker: async () => true,
		showText: async (title, _text, options) => { calls.push(`showText:${title}:${options?.diff ? "diff" : "plain"}`); },
		formatArtifact: (artifact: Artifact) => artifact.body,
		input: async () => undefined,
		promoteWorkerChangeSet: async () => { calls.push("promote"); return true; },
		markArtifactDone: (artifact: Artifact) => { calls.push(`done:${artifact.ref}`); },
		reviewWorkerChangeSet: async () => ({ kind: "returned" }),
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
	assert.equal(verdictCandidateRank(worker({ state: "ready", todos: [{ id: "t1", text: "follow up", state: "pending" }] })), 2);
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
	const seen: string[] = [];
	const { deps } = depsFor(w, {
		showVerdict: async () => ({ verb: "diff", worker: w, changeSet }),
		reviewWorkerChangeSet: async (_worker, seenChangeSet, options) => {
			seen.push(`${seenChangeSet.ref}:${options.preferred}`);
			return { kind: "returned" };
		},
	});

	// diff verb re-enters the loop; follow it with accept to terminate.
	let first = true;
	const origShowVerdict = deps.showVerdict;
	deps.showVerdict = async () => first ? (first = false, { verb: "diff", worker: w, changeSet }) : { verb: "accept", worker: w };
	void origShowVerdict;

	await runWorkerVerdict(deps, w);

	assert.deepEqual(seen, ["worker-changes:worker-1:0:builtin"]);
});

test("runWorkerVerdict records chat only after review comments are sent", async () => {
	const w = worker({ state: "ready" });
	const cs = changeSet();
	const { deps, calls, decisions } = depsFor(w, {
		showVerdict: async () => ({ verb: "hunk", worker: w, changeSet: cs }),
		reviewWorkerChangeSet: async (_worker, _changeSet, options) => {
			assert.equal(options.preferred, "hunk");
			return { kind: "comments-sent", commentCount: 1 };
		},
	});

	const outcome = await runWorkerVerdict(deps, w);

	assert.equal(outcome, "advance");
	assert.equal(calls.some((call) => call.startsWith("tell:")), false);
	assert.equal(decisions[0]?.verb, "chat");
	assert.equal(decisions[0]?.option, "Hunk review comments (1)");
	assert.deepEqual(decisions[0]?.evidenceRefs, ["worker-changes:worker-1:0", "worker-status:worker-1:0"]);
	assert.equal(calls.at(-1), "refresh");
});

test("runWorkerVerdict returns to card without recording when review sends no comments", async () => {
	const w = worker({ state: "ready" });
	const cs = changeSet();
	let first = true;
	const { deps, decisions } = depsFor(w, {
		showVerdict: async () => first ? (first = false, { verb: "hunk", worker: w, changeSet: cs }) : null,
		reviewWorkerChangeSet: async () => ({ kind: "returned" }),
	});

	await runWorkerVerdict(deps, w);

	assert.equal(decisions.length, 0);
});

test("runWorkerVerdict returns to card when Hunk falls back to builtin", async () => {
	const w = worker({ state: "ready" });
	const cs = changeSet();
	let first = true;
	const { deps } = depsFor(w, {
		showVerdict: async () => first ? (first = false, { verb: "hunk", worker: w, changeSet: cs }) : null,
		reviewWorkerChangeSet: async () => ({ kind: "returned" }),
	});

	await runWorkerVerdict(deps, w);
});

test("runWorkerVerdict marks ready worker reviewed on accept without changeset", async () => {
	const w = worker({ state: "ready" });
	const { deps, calls, decisions } = depsFor(w, {
		showVerdict: async () => ({ verb: "accept", worker: w }),
	});

	const outcome = await runWorkerVerdict(deps, w);

	assert.equal(outcome, "advance");
	assert.ok(calls.some((c) => /^update:worker-1:.*reviewedAt/.test(c)), `expected reviewedAt update, got: ${JSON.stringify(calls)}`);
	assert.equal(decisions[0]?.verb, "accept");
});

test("runWorkerVerdict marks ready worker reviewed on reject (dismiss)", async () => {
	const w = worker({ state: "ready" });
	const { deps, calls, decisions } = depsFor(w, {
		showVerdict: async () => ({ verb: "reject", worker: w }),
	});

	await runWorkerVerdict(deps, w);

	assert.ok(calls.some((c) => /^update:worker-1:.*reviewedAt/.test(c)));
	assert.equal(decisions[0]?.verb, "reject");
});

test("runWorkerVerdict does NOT mark reviewed on needs_input send (worker still alive)", async () => {
	const w = worker({ state: "needs_input", questions: [{ id: "q1", text: "x?", createdAt: "2026-01-01T00:00:00.000Z" }] });
	const { deps, calls } = depsFor(w, {
		showVerdict: async () => ({ verb: "send", worker: w, text: "yes" }),
	});

	await runWorkerVerdict(deps, w);

	assert.equal(calls.some((c) => /^update:worker-1:.*reviewedAt/.test(c)), false);
});

test("runWorkerVerdict does NOT mark reviewed on failed accept (retry respawn)", async () => {
	const w = worker({ state: "failed", lastError: "boom" });
	const { deps, calls } = depsFor(w, {
		showVerdict: async () => ({ verb: "accept", worker: w }),
	});

	await runWorkerVerdict(deps, w);

	assert.equal(calls.some((c) => /^update:worker-1:.*reviewedAt/.test(c)), false);
	assert.ok(calls.some((c) => c.startsWith("respawn:")));
});

test("runWorkerVerdict marks failed worker reviewed on reject (dismiss)", async () => {
	const w = worker({ state: "failed", lastError: "boom" });
	const { deps, calls } = depsFor(w, {
		showVerdict: async () => ({ verb: "reject", worker: w }),
	});

	await runWorkerVerdict(deps, w);

	assert.ok(calls.some((c) => /^update:worker-1:.*reviewedAt/.test(c)));
});

test("runWorkerVerdict report verb opens Report then returns to verdict without decisions", async () => {
	const w = worker({ state: "ready", summary: "done" });
	let first = true;
	const { deps, calls, decisions } = depsFor(w, {
		showVerdict: async () => first ? (first = false, { verb: "report", worker: w }) : null,
		showReport: async () => { calls.push("showReport"); },
	});

	const outcome = await runWorkerVerdict(deps, w);

	assert.equal(outcome, "stop");
	assert.deepEqual(calls, ["showReport"]);
	assert.equal(decisions.length, 0);
	assert.equal(calls.some((c) => c.startsWith("patch:")), false);
	assert.equal(calls.some((c) => c.startsWith("tell:")), false);
});

test("runWorkerVerdict stops without UI", async () => {
	const w = worker();
	const { deps, calls } = depsFor(w, { hasUI: false });

	const outcome = await runWorkerVerdict(deps, w);

	assert.equal(outcome, "stop");
	assert.deepEqual(calls, ["notify:error:Docket verdict needs UI. Use /docket tell, /docket load, or /docket delete."]);
});

function deliverable(version: number): WorkerDeliverable {
	return {
		schemaVersion: 1,
		id: "worker-deliverable:worker-1",
		version,
		ref: `worker-deliverable:worker-1:${version}`,
		createdAt: "2026-01-01T00:00:00.000Z",
		source: { workerId: "worker-1", workerLabel: "w1", task: "review auth flow" },
		body: `body v${version}`,
		summary: `summary v${version}`,
		outcome: "proposal",
		evidence: [],
		recommendations: [],
		refs: [],
	};
}

test("runWorkerVerdict rejects a stale deliverable action and reopens current version", async () => {
	const current = deliverable(2);
	const stale = deliverable(1);
	const w = worker({ deliverable: { id: current.id, version: current.version, ref: current.ref } });
	let cards = 0;
	const { deps, decisions, calls } = depsFor(w, {
		showVerdict: async () => ++cards === 1 ? { verb: "accept", worker: w, deliverable: stale } : null,
	});

	const outcome = await runWorkerVerdict(deps, w);

	assert.equal(outcome, "stop");
	assert.equal(cards, 2);
	assert.equal(decisions.length, 0);
	assert.ok(calls.some((call) => call.includes("newer deliverable published")));
});

test("re-approving a reviewed deliverable records its underlying ready state", async () => {
	const current = deliverable(1);
	const w = worker({ state: "ready", reviewedAt: "2026-01-01T00:01:00.000Z", deliverable: { id: current.id, version: current.version, ref: current.ref } });
	const { deps, decisions } = depsFor(w, {
		showVerdict: async () => ({ verb: "accept", worker: w, deliverable: current }),
	});

	await runWorkerVerdict(deps, w);

	assert.equal(decisions[0]?.state, "ready");
});

test("runWorkerVerdict Use performs handoff only after current approval", async () => {
	const current = deliverable(2);
	const w = worker({ state: "ready", deliverable: { id: current.id, version: current.version, ref: current.ref } });
	const used: string[] = [];
	const { deps, decisions, calls } = depsFor(w, {
		showVerdict: async () => ({ verb: "use", worker: w, deliverable: current }),
		isDeliverableApproved: async () => true,
		useDeliverable: async (_worker, item) => { used.push(item.ref); },
	});

	const outcome = await runWorkerVerdict(deps, w);

	assert.equal(outcome, "stop");
	assert.deepEqual(used, [current.ref]);
	assert.equal(decisions.length, 0);
	assert.equal(calls.some((call) => call.startsWith("update:")), false);
});
