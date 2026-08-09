import test from "node:test";
import assert from "node:assert/strict";
import { appendWorkerQuestionPatch, buildWorkerInitialPrompt, buildWorkerTaskDocument, deriveWorkerState, formatWorkerDoneSummary, isPaneHarvestCandidate, namespaceWorkerArtifacts, normalizeWorkerTodos, openWorkerQuestion, workerActivityChip, workerDoneClarificationQuestion, workerHasOpenTodos, workerHeartbeatPatch, workerInputAcceptedPatch, workerLaunchDetail, workerLaunchSubject, workerMascotFrame, workerMascotLines, workerPaneTailArtifact, workerPulseGlyph, DOCK_PULSE_INTERVAL_MS, workerProtocolPatch, workerProtocolResultText, workerQuestions, workerShortLabel, workerStateRank, workerStatusArtifact, workerTaskLooksVague, workerTodoBoardLines, workerTodoProgress, workerTodoSummary, workerTodosPatch, type WorkerQuestion, type WorkerStatus } from "../extensions/background-work.js";
import type { Artifact } from "../extensions/types.js";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 2,
		tmuxSession: "docket-worker-1",
		task: "inspect failing tests",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "active",
		...partial,
	};
}

function question(text: string): WorkerQuestion {
	return { id: `q-${text.length}`, text, createdAt: "2026-01-01T00:01:00.000Z" };
}

test("Background Work derives attention states", () => {
	assert.equal(deriveWorkerState(worker({ state: "needs_input" })), "needs_input");
	assert.equal(deriveWorkerState(worker({ state: "error" })), "failed");
	assert.equal(deriveWorkerState(worker({ state: "ready", todos: normalizeWorkerTodos([{ text: "Report findings", state: "pending" }]) })), "ready");
	// Reading files is not handing work in. Only `docket_done` writes a summary/outcome, so only
	// that earns `ready`; a process that merely stopped is `stopped`.
	assert.equal(deriveWorkerState(worker({ state: "ended", artifactCount: 2 })), "stopped");
	assert.equal(deriveWorkerState(worker({ state: "ended", artifactCount: 2, summary: "did the thing" })), "ready");
	assert.equal(deriveWorkerState(worker({ state: "ended", artifactCount: 0 })), "empty");
	assert.equal(deriveWorkerState(worker({ state: "active", updatedAt: "2026-01-01T00:00:00.000Z" }), Date.parse("2026-01-01T00:02:00.000Z")), "stale");
});

test("Background Work derives reviewed state from reviewedAt on terminal workers", () => {
	const now = new Date().toISOString();
	assert.equal(deriveWorkerState(worker({ state: "ready", reviewedAt: now })), "reviewed");
	assert.equal(deriveWorkerState(worker({ state: "ended", artifactCount: 3, reviewedAt: now })), "reviewed");
	assert.equal(deriveWorkerState(worker({ state: "failed", reviewedAt: now })), "reviewed");
	assert.equal(deriveWorkerState(worker({ state: "error", reviewedAt: now })), "reviewed");
	// needs_input is live attention: reviewedAt must not mask it (defensive — parent never sets it there).
	assert.equal(deriveWorkerState(worker({ state: "needs_input", reviewedAt: now })), "needs_input");
	// reviewedAt absent → normal derivation.
	assert.equal(deriveWorkerState(worker({ state: "ready" })), "ready");
});

test("Background Work workerStateRank orders reviewed below idle attention", () => {
	const now = new Date().toISOString();
	const question = { id: "q1", text: "which?", createdAt: now };
	const blocked = workerStateRank(worker({ state: "needs_input", questions: [question] }));
	const consulting = workerStateRank(worker({ state: "needs_input", questions: [{ ...question, audience: "parent-agent" as const }] }));
	const ready = workerStateRank(worker({ state: "ready" }));
	const reviewed = workerStateRank(worker({ state: "ready", reviewedAt: now }));

	// A question outranks a consult: only one of them is blocked on the human.
	assert.equal(blocked, 0);
	assert.ok(blocked < consulting, "a question outranks a consult");
	assert.ok(consulting < ready, "a blocked worker outranks a ready one");
	assert.ok(ready < reviewed, "reviewed sinks below everything still asking");
});

test("Background Work input/question patches clear reviewedAt so a reviewed worker re-surfaces", () => {
	const accepted = workerInputAcceptedPatch();
	assert.equal(accepted.reviewedAt, undefined);
	const q = appendWorkerQuestionPatch(worker({ state: "ready", reviewedAt: "2026-01-01T00:00:00.000Z" }), "again?", question("again?"));
	assert.equal(q?.reviewedAt, undefined);
});

test("Background Work appends protocol questions without losing legacy question", () => {
	const current = worker({ question: "First?" });
	const patch = appendWorkerQuestionPatch(current, "Second?", question("Second?"));

	assert.equal(patch?.state, "needs_input");
	assert.equal(patch?.question, "2 questions");
	assert.deepEqual(patch?.questions?.map((q) => q.text), ["First?", "Second?"]);
});

test("Background Work protocol patch clears questions for ready and failed states", () => {
	const current = worker({ state: "needs_input", questions: [question("Proceed?")], question: "Proceed?" });

	assert.deepEqual(workerProtocolPatch(current, "ready", "done", question("ignored")), {
		state: "ready",
		question: undefined,
		questions: [],
		summary: "done",
		lastError: undefined,
		reviewedAt: undefined,
	});
	assert.equal(workerProtocolResultText("failed"), "Docket failure recorded. Parent can review the failure.");
});

test("waiting tells the worker to end its turn, and what a second call just cost", () => {
	const first = workerProtocolResultText("needs_input", 1);
	assert.match(first, /End your turn now/);
	assert.match(first, /do not look for the reply on disk/, "a blocked worker went hunting for an inbox it cannot read");

	// A worker that calls this while already blocked has not stopped. Each restatement becomes
	// another card the human answers separately, so the result names the cost rather than
	// repeating the same cheerful acknowledgement.
	const again = workerProtocolResultText("needs_input", 3);
	assert.match(again, /already waiting on 2 questions/);
	assert.match(again, /3 to answer separately/);
	assert.match(again, /unblocked later/);
	assert.match(again, /do not call this tool again/);

	assert.match(workerProtocolResultText("needs_input", 2), /already waiting on 1 question;/, "singular reads as singular");
});

test("an unanswered reply binds to the question the worker asked first", () => {
	const blocked = {
		...worker(),
		state: "needs_input" as const,
		questions: [
			{ id: "q1", text: "Required or optional?", createdAt: "2026-01-01T00:01:00.000Z" },
			{ id: "q2", text: "No concrete choice came back.", createdAt: "2026-01-01T00:02:00.000Z" },
		],
	};

	assert.equal(openWorkerQuestion(blocked)?.id, "q1");
	assert.equal(openWorkerQuestion(worker())?.id, undefined, "nothing open, nothing to answer");
});

test("Background Work stores structured done outcomes", () => {
	const patch = workerProtocolPatch(worker(), "ready", "legacy", question("ignored"), {
		outcome: "proposal",
		summary: "Wrote candidate files.",
		evidence: [" wrote logo.svg ", ""],
		recommended: ["Review generated SVG", "Adopt markdown notes"],
		scopeConfidence: "clear",
	});

	assert.equal(formatWorkerDoneSummary({ summary: "Wrote candidate files.", recommended: ["Review generated SVG"] }), "Wrote candidate files.");
	assert.equal(patch?.summary, "Wrote candidate files.");
	assert.equal(patch?.outcome, "proposal");
	assert.deepEqual(patch?.evidence, ["wrote logo.svg"]);
	assert.deepEqual(patch?.recommended, ["Review generated SVG", "Adopt markdown notes"]);
	assert.equal(patch?.scopeConfidence, "clear");
});

test("Background Work asks for clarification on vague no-evidence done", () => {
	const vague = worker({ task: "find the bear..." });
	const scoped = worker({ task: "find bear references in repo" });

	assert.equal(workerTaskLooksVague(vague.task), true);
	assert.equal(workerTaskLooksVague(scoped.task), false);
	assert.match(workerDoneClarificationQuestion(vague, { outcome: "no_evidence", summary: "No bear refs found.", scopeConfidence: "unclear" }) ?? "", /What exactly/);
	assert.match(workerDoneClarificationQuestion(vague, { outcome: "no_evidence", summary: "No bear refs found.", scopeConfidence: "clear" }) ?? "", /What exactly/);
	assert.match(workerDoneClarificationQuestion(vague, { summary: "No bear refs found." }, { artifactEvidenceCount: 1 }) ?? "", /What exactly/);
	assert.equal(workerDoneClarificationQuestion(scoped, { outcome: "no_evidence", summary: "No bear refs found.", scopeConfidence: "clear" }), undefined);
});

test("Background Work heartbeat preserves sticky attention states", () => {
	assert.equal(workerHeartbeatPatch(worker({ state: "needs_input" }), { pid: 123, artifactCount: 4 }).state, "needs_input");
	assert.equal(workerHeartbeatPatch(worker({ state: "ready" }), { pid: 123, artifactCount: 4 }).state, "ready");
	assert.equal(workerHeartbeatPatch(worker({ state: "failed" }), { pid: 123, artifactCount: 4 }).state, "failed");
	assert.equal(workerHeartbeatPatch(worker({ state: "idle" }), { pid: 123, artifactCount: 4 }).state, "idle");
	assert.equal(workerHeartbeatPatch(worker({ state: "active" }), { pid: 123, artifactCount: 4 }).state, "active");
});

test("Background Work formats compact activity chips", () => {
	assert.equal(workerActivityChip(worker({ state: "starting" }), { now: 0 }), "w2");
	assert.equal(workerActivityChip(worker({ state: "active" }), { now: 400 }), "w2");
	assert.equal(workerActivityChip(worker({ state: "needs_input", questions: [question("One?"), question("Two?")] })), "w2(?_?)");
	assert.equal(workerActivityChip(worker({ state: "ready" }), { verbose: true }), "w2(^_^) ready");
	assert.equal(workerActivityChip(worker({ state: "ready", summary: "mascot viable" }), { verbose: true }), "w2(^_^) mascot viable");
	assert.equal(workerActivityChip(worker({ state: "ready", todos: normalizeWorkerTodos([{ text: "Report findings", state: "pending" }]) }), { verbose: true }), "w2(^_^) 0/1 · Report findings");
	assert.equal(workerMascotFrame(worker({ state: "failed" })), "(x_x)");
	assert.deepEqual(workerMascotLines(worker({ state: "ready" })).slice(0, 2), ["  (^_^)", "  /|\\  w2"]);
});

test("Background Work pulse glyph cycles on the dock cadence", () => {
	assert.equal(workerPulseGlyph(0), "·");
	assert.equal(workerPulseGlyph(DOCK_PULSE_INTERVAL_MS * 3), "●");
	assert.equal(workerPulseGlyph(DOCK_PULSE_INTERVAL_MS * 6), "·");
});

test("Background Work formats live worker launch banner", () => {
	assert.equal(workerLaunchSubject(worker({ state: "active" }), { now: Date.parse("2026-01-01T00:00:00.400Z") }), "spawned w2 · thinking");
	assert.equal(workerLaunchSubject(worker({ state: "ready", summary: "done" })), "spawned w2(^_^) · ready");
	assert.match(workerLaunchDetail(worker({ state: "ready", summary: "done", model: "anthropic/claude", thinking: "high" })), /status: w2\(\^_\^\) done/);
	assert.match(workerLaunchDetail(worker({ model: "anthropic/claude", thinking: "high" })), /model:  anthropic\/claude/);
	assert.match(workerLaunchDetail(worker({ model: "anthropic/claude", thinking: "high" })), /thinking: high/);
	assert.match(workerLaunchDetail(worker()), /model:  unknown[\s\S]*thinking: unknown/);
	assert.match(workerLaunchDetail(worker()), /inbox:  \/docket/);
});

test("Background Work builds task docs with pre-flight brief and plan gate", () => {
	const doc = buildWorkerTaskDocument({
		task: "Implement auth fix",
		kind: "patcher",
		worktree: true,
		planGate: true,
		decisionRights: ["May edit src/auth.ts after approval"],
	});

	assert.match(doc, /^# Task/m);
	assert.match(doc, /Implement auth fix/);
	assert.match(doc, /## Pre-flight brief/);
	assert.match(doc, /Kind: patcher/);
	assert.match(doc, /## Decision rights/);
	assert.match(doc, /May edit src\/auth\.ts after approval/);
	assert.match(doc, /## Plan gate/);
	assert.match(doc, /After read-only discovery and before the first file edit/);
});

test("Background Work task and initial prompt contain no worker hierarchy language", () => {
	const task = buildWorkerTaskDocument({ task: "Inspect auth", kind: "scout", worktree: false });
	const prompt = buildWorkerInitialPrompt({ label: "w2", id: "worker-2", taskFile: "/tmp/task.md", artifactsFile: "/tmp/artifacts.json", kind: "scout" });
	assert.doesNotMatch(task, /parent worker|child|depth/i);
	assert.doesNotMatch(prompt, /parent worker|child|depth|dispatched by/i);
});

test("Background Work surfaces kind in chip and launch detail", () => {
	const scout = worker({ state: "active", kind: "scout" });
	assert.equal(workerActivityChip(scout, { now: 400 }), "w2·scout");
	assert.equal(workerLaunchSubject(scout, { now: 400 }), "spawned w2·scout · thinking");
	assert.match(workerLaunchDetail(scout, { now: 400 }), /kind:   scout/);
	const defaultKind = worker({ state: "active", kind: "default" });
	assert.equal(workerActivityChip(defaultKind, { now: 400 }), "w2");
	assert.doesNotMatch(workerLaunchDetail(defaultKind, { now: 400 }), /kind:/);
});

test("Background Work normalizes and summarizes worker todos", () => {
	const todos = normalizeWorkerTodos([
		{ text: "Read current worker flow", state: "completed" },
		{ id: "ui", text: "Render board in dock", state: "in_progress", note: "wiring UI" },
		{ text: "Document protocol", state: "pending" },
	]);
	const status = worker({ todos });

	assert.deepEqual(workerTodoProgress(status), { total: 3, completed: 1, inProgress: 1, pending: 1 });
	assert.equal(workerHasOpenTodos(status), true);
	assert.equal(workerTodoSummary(status), "1/3 · Render board in dock (wiring UI)");
	assert.deepEqual(workerTodoBoardLines(status, { includeHeader: true }), [
		"Progress (1/3)",
		"├ ✓ Read current worker flow",
		"├ ◐ Render board in dock (wiring UI)",
		"└ ○ Document protocol",
	]);
	assert.deepEqual(workerTodosPatch([{ text: "Done", state: "done" }]), { todos: [{ id: "t1", text: "Done", state: "completed", note: undefined }] });
});

test("Background Work projects worker status into synthetic Review Artifact", () => {
	const status = worker({ state: "needs_input", questions: [question("Choose target?")], updatedAt: "2026-01-01T00:01:00.000Z", todos: normalizeWorkerTodos([{ text: "Pick target", state: "in_progress" }]) });
	const artifact = workerStatusArtifact(status);

	assert.equal(artifact?.ref, "worker-status:worker-1:0");
	assert.equal(artifact?.kind, "response");
	assert.equal(artifact?.meta?.workerStatus, "needs_input");
	assert.equal(artifact?.meta?.todoCount, 1);
	assert.match(artifact?.title ?? "", /w2 needs input/);
	assert.match(artifact?.body ?? "", /progress:\nProgress \(0\/1\)/);
});

test("Background Work treats ready progress as informational", () => {
	const status = worker({ state: "ready", summary: "done", todos: normalizeWorkerTodos([{ text: "Inspect", state: "completed" }, { text: "Report", state: "pending" }]) });
	const artifact = workerStatusArtifact(status);

	assert.equal(deriveWorkerState(status), "ready");
	assert.equal(artifact?.meta?.workerStatus, "ready");
	assert.equal(artifact?.meta?.todoOpenCount, 1);
	assert.match(artifact?.title ?? "", /w2 ready: done/);
	assert.match(artifact?.body ?? "", /state: ready/);
	assert.match(artifact?.body ?? "", /Progress \(1\/2\)/);
});

test("Background Work namespaces worker artifacts by worker label", () => {
	const artifact: Artifact = { id: "a1", displayId: "a1", ref: "command:1", kind: "command", title: "npm test", subtitle: "", body: "", timestamp: 1 };
	assert.deepEqual(namespaceWorkerArtifacts(worker(), [artifact]).map((item) => [item.id, item.displayId, item.source]), [["w2.a1", "w2.a1", "w2"]]);
	assert.equal(workerShortLabel(2), "w2");
	assert.deepEqual(workerQuestions(worker({ question: "Legacy?" })).map((q) => q.text), ["Legacy?"]);
});

test("Background Work flags pane harvest candidates by terminal state and capture marker", () => {
	assert.equal(isPaneHarvestCandidate(worker({ state: "failed" })), true);
	assert.equal(isPaneHarvestCandidate(worker({ state: "error" })), true);
	assert.equal(isPaneHarvestCandidate(worker({ state: "ended" })), true);
	assert.equal(isPaneHarvestCandidate(worker({ state: "active" })), false);
	assert.equal(isPaneHarvestCandidate(worker({ state: "needs_input" })), false);
	assert.equal(isPaneHarvestCandidate(worker({ state: "failed", paneCapturedAt: "2026-01-01T00:05:00.000Z" })), false);
});

test("Background Work builds a terminal-tail evidence artifact that stays out of the review queue", () => {
	const artifact = workerPaneTailArtifact(worker({ state: "failed" }), "boot ok\nError: missing DATABASE_URL\n\n");
	assert.equal(artifact?.kind, "command");
	assert.equal(artifact?.ref, "worker-pane:worker-1:0");
	assert.equal(artifact?.title, "w2 terminal tail");
	assert.match(artifact?.body ?? "", /missing DATABASE_URL/);
	assert.equal(artifact?.meta?.paneTail, true);
	assert.equal(workerPaneTailArtifact(worker(), "   \n  \n"), undefined);
});

test("Background Work task doc names reviewed handoff source without changing authority", () => {
	const doc = buildWorkerTaskDocument({
		task: "Implement reviewed plan",
		sourceHandoff: {
			sourceDeliverableId: "worker-deliverable:w1",
			sourceVersion: 2,
			sourceRef: "worker-deliverable:w1:2",
			sourceWorkerId: "worker-1",
			sourceWorkerLabel: "w1",
			approvingDecisionId: "d1",
			approvedAt: "2026-01-01T00:00:00.000Z",
			sidecarPath: "/tmp/source-deliverable.md",
		},
	});
	assert.match(doc, /Reviewed source deliverable/);
	assert.match(doc, /worker-deliverable:w1:2/);
	assert.match(doc, /does not override current decision rights or guardrails/);
});

const APPROVED_PLAN_HANDOFF = {
	sourceDeliverableId: "worker-deliverable:w1",
	sourceVersion: 2,
	sourceRef: "worker-deliverable:w1:2",
	sourceKind: "worker" as const,
	sourceWorkerLabel: "w1",
	approvingDecisionId: "dec-9",
	approvedAt: "2026-01-01T00:00:00.000Z",
	sidecarPath: "/tmp/w2/source-deliverable.md",
};

test("Background Work discharges the plan gate for an approved plan handoff", () => {
	const doc = buildWorkerTaskDocument({
		task: "Implement approved plan worker-deliverable:w1:2",
		kind: "implementer",
		worktree: true,
		planGate: true,
		sourceHandoff: APPROVED_PLAN_HANDOFF,
		planAuthorized: true,
	});

	assert.match(doc, /## Approved plan/);
	assert.match(doc, /Read the sidecar before your first move/);
	assert.match(doc, /Satisfied at launch by approved worker-deliverable:w1:2 \(v2, decision dec-9\)/);
	assert.match(doc, /Publish the plan's numbered steps with `docket_todos`/);
	assert.match(doc, /The gate re-opens for anything the approved plan does not cover/);
	assert.match(doc, /Edit the files the approved plan names/);
	// The discharged gate replaces the ask-first gate rather than sitting beside it.
	assert.doesNotMatch(doc, /After read-only discovery and before the first file edit/);
});

test("Background Work never discharges a plan gate without a reviewed handoff", () => {
	const doc = buildWorkerTaskDocument({ task: "Implement something", kind: "implementer", worktree: true, planGate: true, planAuthorized: true });
	assert.match(doc, /After read-only discovery and before the first file edit/);
	assert.doesNotMatch(doc, /Satisfied at launch/);
});

test("Background Work keeps the ask-first gate on an unauthorized handoff", () => {
	const doc = buildWorkerTaskDocument({ task: "Use these findings", kind: "patcher", worktree: true, planGate: true, sourceHandoff: APPROVED_PLAN_HANDOFF });
	assert.match(doc, /## Reviewed source deliverable/);
	assert.match(doc, /After read-only discovery and before the first file edit/);
	assert.doesNotMatch(doc, /Satisfied at launch/);
});
