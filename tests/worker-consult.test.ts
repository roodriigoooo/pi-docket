import test from "node:test";
import assert from "node:assert/strict";
import {
	CONSULT_POLICY_OFF,
	DEFAULT_CONSULT_WINDOW_MS,
	consultAnswerCallSummary,
	consultAnswerSummary,
	consultCallSummary,
	consultEscalationCallSummary,
	consultEscalationNotice,
	consultEscalationSummary,
	consultPromptText,
	escalatedQuestionNote,
	isConsultExpired,
	isConsultQuestion,
	pendingConsult,
	resolveConsultPolicy,
} from "../extensions/worker-consult.js";
import { consultEscalatedTransition, isReviewableWorker } from "../extensions/worker-lifecycle.js";
import { deriveWorkerState, workerStatusArtifact, type WorkerQuestion, type WorkerStatus } from "../extensions/background-work.js";
import { verdictVerbs } from "../extensions/docket.js";

const question: WorkerQuestion = { id: "q1", text: "Retry wrapper in http/client.ts or a new http/retry.ts?", createdAt: "2026-01-01T00:00:00.000Z" };

const base: WorkerStatus = {
	id: "worker-1",
	index: 1,
	tmuxSession: "docket-workers",
	task: "add retry/backoff to the http client",
	cwd: "/repo",
	kind: "patcher",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	state: "needs_input",
	questions: [question],
	question: question.text,
};

function consulting(overrides: Partial<WorkerQuestion> = {}): WorkerStatus {
	return { ...base, questions: [{ ...question, audience: "parent-agent", ...overrides }] };
}

test("the policy is off unless the human turned it on", () => {
	assert.deepEqual(resolveConsultPolicy(undefined), CONSULT_POLICY_OFF);
	assert.equal(resolveConsultPolicy({}).autoAnswer, false);
	assert.equal(resolveConsultPolicy({ autoAnswer: false }).autoAnswer, false);
	assert.equal(resolveConsultPolicy({ autoAnswer: true }).autoAnswer, true);
});

test("the escalation window has a floor and a default", () => {
	assert.equal(resolveConsultPolicy({}).windowMs, DEFAULT_CONSULT_WINDOW_MS);
	assert.equal(resolveConsultPolicy({ consultWindowSeconds: 30 }).windowMs, 30_000);
	// A window of zero would escalate every consult instantly and make the lane useless.
	assert.ok(resolveConsultPolicy({ consultWindowSeconds: 0 }).windowMs >= 5_000);
	assert.ok(resolveConsultPolicy({ consultWindowSeconds: -5 }).windowMs >= 5_000);
});

test("a consult derives its own state, distinct from a question", () => {
	assert.equal(deriveWorkerState(base), "needs_input");
	assert.equal(deriveWorkerState(consulting()), "consulting");
});

test("a consult is still a reviewable worker the human can answer by hand", () => {
	assert.equal(isReviewableWorker(consulting()), true);
	// Same verbs as a question: turning auto-answer off loses no capability.
	assert.deepEqual(
		verdictVerbs("consulting", false, ["client.ts", "retry.ts"]).map((verb) => verb.id),
		verdictVerbs("needs_input", false, ["client.ts", "retry.ts"]).map((verb) => verb.id),
	);
});

test("pendingConsult finds only an unescalated parent-agent question", () => {
	assert.equal(pendingConsult(base), undefined);
	assert.equal(pendingConsult(consulting())?.id, "q1");
	assert.equal(pendingConsult(consulting({ escalatedAt: "2026-01-01T00:02:00.000Z" })), undefined);
	assert.equal(isConsultQuestion(question), false);
});

test("an escalated consult stops being a consult and becomes an ordinary question", () => {
	const patch = consultEscalatedTransition({ questionId: "q1", reason: "needs a scope decision", at: "2026-01-01T00:02:00.000Z" })(consulting());

	assert.equal(patch?.questions?.[0]?.audience, "human");
	assert.equal(patch?.questions?.[0]?.escalatedAt, "2026-01-01T00:02:00.000Z");
	// The question keeps its id, so a reply still binds to it.
	assert.equal(patch?.questions?.[0]?.id, "q1");
	assert.equal(deriveWorkerState({ ...consulting(), ...patch }), "needs_input");
});

test("escalation is idempotent and ignores an unknown question", () => {
	const already = consulting({ escalatedAt: "2026-01-01T00:02:00.000Z" });
	assert.equal(consultEscalatedTransition({ questionId: "q1" })(already), undefined);
	assert.equal(consultEscalatedTransition({ questionId: "nope" })(consulting()), undefined);
});

test("escalation leaves the human a reason, never a bare question", () => {
	assert.equal(escalatedQuestionNote(question), undefined);
	assert.match(escalatedQuestionNote({ ...question, escalatedAt: "x" })!, /escalated from a consult/);
	assert.match(escalatedQuestionNote({ ...question, escalatedAt: "x", escalatedReason: "needs a scope call" })!, /needs a scope call/);
});

test("a consult expires into the human's lap once its window passes", () => {
	const policy = resolveConsultPolicy({ autoAnswer: true, consultWindowSeconds: 60 });
	const created = Date.parse(question.createdAt);

	assert.equal(isConsultExpired(question, policy, created + 59_000), false);
	assert.equal(isConsultExpired(question, policy, created + 60_000), true);
});

test("the parent agent is told to escalate rather than guess", () => {
	const prompt = consultPromptText(consulting({ context: "client.ts is 340 lines", risk: "changes the public surface", options: ["client.ts", "retry.ts"] }), { ...question, audience: "parent-agent", context: "client.ts is 340 lines", options: ["client.ts", "retry.ts"] });

	assert.match(prompt, /w1/);
	assert.match(prompt, /docket_answer/);
	assert.match(prompt, /docket_escalate/);
	assert.match(prompt, /client\.ts is 340 lines/);
	assert.match(prompt, /options: client\.ts \| retry\.ts/);
	assert.match(prompt, /slower answer is the cheaper mistake/);
});

test("consult surfaces collapse to one true line", () => {
	assert.equal(consultCallSummary("w1", "Which file?"), "w1 asked · Which file?");
	assert.match(consultCallSummary("w1", "x".repeat(200), 20), /^w1 asked · x{19}…$/);
	assert.match(consultAnswerSummary("w1", "new file"), /^answered w1 · new file$/);
	// The collapsed escalation line carries the question, because answering it is what the human
	// has to do; the agent's reason for declining lives behind the expand control.
	assert.match(consultEscalationSummary("w1", "Where should expiry live?"), /^w1 needs you · Where should expiry live\?$/);
});

test("an escalation says each thing once across its surfaces", () => {
	const question = "Where should expiry live?";
	const why = "not established by this session";
	// The in-flight line names the act, never the content: pi draws it directly above the result,
	// so anything it repeats is read twice before the human has pressed anything.
	assert.equal(consultEscalationCallSummary("w1"), "handing w1's question to you");
	assert.doesNotMatch(consultEscalationCallSummary("w1"), /expiry|established/);
	// The notification is a pointer to the decision, not a copy of the reasoning behind it.
	assert.match(consultEscalationNotice("w1", question), /^w1 needs you · Where should expiry live\?$/);
	assert.ok(!consultEscalationNotice("w1", question).includes(why));
	assert.equal(consultAnswerCallSummary("w1"), "answering w1");
});

test("a consulting worker still produces a status artifact the human can open", () => {
	const artifact = workerStatusArtifact(consulting());

	assert.ok(artifact);
	assert.match(artifact!.title, /^w1 consulting/);
	assert.equal(artifact!.meta?.workerStatus, "consulting");
});
