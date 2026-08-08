import { workerQuestions, workerSourceLabel, workerSummaryName, type WorkerQuestion, type WorkerStatus } from "./background-work.js";

/**
 * The consult lane (ADR-0008).
 *
 * `docket_wait` asks the human and always has. A consult asks the *parent agent* a question it
 * can answer from this session's context — which file the project settled on, what a sibling
 * worker concluded — and it is the one path in Docket that spends parent model context. That is
 * why it is off by default, and why every surface says who answered.
 *
 * A consult is not a new worker state. It is a question whose audience is the parent agent, so
 * the whole existing `needs_input` lifecycle — status, verdict card, reply binding, decision
 * ledger — carries it unchanged. Escalation flips the audience back to the human, which is why
 * turning the feature off can never strand a worker: the question was always a question.
 */

export const DEFAULT_CONSULT_WINDOW_MS = 90_000;
export const MIN_CONSULT_WINDOW_MS = 5_000;

export type ConsultPolicy = {
	/** Whether the parent agent may answer. Off means every consult presents as a human question. */
	autoAnswer: boolean;
	/** How long a consult may wait for the parent agent before it escalates to the human. */
	windowMs: number;
};

export const CONSULT_POLICY_OFF: ConsultPolicy = { autoAnswer: false, windowMs: DEFAULT_CONSULT_WINDOW_MS };

export function resolveConsultPolicy(config: { autoAnswer?: boolean; consultWindowSeconds?: number } | undefined): ConsultPolicy {
	const seconds = config?.consultWindowSeconds;
	const windowMs = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
		? Math.max(MIN_CONSULT_WINDOW_MS, Math.round(seconds * 1000))
		: DEFAULT_CONSULT_WINDOW_MS;
	return { autoAnswer: config?.autoAnswer === true, windowMs };
}

export function isConsultQuestion(question: WorkerQuestion): boolean {
	return question.audience === "parent-agent";
}

/**
 * The consult still awaiting the parent agent, if any. An escalated question is no longer a
 * consult: its audience is the human, and it ranks and renders as an ordinary question.
 */
export function pendingConsult(worker: WorkerStatus): WorkerQuestion | undefined {
	const consults = workerQuestions(worker).filter((question) => isConsultQuestion(question) && !question.escalatedAt);
	return consults[consults.length - 1];
}

export function consultAgeMs(question: WorkerQuestion, now = Date.now()): number {
	const createdAt = Date.parse(question.createdAt);
	return Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : 0;
}

/**
 * A consult that outlived its window escalates. Blocking only costs nothing while the answer is
 * fast, so the window is what keeps "blocking" from quietly meaning "stuck".
 */
export function isConsultExpired(question: WorkerQuestion, policy: ConsultPolicy, now = Date.now()): boolean {
	return consultAgeMs(question, now) >= policy.windowMs;
}

/**
 * What the parent agent is asked. Deliberately closes on the two tool calls and on the
 * instruction to prefer escalating: a wrong answer arrives with the parent's authority attached
 * and is more expensive than a slower one.
 */
export function consultPromptText(worker: WorkerStatus, question: WorkerQuestion): string {
	const label = workerSourceLabel(worker);
	const kind = worker.kind && worker.kind !== "default" ? `${worker.kind} · ` : "";
	return [
		`Docket worker ${label} asked a question you may be able to answer from this session's context.`,
		"",
		`${label} · ${kind}${workerSummaryName(worker, 80)}`,
		`question: ${question.text}`,
		...(question.context ? [`context: ${question.context}`] : []),
		...(question.risk ? [`risk: ${question.risk}`] : []),
		...(question.options?.length ? [`options: ${question.options.join(" | ")}`] : []),
		"",
		`Call docket_answer only if this conversation already establishes the answer. Otherwise call docket_escalate and the human decides — a wrong answer carries your authority into ${label}'s work, so a slower answer is the cheaper mistake.`,
		"Respond with the tool call and nothing else.",
	].join("\n");
}

/** One-line parent surface for a consult exchange, collapsed. */
export function consultCallSummary(workerLabel: string, question: string, max = 72): string {
	const flat = question.replace(/\s+/g, " ").trim();
	return `${workerLabel} asked · ${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}`;
}

export function consultAnswerSummary(workerLabel: string, answer: string, max = 72): string {
	const flat = answer.replace(/\s+/g, " ").trim();
	return `answered ${workerLabel} · ${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}`;
}

export function consultEscalationSummary(workerLabel: string, why: string, max = 72): string {
	const flat = why.replace(/\s+/g, " ").trim();
	return `escalated ${workerLabel} to you · ${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}`;
}

/**
 * Why the human is now looking at this question. An escalated consult must never read like an
 * ordinary `docket_wait`: the worker expected a fast answer and did not get one.
 */
export function escalatedQuestionNote(question: WorkerQuestion): string | undefined {
	if (!question.escalatedAt) return undefined;
	return question.escalatedReason
		? `escalated from a consult · ${question.escalatedReason}`
		: "escalated from a consult · the parent agent could not answer it";
}
