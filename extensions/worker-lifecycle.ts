import type { WorkerDeliverablePointer } from "./worker-deliverable.js";
import {
	formatWorkerDoneSummary,
	normalizeWorkerDoneInput,
	normalizeWorkerTodos,
	type WorkerDerivedState,
	type WorkerDoneInput,
	type WorkerProtocolState,
	type WorkerQuestion,
	type WorkerStatus,
	type WorkerTodoInput,
} from "./background-work.js";

export type WorkerTransition = (current: WorkerStatus) => Partial<WorkerStatus> | undefined;
export type PruneDisposition = "keep" | "prune" | "prune-with-debt";

const TERMINAL_STATES = new Set<WorkerStatus["state"]>(["ready", "failed", "error", "ended"]);
const HARVEST_STATES = new Set<WorkerStatus["state"]>(["failed", "error", "ended"]);

function sameWorkerDeliverablePointer(a: WorkerDeliverablePointer | undefined, b: WorkerDeliverablePointer | undefined): boolean {
	return Boolean(a && b && a.id === b.id && a.version === b.version && a.ref === b.ref);
}

export const WORKER_STALE_AFTER_MS = 90_000;

/**
 * Liveness, not progress. `updatedAt` only moves when something about the worker changed, so a
 * healthy worker reasoning through one long turn looks frozen by that measure; its heartbeat is
 * what proves the process is still there. Statuses written before heartbeats existed fall back
 * to `updatedAt` and keep their old behavior.
 */
function lastSignalAt(worker: WorkerStatus): number {
	const updated = Date.parse(worker.updatedAt);
	const heartbeat = worker.heartbeatAt ? Date.parse(worker.heartbeatAt) : Number.NaN;
	if (!Number.isFinite(heartbeat)) return updated;
	if (!Number.isFinite(updated)) return heartbeat;
	return Math.max(updated, heartbeat);
}

export function deriveWorkerLifecycleState(worker: WorkerStatus, now = Date.now()): WorkerDerivedState {
	if (worker.state === "needs_input") return "needs_input";
	if (worker.reviewedAt && TERMINAL_STATES.has(worker.state)) return "reviewed";
	if (worker.state === "failed" || worker.state === "error") return "failed";
	if (worker.state === "ready") return "ready";
	if (worker.state === "ended") return (worker.artifactCount ?? 0) === 0 ? "empty" : "ready";
	const ageMs = now - lastSignalAt(worker);
	if (Number.isFinite(ageMs) && ageMs > WORKER_STALE_AFTER_MS) return "stale";
	if (worker.state === "active") return "thinking";
	if (worker.state === "starting") return "starting";
	return "idle";
}

export function isReviewableWorker(worker: WorkerStatus, now = Date.now()): boolean {
	const state = deriveWorkerLifecycleState(worker, now);
	return state === "needs_input" || state === "failed" || state === "ready" || state === "ready_open_todos";
}

export function isRespawnEligible(worker: WorkerStatus): boolean {
	return worker.state === "ended" || worker.state === "error" || worker.state === "failed";
}

export function isPaneHarvestEligible(worker: WorkerStatus): boolean {
	return HARVEST_STATES.has(worker.state) && !worker.paneCapturedAt;
}

export function isDockTerminal(worker: WorkerStatus): boolean {
	return worker.state === "ended" || Boolean(worker.reviewedAt);
}

export function dockTerminalAgeMs(worker: WorkerStatus, now: number): number {
	const timestamp = Date.parse(worker.reviewedAt ?? worker.updatedAt);
	return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : 0;
}

export function pruneDisposition(worker: WorkerStatus, now: number, pruneMs: number, hasRecordedVerdict: boolean): PruneDisposition {
	if (pruneMs <= 0 || !isDockTerminal(worker) || dockTerminalAgeMs(worker, now) < pruneMs) return "keep";
	return hasRecordedVerdict ? "prune" : "prune-with-debt";
}

export function heartbeatTransition(input: { pid: number; sessionFile?: string; artifactCount: number; model?: string; thinking?: WorkerStatus["thinking"]; at?: string }): WorkerTransition {
	return (current) => {
		const state = current.state === "starting" || current.state === "active" ? "active" : current.state;
		return {
			state,
			pid: input.pid,
			sessionFile: input.sessionFile,
			artifactCount: input.artifactCount,
			heartbeatAt: input.at ?? new Date().toISOString(),
			...(input.model ? { model: input.model } : {}),
			...(input.thinking ? { thinking: input.thinking } : {}),
		};
	};
}

export function turnStartedTransition(): WorkerTransition {
	return (current) => current.state === "idle" ? { state: "active" } : undefined;
}

export function turnEndedTransition(): WorkerTransition {
	return (current) => current.state === "active" ? { state: "idle" } : undefined;
}

export function todosTransition(items: WorkerTodoInput[]): WorkerTransition {
	const todos = normalizeWorkerTodos(items);
	return () => ({ todos });
}

export function waitTransition(text: string, question: WorkerQuestion): WorkerTransition {
	return (current) => {
		const trimmed = text.trim();
		if (!trimmed) return undefined;
		const legacy = current.question && !current.questions?.length
			? [{ id: "legacy", text: current.question, createdAt: current.updatedAt }]
			: [];
		const questions = [...legacy, ...(current.questions ?? []), { ...question, text: trimmed }];
		return { state: "needs_input", question: questions.length === 1 ? trimmed : `${questions.length} questions`, questions, reviewedAt: undefined };
	};
}

export function protocolTransition(state: Exclude<WorkerProtocolState, "needs_input">, text?: string, doneInput?: WorkerDoneInput, deliverable?: WorkerDeliverablePointer): WorkerTransition {
	return () => {
		const patch: Partial<WorkerStatus> = {
			state,
			question: undefined,
			questions: [],
			summary: state === "ready" ? formatWorkerDoneSummary(doneInput ?? { summary: text }) : undefined,
			lastError: state === "failed" ? text : undefined,
			reviewedAt: undefined,
		};
		if (state === "ready") {
			if (deliverable) patch.deliverable = deliverable;
			const done = normalizeWorkerDoneInput(doneInput ?? { summary: text });
			if (done.outcome) patch.outcome = done.outcome;
			if (done.evidence?.length) patch.evidence = done.evidence;
			if (done.recommended?.length) patch.recommended = done.recommended;
			if (done.scopeConfidence) patch.scopeConfidence = done.scopeConfidence;
		}
		return patch;
	};
}

/**
 * Applied when the worker's runtime has actually taken a message off its inbox — never when a
 * transport merely accepted it (ADR-0008).
 *
 * A bound answer resolves the one question it names and leaves the rest open, so a worker with
 * two questions and one answer stays blocked on the second instead of being recorded as fully
 * answered. An unbound message is a redirection: the worker is being told what to do next, so
 * its outstanding questions are cleared and it resumes.
 *
 * A terminal worker is left entirely alone. Its process may still be alive and willing to chat,
 * but its published deliverable and pending verdict must survive the conversation.
 */
export function messageDeliveredTransition(input: { replyTo?: string } = {}): WorkerTransition {
	return (current) => {
		if (TERMINAL_STATES.has(current.state)) return undefined;
		const resume: Partial<WorkerStatus> = { state: "active", question: undefined, questions: [], reviewedAt: undefined };
		if (!input.replyTo) return resume;
		const open = current.questions ?? [];
		const remaining = open.filter((question) => question.id !== input.replyTo);
		// Unknown id: the question is already gone, so treat it as a plain redirection rather
		// than leaving the worker blocked on something nothing can answer.
		if (remaining.length === open.length || remaining.length === 0) return resume;
		return {
			state: "needs_input",
			question: remaining.length === 1 ? remaining[0]!.text : `${remaining.length} questions`,
			questions: remaining,
			reviewedAt: undefined,
		};
	};
}

/** Legacy tmux transport only: receipt is unobservable there, so the state moves on send. */
export function parentReplyAcceptedTransition(before: Pick<WorkerStatus, "state" | "question" | "questions">): WorkerTransition {
	return (current) => {
		if (current.state !== before.state && TERMINAL_STATES.has(current.state)) return undefined;
		return { state: "active", question: undefined, questions: [], reviewedAt: undefined };
	};
}

export function verdictResolvedTransition(at: string, deliverable?: WorkerDeliverablePointer): WorkerTransition {
	return (current) => {
		if (!TERMINAL_STATES.has(current.state)) return undefined;
		if (deliverable && !sameWorkerDeliverablePointer(current.deliverable, deliverable)) return undefined;
		return { reviewedAt: at };
	};
}

export function respawnStartedTransition(input: { tmuxSession: string; runToken: string; tmuxWindowId?: string; tmuxPaneId?: string }): WorkerTransition {
	return () => ({ state: "starting", tmuxSession: input.tmuxSession, runToken: input.runToken, paneCapturedAt: undefined, reviewedAt: undefined, deliverable: undefined, tmuxWindowId: input.tmuxWindowId, tmuxPaneId: input.tmuxPaneId });
}

export function respawnFailedTransition(message: string): WorkerTransition {
	return (current) => current.state === "starting" ? { state: "failed", lastError: message, reviewedAt: undefined } : undefined;
}

export function processExitedTransition(code: string | number): WorkerTransition {
	return (current) => {
		if (current.state === "needs_input" || TERMINAL_STATES.has(current.state)) return undefined;
		const numeric = Number(code);
		if (numeric === 0) return { state: "ended" };
		const label = Number.isFinite(numeric) ? String(numeric) : String(code);
		return { state: "failed", lastError: `worker process exited before reporting ready (exit ${label})` };
	};
}

export function sessionEndedTransition(): WorkerTransition {
	return (current) => (current.state === "starting" || current.state === "active" || current.state === "idle")
		? { state: "error", lastError: "tmux session ended; worker terminated" }
		: undefined;
}

export function orphanDetectedTransition(): WorkerTransition {
	return sessionEndedTransition();
}

export function paneHarvestedTransition(at: string): WorkerTransition {
	return (current) => current.paneCapturedAt ? undefined : { paneCapturedAt: at };
}
