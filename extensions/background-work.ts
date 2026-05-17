import { gitSnapshotLabel } from "./git-context.js";
import type { Artifact, GitSnapshot } from "./types.js";

export type WorkerState = "starting" | "active" | "idle" | "needs_input" | "ready" | "failed" | "error" | "ended";
export type WorkerDerivedState = "starting" | "thinking" | "stale" | "needs_input" | "ready" | "empty" | "failed" | "idle";
export type WorkerProtocolState = "needs_input" | "ready" | "failed";
export type WorkerTodoState = "pending" | "in_progress" | "completed";

export type WorkerTodoInput = {
	id?: string;
	text: string;
	state?: WorkerTodoState | "active" | "done" | "todo";
	note?: string;
};

export type WorkerTodo = {
	id: string;
	text: string;
	state: WorkerTodoState;
	note?: string;
};

export type WorkerQuestion = {
	id: string;
	text: string;
	createdAt: string;
	answeredAt?: string;
};

export type WorkerWorktree = {
	path: string;
	baseCwd: string;
	baseHead?: string;
};

export type WorkerStatus = {
	id: string;
	index: number;
	tmuxSession: string;
	task: string;
	cwd: string;
	git?: GitSnapshot;
	worktree?: WorkerWorktree;
	createdAt: string;
	updatedAt: string;
	state: WorkerState;
	pid?: number;
	sessionFile?: string;
	model?: string;
	contextPercent?: number;
	artifactCount?: number;
	question?: string;
	questions?: WorkerQuestion[];
	todos?: WorkerTodo[];
	summary?: string;
	lastError?: string;
};

export type WorkerProtocolMessage = {
	content: string;
	subject: string;
	title: string;
	subtitle: string;
	messageKind: "action" | "error";
	artifactKind: "response" | "error";
};

export function workerShortLabel(index: number): string {
	return `w${index}`;
}

export function workerSourceLabel(worker: WorkerStatus): string {
	return workerShortLabel(worker.index);
}

export function workerSummaryName(status: WorkerStatus, max = 32): string {
	const slug = status.task.split(/\s+/).slice(0, 6).join(" ").trim();
	return slug.length > max ? `${slug.slice(0, max - 1)}…` : slug;
}

export function workerDisplayName(worker: WorkerStatus, max = 34): string {
	return workerSummaryName(worker, max);
}

const STARTING_CHIP_FRAMES = ["[o  ]", "[ o ]", "[  o]"];
const THINKING_CHIP_FRAMES = ["(._.)", "(o_o)", "(._.)"];
const FRAME_INTERVAL_MS = 400;

function workerStatusText(worker: WorkerStatus, fallback: string): string {
	const text = worker.summary ?? worker.lastError ?? worker.question ?? fallback;
	return text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? fallback;
}

function truncateWorkerStatus(text: string, max = 42): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function workerMascotFrame(worker: WorkerStatus | undefined, options: { now?: number } = {}): string {
	if (!worker) return "(._.)";
	const state = deriveWorkerState(worker, options.now);
	if (state === "starting" || state === "thinking") {
		const frames = state === "starting" ? STARTING_CHIP_FRAMES : THINKING_CHIP_FRAMES;
		const frameTime = Number.isFinite(options.now) ? options.now! : Date.now();
		return frames[Math.floor(frameTime / FRAME_INTERVAL_MS) % frames.length]!;
	}
	if (state === "needs_input") return "(?_?)";
	if (state === "ready") return "(^_^)";
	if (state === "failed") return "(x_x)";
	if (state === "stale") return "(-_-)";
	if (state === "empty") return "(-.-)";
	return "(._.)";
}

export function workerMascotLines(worker: WorkerStatus | undefined, options: { now?: number } = {}): string[] {
	const label = worker ? workerSourceLabel(worker) : "trail";
	return [
		`  ${workerMascotFrame(worker, options)}`,
		`  /|\\  ${label}`,
		"  / \\",
	];
}

export function workerActivityChip(worker: WorkerStatus, options: { verbose?: boolean; now?: number } = {}): string {
	const state = deriveWorkerState(worker, options.now);
	const label = workerSourceLabel(worker);
	let chip = `${label}${workerMascotFrame(worker, options)}`;
	if (!options.verbose) return chip;
	if (state === "needs_input") return `${chip} ${truncateWorkerStatus(workerStatusText(worker, "needs input"))}`;
	if (state === "failed") return `${chip} ${truncateWorkerStatus(workerStatusText(worker, "failed"))}`;
	if (state === "ready") return `${chip} ${truncateWorkerStatus(workerStatusText(worker, "ready") ?? workerTodoSummary(worker) ?? "ready")}`;
	if (state === "stale") return `${chip} stale`;
	if (state === "empty") return `${chip} done`;
	return `${chip} ${truncateWorkerStatus(workerTodoSummary(worker) ?? workerDisplayName(worker, 28))}`;
}

export function workerLaunchSubject(worker: WorkerStatus, options: { now?: number } = {}): string {
	return `spawned ${workerActivityChip(worker, options)} · ${deriveWorkerState(worker, options.now)}`;
}

export function workerLaunchDetail(worker: WorkerStatus, options: { now?: number } = {}): string {
	const git = gitSnapshotLabel(worker.git);
	const todos = workerTodoSummary(worker);
	return [
		`status: ${workerActivityChip(worker, { verbose: true, now: options.now })}`,
		todos ? `todos:  ${todos}` : undefined,
		git ? `git:    ${git}` : undefined,
		worker.worktree ? `tree:   ${worker.worktree.path}` : undefined,
		`inbox:  /trail`,
		`debug:  /trail workers`,
	].filter((line): line is string => line !== undefined).join("\n");
}

function normalizeWorkerTodoState(state: WorkerTodoInput["state"]): WorkerTodoState {
	if (state === "completed" || state === "done") return "completed";
	if (state === "in_progress" || state === "active") return "in_progress";
	return "pending";
}

function workerTodoId(todo: WorkerTodoInput, index: number): string {
	const id = todo.id?.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return (id || `t${index + 1}`).slice(0, 32);
}

export function normalizeWorkerTodos(items: WorkerTodoInput[]): WorkerTodo[] {
	return items
		.map((item, index) => ({
			id: workerTodoId(item, index),
			text: item.text?.replace(/\s+/g, " ").trim() ?? "",
			state: normalizeWorkerTodoState(item.state),
			note: item.note?.replace(/\s+/g, " ").trim() || undefined,
		}))
		.filter((item) => item.text.length > 0)
		.slice(0, 12);
}

export function workerTodosPatch(items: WorkerTodoInput[]): Partial<WorkerStatus> {
	return { todos: normalizeWorkerTodos(items) };
}

export function workerTodoProgress(worker: WorkerStatus): { total: number; completed: number; inProgress: number; pending: number } {
	const todos = worker.todos ?? [];
	return todos.reduce((acc, todo) => {
		acc.total++;
		if (todo.state === "completed") acc.completed++;
		else if (todo.state === "in_progress") acc.inProgress++;
		else acc.pending++;
		return acc;
	}, { total: 0, completed: 0, inProgress: 0, pending: 0 });
}

export function workerTodoSummary(worker: WorkerStatus): string | undefined {
	const todos = worker.todos ?? [];
	if (todos.length === 0) return undefined;
	const progress = workerTodoProgress(worker);
	const current = todos.find((todo) => todo.state === "in_progress") ?? todos.find((todo) => todo.state === "pending");
	const currentText = current ? `${current.text}${current.note ? ` (${current.note})` : ""}` : "done";
	return `${progress.completed}/${progress.total} · ${currentText}`;
}

function workerTodoGlyph(state: WorkerTodoState): string {
	if (state === "completed") return "✓";
	if (state === "in_progress") return "◐";
	return "○";
}

function truncatePlain(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

export function workerTodoBoardLines(worker: WorkerStatus, options: { includeHeader?: boolean; maxItems?: number; maxText?: number } = {}): string[] {
	const todos = worker.todos ?? [];
	if (todos.length === 0) return [];
	const progress = workerTodoProgress(worker);
	const maxItems = options.maxItems ?? todos.length;
	const maxText = options.maxText ?? 72;
	const shown = todos.slice(0, maxItems);
	const lines = options.includeHeader ? [`Todos (${progress.completed}/${progress.total})`] : [];
	for (let i = 0; i < shown.length; i++) {
		const todo = shown[i]!;
		const branch = i === shown.length - 1 && shown.length === todos.length ? "└" : "├";
		const text = truncatePlain(`${todo.text}${todo.note ? ` (${todo.note})` : ""}`, maxText);
		lines.push(`${branch} ${workerTodoGlyph(todo.state)} ${text}`);
	}
	if (shown.length < todos.length) lines.push(`└ … ${todos.length - shown.length} more`);
	return lines;
}

export function workerQuestions(worker: WorkerStatus): WorkerQuestion[] {
	if (worker.questions?.length) return worker.questions;
	if (worker.question) return [{ id: "legacy", text: worker.question, createdAt: worker.updatedAt }];
	return [];
}

export function deriveWorkerState(worker: WorkerStatus, now = Date.now()): WorkerDerivedState {
	if (worker.state === "needs_input") return "needs_input";
	if (worker.state === "failed" || worker.state === "error") return "failed";
	if (worker.state === "ready") return "ready";
	if (worker.state === "ended") return (worker.artifactCount ?? 0) > 0 ? "ready" : "empty";
	const ageMs = now - Date.parse(worker.updatedAt);
	if (Number.isFinite(ageMs) && ageMs > 90_000) return "stale";
	if (worker.state === "active") return "thinking";
	if (worker.state === "starting") return "starting";
	if (worker.state === "idle") return "idle";
	return "idle";
}

export function workerStateRank(worker: WorkerStatus, now = Date.now()): number {
	const state = deriveWorkerState(worker, now);
	if (state === "needs_input") return 0;
	if (state === "failed") return 1;
	if (state === "ready") return 2;
	if (state === "thinking") return 3;
	if (state === "starting") return 4;
	if (state === "stale") return 5;
	return 6;
}

export function isPromptDockWorker(worker: WorkerStatus, now = Date.now()): boolean {
	return deriveWorkerState(worker, now) !== "empty";
}

export function buildWorkerInitialPrompt(input: { label: string; id: string; taskFile: string; artifactsFile: string; worktreePath?: string }): string {
	return [
		`You are Trail worker ${input.label} (${input.id}).`,
		"Your task is recorded in:",
		`  ${input.taskFile}`,
		"",
		`Read it, then begin. Your artifacts are auto-snapshotted to ${input.artifactsFile}.`,
		"Default to read-only investigation. Do not edit files unless the task explicitly asks for edits; if you do edit, summarize changed files and conflict risks.",
		input.worktreePath ? `You are running in an isolated git worktree: ${input.worktreePath}` : undefined,
		"Use Trail worker protocol tools for parent coordination:",
		"- For multi-step work, optionally call `trail_todos` with a small ordered checklist (usually 3-8 items). It replaces the visible progress board; it is not a durable task manager.",
		"- If blocked or needing clarification, call `trail_wait` with a concise question, then stop and wait for a parent reply.",
		"- When finished with useful output, call `trail_done` with a concise summary.",
		"- If unable to continue, call `trail_fail` with the reason.",
		"Do not run `/trail wait`, `/trail done`, or `/trail fail` in bash; those are Pi prompt fallbacks, not shell commands.",
		"The parent reviews worker attention in `/trail` and sends follow-up with `/trail tell w<N> <message>`.",
	].filter((line): line is string => line !== undefined).join("\n");
}

export function appendWorkerQuestionPatch(worker: WorkerStatus, text: string, question: WorkerQuestion): Partial<WorkerStatus> | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const legacy = worker.question && !worker.questions?.length
		? [{ id: "legacy", text: worker.question, createdAt: worker.updatedAt }]
		: [];
	const questions = [...legacy, ...(worker.questions ?? []), { ...question, text: trimmed }];
	return { state: "needs_input", question: questions.length === 1 ? trimmed : `${questions.length} questions`, questions };
}

export function workerInputAcceptedPatch(): Partial<WorkerStatus> {
	return { state: "active", question: undefined, questions: [] };
}

export function workerHeartbeatPatch(current: WorkerStatus | undefined, input: { pid: number; sessionFile?: string; artifactCount: number }): Partial<WorkerStatus> {
	const stickyState = current?.state === "needs_input" || current?.state === "ready" || current?.state === "failed";
	return {
		state: stickyState ? current.state : "active",
		pid: input.pid,
		sessionFile: input.sessionFile,
		artifactCount: input.artifactCount,
	};
}

export function workerProtocolPatch(worker: WorkerStatus, state: WorkerProtocolState, text: string | undefined, question: WorkerQuestion): Partial<WorkerStatus> | undefined {
	if (state === "needs_input") return appendWorkerQuestionPatch(worker, text ?? "", question);
	return {
		state,
		question: undefined,
		questions: [],
		summary: state === "ready" ? text : undefined,
		lastError: state === "failed" ? text : undefined,
	};
}

export function workerProtocolResultText(state: WorkerProtocolState): string {
	if (state === "needs_input") return "Trail wait recorded. Stop now and wait for parent reply.";
	if (state === "ready") return "Trail done recorded. Parent can review the worker output.";
	return "Trail failure recorded. Parent can review the failure.";
}

export function workerProtocolMessage(state: WorkerProtocolState, text?: string): WorkerProtocolMessage {
	const subject = state === "needs_input" ? "needs input" : state === "ready" ? "ready" : "failed";
	const title = state === "needs_input"
		? `Needs input: ${text ?? "clarification requested"}`
		: state === "ready"
			? `Worker ready${text ? `: ${text}` : ""}`
			: `Worker failed: ${text ?? "unknown reason"}`;
	return {
		content: text ?? subject,
		subject,
		title,
		subtitle: `worker ${subject}`,
		messageKind: state === "failed" ? "error" : "action",
		artifactKind: state === "failed" ? "error" : "response",
	};
}

export function workerStatusArtifact(worker: WorkerStatus, now = Date.now()): Artifact | undefined {
	const state = deriveWorkerState(worker, now);
	if (state !== "needs_input" && state !== "ready" && state !== "failed") return undefined;
	const label = workerSourceLabel(worker);
	const questions = workerQuestions(worker);
	const questionText = questions.length ? questions.map((question, index) => `${index + 1}. ${question.text}`).join("\n") : undefined;
	const text = state === "needs_input" ? questionText : state === "ready" ? worker.summary : worker.lastError;
	const todoLines = workerTodoBoardLines(worker, { includeHeader: true });
	const git = gitSnapshotLabel(worker.git);
	const title = state === "needs_input"
		? questions.length > 1 ? `${label} needs input: ${questions.length} questions` : `${label} needs input${questions[0]?.text ? `: ${questions[0].text}` : ""}`
		: state === "ready"
			? `${label} ready${text ? `: ${text}` : ""}`
			: `${label} failed${text ? `: ${text}` : ""}`;
	return {
		id: "status",
		displayId: "status",
		ref: `worker-status:${worker.id}:0`,
		kind: state === "failed" ? "error" : "response",
		title,
		subtitle: workerDisplayName(worker),
		body: [`worker: ${label}`, `state: ${state}`, git ? `git: ${git}` : undefined, `task: ${worker.task}`, todoLines.length ? `progress:\n${todoLines.join("\n")}` : undefined, text ? `message:\n${text}` : undefined].filter((line): line is string => line !== undefined).join("\n"),
		timestamp: Date.parse(worker.updatedAt),
		meta: { workerId: worker.id, workerLabel: label, workerStatus: state, question: text, summary: worker.summary, lastError: worker.lastError, questionCount: questions.length, todoCount: worker.todos?.length ?? 0, git: worker.git },
	};
}

export function namespaceWorkerArtifacts(worker: WorkerStatus, artifacts: Artifact[]): Artifact[] {
	const slot = workerSourceLabel(worker);
	return artifacts.map((artifact) => ({ ...artifact, id: `${slot}.${artifact.displayId}`, displayId: `${slot}.${artifact.displayId}`, source: slot }));
}
