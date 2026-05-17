import { deriveWorkerState, workerActivityChip, workerDisplayName, workerQuestions, workerSourceLabel, workerStateRank, workerTodoBoardLines, workerTodoProgress, type WorkerDerivedState, type WorkerQuestion, type WorkerStatus } from "./background-work.js";
import { isWorkerStatusArtifact, workerResultArtifact, workerResultSummary } from "./worker-result.js";
import type { Artifact } from "./types.js";

export type WorkerActivityRow = {
	worker: WorkerStatus;
	label: string;
	chip: string;
	state: WorkerDerivedState;
	stateLabel: string;
	message: string;
	answer?: Artifact;
	answerLine?: string;
	questions: WorkerQuestion[];
	progress: { total: number; completed: number; inProgress: number; pending: number };
	todoLines: string[];
	updatedAt: number;
};

export type WorkerActivityStackLine = {
	kind: "worker" | "answer" | "question" | "todo";
	state: WorkerDerivedState;
	worker: WorkerStatus;
	text: string;
};

export type WorkerActivityTotals = {
	workers: number;
	active: number;
	waiting: number;
	ready: number;
	readyOpenTodos: number;
	failed: number;
	todos: number;
	completedTodos: number;
};

function firstLine(text: string | undefined): string | undefined {
	const line = text?.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
	return line || undefined;
}

export function workerActivityStateLabel(state: WorkerDerivedState): string {
	if (state === "needs_input") return "needs input";
	if (state === "ready_open_todos") return "ready · open todos";
	if (state === "ready") return "ready";
	if (state === "failed") return "failed";
	if (state === "thinking") return "active";
	if (state === "starting") return "starting";
	if (state === "stale") return "stale";
	if (state === "empty") return "done · empty";
	return "idle";
}

export function workerActivityRows(workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]> = new Map(), options: { now?: number; maxTodoItems?: number } = {}): WorkerActivityRow[] {
	const now = options.now ?? Date.now();
	return workers.map((worker) => {
		const artifacts = artifactsByWorker.get(worker.id) ?? [];
		const state = deriveWorkerState(worker, now);
		const answer = workerResultArtifact(worker, artifacts);
		const answerLine = answer && !isWorkerStatusArtifact(answer) ? firstLine(answer.title) ?? firstLine(answer.body) : undefined;
		const questions = workerQuestions(worker);
		const questionText = questions.map((question, index) => `${index + 1}. ${question.text}`).join(" ");
		const message = state === "needs_input" && questionText ? questionText : workerResultSummary(worker, artifacts) || workerDisplayName(worker);
		return {
			worker,
			label: workerSourceLabel(worker),
			chip: workerActivityChip(worker, { now }),
			state,
			stateLabel: workerActivityStateLabel(state),
			message,
			answer,
			answerLine,
			questions,
			progress: workerTodoProgress(worker),
			todoLines: workerTodoBoardLines(worker, { maxItems: options.maxTodoItems ?? 12, maxText: Number.POSITIVE_INFINITY }),
			updatedAt: Date.parse(worker.updatedAt) || 0,
		};
	}).sort((a, b) => workerStateRank(a.worker, now) - workerStateRank(b.worker, now) || b.updatedAt - a.updatedAt);
}

export function workerActivityTotals(rows: WorkerActivityRow[]): WorkerActivityTotals {
	return rows.reduce((acc, row) => {
		acc.workers++;
		if (row.state === "thinking" || row.state === "starting") acc.active++;
		else if (row.state === "needs_input") acc.waiting++;
		else if (row.state === "ready_open_todos") acc.readyOpenTodos++;
		else if (row.state === "ready") acc.ready++;
		else if (row.state === "failed") acc.failed++;
		acc.todos += row.progress.total;
		acc.completedTodos += row.progress.completed;
		return acc;
	}, { workers: 0, active: 0, waiting: 0, ready: 0, readyOpenTodos: 0, failed: 0, todos: 0, completedTodos: 0 });
}

export function workerActivityStackLines(rows: WorkerActivityRow[]): WorkerActivityStackLine[] {
	const lines: WorkerActivityStackLine[] = [];
	for (const row of rows) {
		const todoStatus = row.progress.total ? ` · todos ${row.progress.completed}/${row.progress.total}` : "";
		lines.push({ kind: "worker", state: row.state, worker: row.worker, text: `${row.chip} · ${row.stateLabel}${todoStatus} · ${row.message}` });
		if (row.answerLine && row.answerLine !== row.message) lines.push({ kind: "answer", state: row.state, worker: row.worker, text: `said: ${row.answerLine}` });
		if (row.state === "needs_input" && row.questions.length > 1) {
			for (const question of row.questions) lines.push({ kind: "question", state: row.state, worker: row.worker, text: `? ${question.text}` });
		}
		for (const todoLine of row.todoLines) lines.push({ kind: "todo", state: row.state, worker: row.worker, text: `  ${todoLine}` });
	}
	return lines;
}
