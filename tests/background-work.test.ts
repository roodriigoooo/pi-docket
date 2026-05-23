import test from "node:test";
import assert from "node:assert/strict";
import { appendWorkerQuestionPatch, deriveWorkerState, formatWorkerDoneSummary, namespaceWorkerArtifacts, normalizeWorkerTodos, workerActivityChip, workerDoneClarificationQuestion, workerHasOpenTodos, workerHeartbeatPatch, workerLaunchDetail, workerLaunchSubject, workerMascotFrame, workerMascotLines, workerProtocolPatch, workerProtocolResultText, workerQuestions, workerShortLabel, workerStatusArtifact, workerTaskLooksVague, workerTodoBoardLines, workerTodoProgress, workerTodoSummary, workerTodosPatch, type WorkerQuestion, type WorkerStatus } from "../extensions/background-work.js";
import type { Artifact } from "../extensions/types.js";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 2,
		tmuxSession: "trail-worker-1",
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
	assert.equal(deriveWorkerState(worker({ state: "ready", todos: normalizeWorkerTodos([{ text: "Report findings", state: "pending" }]) })), "ready_open_todos");
	assert.equal(deriveWorkerState(worker({ state: "ended", artifactCount: 2 })), "ready");
	assert.equal(deriveWorkerState(worker({ state: "ended", artifactCount: 0 })), "empty");
	assert.equal(deriveWorkerState(worker({ state: "active", updatedAt: "2026-01-01T00:00:00.000Z" }), Date.parse("2026-01-01T00:02:00.000Z")), "stale");
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
	});
	assert.equal(workerProtocolResultText("failed"), "Trail failure recorded. Parent can review the failure.");
});

test("Background Work stores structured done outcomes", () => {
	const patch = workerProtocolPatch(worker(), "ready", "legacy", question("ignored"), {
		outcome: "proposal",
		summary: "Wrote candidate files.",
		evidence: [" wrote logo.svg ", ""],
		recommended: ["Review generated SVG", "Adopt markdown notes"],
		scopeConfidence: "clear",
	});

	assert.equal(formatWorkerDoneSummary({ summary: "Wrote candidate files.", recommended: ["Review generated SVG"] }), "Wrote candidate files.\n\nRecommended:\n- Review generated SVG");
	assert.equal(patch?.summary, "Wrote candidate files.\n\nRecommended:\n- Review generated SVG\n- Adopt markdown notes");
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
	assert.equal(workerActivityChip(worker({ state: "starting" }), { now: 0 }), "w2[o  ]");
	assert.equal(workerActivityChip(worker({ state: "active" }), { now: 400 }), "w2(o_o)");
	assert.equal(workerActivityChip(worker({ state: "needs_input", questions: [question("One?"), question("Two?")] })), "w2(?_?)");
	assert.equal(workerActivityChip(worker({ state: "ready" }), { verbose: true }), "w2(^_^) ready");
	assert.equal(workerActivityChip(worker({ state: "ready", summary: "mascot viable" }), { verbose: true }), "w2(^_^) mascot viable");
	assert.equal(workerActivityChip(worker({ state: "ready", todos: normalizeWorkerTodos([{ text: "Report findings", state: "pending" }]) }), { verbose: true }), "w2(^_?) ready · open todos 0/1 · Report findings");
	assert.equal(workerMascotFrame(worker({ state: "failed" })), "(x_x)");
	assert.deepEqual(workerMascotLines(worker({ state: "ready" })).slice(0, 2), ["  (^_^)", "  /|\\  w2"]);
});

test("Background Work formats live worker launch banner", () => {
	assert.equal(workerLaunchSubject(worker({ state: "active" }), { now: Date.parse("2026-01-01T00:00:00.400Z") }), "spawned w2(o_o) · thinking");
	assert.equal(workerLaunchSubject(worker({ state: "ready", summary: "done" })), "spawned w2(^_^) · ready");
	assert.match(workerLaunchDetail(worker({ state: "ready", summary: "done" })), /status: w2\(\^_\^\) done/);
	assert.match(workerLaunchDetail(worker()), /inbox:  \/trail/);
});

test("Background Work surfaces kind in chip and launch detail", () => {
	const scout = worker({ state: "active", kind: "scout" });
	assert.equal(workerActivityChip(scout, { now: 400 }), "w2·scout(o_o)");
	assert.equal(workerLaunchSubject(scout, { now: 400 }), "spawned w2·scout(o_o) · thinking");
	assert.match(workerLaunchDetail(scout, { now: 400 }), /kind:   scout/);
	const defaultKind = worker({ state: "active", kind: "default" });
	assert.equal(workerActivityChip(defaultKind, { now: 400 }), "w2(o_o)");
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
		"Todos (1/3)",
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
	assert.match(artifact?.body ?? "", /progress:\nTodos \(0\/1\)/);
});

test("Background Work marks ready workers with open todos separately", () => {
	const status = worker({ state: "ready", summary: "done", todos: normalizeWorkerTodos([{ text: "Inspect", state: "completed" }, { text: "Report", state: "pending" }]) });
	const artifact = workerStatusArtifact(status);

	assert.equal(deriveWorkerState(status), "ready_open_todos");
	assert.equal(artifact?.meta?.workerStatus, "ready_open_todos");
	assert.equal(artifact?.meta?.todoOpenCount, 1);
	assert.match(artifact?.title ?? "", /ready · open todos 1\/2/);
	assert.match(artifact?.body ?? "", /state: ready_open_todos/);
});

test("Background Work namespaces worker artifacts by worker label", () => {
	const artifact: Artifact = { id: "a1", displayId: "a1", ref: "command:1", kind: "command", title: "npm test", subtitle: "", body: "", timestamp: 1 };
	assert.deepEqual(namespaceWorkerArtifacts(worker(), [artifact]).map((item) => [item.id, item.displayId, item.source]), [["w2.a1", "w2.a1", "w2"]]);
	assert.equal(workerShortLabel(2), "w2");
	assert.deepEqual(workerQuestions(worker({ question: "Legacy?" })).map((q) => q.text), ["Legacy?"]);
});
