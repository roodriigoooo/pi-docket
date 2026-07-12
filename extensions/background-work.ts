import { gitSnapshotLabel } from "./git-context.js";
import type { Artifact, GitSnapshot } from "./types.js";
import { deriveWorkerLifecycleState, isPaneHarvestEligible } from "./worker-lifecycle.js";

export type WorkerState = "starting" | "active" | "idle" | "needs_input" | "ready" | "failed" | "error" | "ended";
export type WorkerDerivedState = "starting" | "thinking" | "stale" | "needs_input" | "ready_open_todos" | "ready" | "empty" | "failed" | "idle" | "reviewed";
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

export type WorkerDoneOutcome = "completed" | "findings" | "proposal" | "no_evidence";
export type WorkerScopeConfidence = "clear" | "unclear";

export type WorkerDoneInput = {
	summary?: string;
	outcome?: WorkerDoneOutcome;
	evidence?: string[];
	recommended?: string[];
	scopeConfidence?: WorkerScopeConfidence;
};

export type WorkerQuestion = {
	id: string;
	text: string;
	createdAt: string;
	answeredAt?: string;
	/** One-line stakes the worker flags (irreversible/unauthorized); shown as a warning on the verdict card. */
	risk?: string;
	/** Concrete choices the worker proposes; selecting one is sent back verbatim. Zero-token, status-only. */
	options?: string[];
	/** Which option the worker recommends (matches one of `options`); pre-selected on the card. */
	recommend?: string;
};

export type WorkerTaskDocumentInput = {
	task: string;
	kind?: string;
	readOnly?: boolean;
	worktree?: boolean;
	planGate?: boolean;
	decisionRights?: string[];
	parentWorkerLabel?: string;
};

export type WorkerWorkspaceKind = "git" | "copy";

export type WorkerWorktree = {
	path: string;
	baseCwd: string;
	/** Omitted on legacy statuses; treat as git worktree. */
	kind?: WorkerWorkspaceKind;
	baseRoot?: string;
	parentCwd?: string;
	baseHead?: string;
	snapshotHead?: string;
};

export type WorkerStatus = {
	id: string;
	index: number;
	tmuxSession: string;
	/** Stable tmux window id (e.g. "@7") captured at create time. Used for targeting kill/send-keys so renamed/recycled windows don't misroute. */
	tmuxWindowId?: string;
	task: string;
	cwd: string;
	/** Canonical project root (git toplevel realpath, or cwd realpath for non-repos) that launched this worker. */
	projectRoot?: string;
	kind?: string;
	parentWorkerId?: string;
	/** tmux target for the direct parent session/window, used by `/docket attach parent` from a worker. */
	parentTmuxTarget?: string;
	depth?: number;
	canSpawn?: string[];
	git?: GitSnapshot;
	worktree?: WorkerWorktree;
	createdAt: string;
	updatedAt: string;
	state: WorkerState;
	/** Unique launch generation; prevents an old process-exit hook from changing a respawned worker. */
	runToken?: string;
	pid?: number;
	sessionFile?: string;
	model?: string;
	contextPercent?: number;
	artifactCount?: number;
	question?: string;
	questions?: WorkerQuestion[];
	todos?: WorkerTodo[];
	summary?: string;
	outcome?: WorkerDoneOutcome;
	evidence?: string[];
	recommended?: string[];
	scopeConfidence?: WorkerScopeConfidence;
	lastError?: string;
	/** Set when the parent harvested (or confirmed gone) the worker's dead tmux pane. Guards the harvest sweep. */
	paneCapturedAt?: string;
	/** Set when the parent records a terminal verdict (accept/reject on ready, dismiss on failed). Worker shows dim "reviewed" in the dock until new activity clears it. */
	reviewedAt?: string;
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

// Live dock heartbeat: a single breathing dot for active (starting/thinking) workers.
// Rendered only in surfaces that repaint on a timer (the prompt dock), never in static chips.
const PULSE_FRAMES = ["·", "∘", "o", "●", "o", "∘"];
export const DOCK_PULSE_INTERVAL_MS = 450;

export function workerPulseGlyph(now = Date.now()): string {
	return PULSE_FRAMES[Math.floor(now / DOCK_PULSE_INTERVAL_MS) % PULSE_FRAMES.length]!;
}

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
	if (state === "ready_open_todos") return "(^_?)";
	if (state === "ready") return "(^_^)";
	if (state === "failed") return "(x_x)";
	if (state === "stale") return "(-_-)";
	if (state === "empty") return "(-.-)";
	return "(._.)";
}

export function workerMascotLines(worker: WorkerStatus | undefined, options: { now?: number } = {}): string[] {
	const label = worker ? workerSourceLabel(worker) : "docket";
	return [
		`  ${workerMascotFrame(worker, options)}`,
		`  /|\\  ${label}`,
		"  / \\",
	];
}

export function workerActivityChip(worker: WorkerStatus, options: { verbose?: boolean; now?: number } = {}): string {
	const state = deriveWorkerState(worker, options.now);
	const label = workerSourceLabel(worker);
	const kindTag = worker.kind && worker.kind !== "default" ? `·${worker.kind}` : "";
	// Animated frames (starting/thinking) freeze in static one-shot messages; only emit the
	// stable state faces here. Live liveliness for active workers lives in the dock pulse.
	const face = state === "starting" || state === "thinking" ? "" : workerMascotFrame(worker, options);
	let chip = `${label}${kindTag}${face}`;
	if (!options.verbose) return chip;
	if (state === "needs_input") return `${chip} ${truncateWorkerStatus(workerStatusText(worker, "needs input"))}`;
	if (state === "failed") return `${chip} ${truncateWorkerStatus(workerStatusText(worker, "failed"))}`;
	if (state === "ready_open_todos") return `${chip} ready · progress ${workerTodoSummary(worker) ?? ""}`.trim();
	if (state === "ready") return `${chip} ${truncateWorkerStatus(worker.summary ?? workerTodoSummary(worker) ?? workerStatusText(worker, "ready"))}`;
	if (state === "reviewed") return `${chip} reviewed`;
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
	const kindLine = worker.kind && worker.kind !== "default" ? `kind:   ${worker.kind}` : undefined;
	return [
		`status: ${workerActivityChip(worker, { verbose: true, now: options.now })}`,
		kindLine,
		todos ? `progress: ${todos}` : undefined,
		git ? `git:    ${git}` : undefined,
		worker.worktree ? `space:  ${worker.worktree.path}` : undefined,
		`inbox:  /docket`,
		`debug:  /docket workers`,
	].filter((line): line is string => line !== undefined).join("\n");
}

function normalizedDecisionRights(items: string[] | undefined): string[] {
	return (items ?? []).map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8);
}

export function buildWorkerTaskDocument(input: WorkerTaskDocumentInput): string {
	const task = input.task.trim();
	const kind = input.kind?.trim() || "default";
	const rights = normalizedDecisionRights(input.decisionRights);
	const authority = input.readOnly
		? [
			"Read files and run non-mutating discovery commands.",
			"Do not edit files. If edits are needed, call `docket_wait` and ask for a writable worker.",
		]
		: input.planGate
			? [
				"Before approval, inspect files and run non-mutating discovery commands.",
				"After parent approval, edit only files needed for the assigned task; keep diffs minimal.",
				"After edits, run local non-destructive checks needed to verify your own changes.",
			]
		: [
			"Read files and run non-mutating discovery commands.",
			"Edit only files needed for the assigned task; keep diffs minimal.",
			"Run local checks needed to verify your own changes.",
		];
	const planGate = input.planGate
		? [
			"## Plan gate",
			"After read-only discovery and before the first file edit, mutating shell command, migration, paid/external write, or broad refactor, call `docket_wait` with:",
			"- the plan you intend to execute",
			"- 2-4 concrete options when meaningful",
			"- `recommend` set to your preferred option",
			"- `risk` set when the action is irreversible or outside the task's obvious scope",
			"Wait for the parent reply before crossing that boundary. Read-only discovery and harmless checks are allowed before the gate.",
		].join("\n")
		: "## Plan gate\nNo explicit plan gate for this task. Still call `docket_wait` before irreversible, expensive, unauthorized, or ambiguous actions.";
	return [
		"# Task",
		"",
		task,
		"",
		"## Pre-flight brief",
		"",
		`- Kind: ${kind}`,
		`- Workspace: ${input.worktree === false ? "parent working directory" : "isolated worker workspace"}`,
		input.parentWorkerLabel ? `- Parent worker: ${input.parentWorkerLabel}` : undefined,
		"- Parent reviews your output through `/docket verdict`; keep evidence concrete.",
		"",
		"## Decision rights",
		"",
		...authority.map((item) => `- ${item}`),
		...rights.map((item) => `- ${item}`),
		"- Never push, force-push, reset hard, clean the repo, kill the shared tmux session, or perform destructive external operations unless the parent explicitly approves through `docket_wait`.",
		"",
		planGate,
		"",
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

export function workerHasOpenTodos(worker: WorkerStatus): boolean {
	const progress = workerTodoProgress(worker);
	return progress.total > 0 && progress.completed < progress.total;
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
	const lines = options.includeHeader ? [`Progress (${progress.completed}/${progress.total})`] : [];
	for (let i = 0; i < shown.length; i++) {
		const todo = shown[i]!;
		const branch = i === shown.length - 1 && shown.length === todos.length ? "└" : "├";
		const text = truncatePlain(`${todo.text}${todo.note ? ` (${todo.note})` : ""}`, maxText);
		lines.push(`${branch} ${workerTodoGlyph(todo.state)} ${text}`);
	}
	if (shown.length < todos.length) lines.push(`└ … ${todos.length - shown.length} more`);
	return lines;
}

function normalizeShortList(items: string[] | undefined, max: number): string[] | undefined {
	const normalized = (items ?? []).map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, max);
	return normalized.length ? normalized : undefined;
}

export function normalizeWorkerDoneInput(input: WorkerDoneInput = {}): WorkerDoneInput {
	return {
		summary: input.summary?.trim() || undefined,
		outcome: input.outcome,
		evidence: normalizeShortList(input.evidence, 12),
		recommended: normalizeShortList(input.recommended, 12),
		scopeConfidence: input.scopeConfidence,
	};
}

export function formatWorkerDoneSummary(input: WorkerDoneInput = {}): string | undefined {
	const done = normalizeWorkerDoneInput(input);
	return done.summary || undefined;
}

const TASK_STOP_WORDS = new Set(["a", "an", "the", "and", "or", "to", "of", "for", "in", "on", "with", "by", "from", "up", "about", "please", "just"]);

export function workerTaskLooksVague(task: string): boolean {
	const trimmed = task.trim();
	if (!trimmed) return true;
	const lower = trimmed.toLowerCase();
	const words = lower.match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
	const meaningful = words.filter((word) => !TASK_STOP_WORDS.has(word));
	const unfinishedTail = /(\.\.\.|…|,\s*|\bmore\s*)$/.test(lower);
	const genericStart = /^(find|look for|search|check|inspect|investigate|review|improve|come up with|think about|work on)\b/.test(lower);
	const concreteScope = /(`[^`]+`|[./][\w.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|json|md|svg|png|jpg|jpeg|css|html|go|rs|py|rb|java|yml|yaml)\b|#\d+|\b(repo|repository|codebase|project|extension|docs?|readme|tests?|src|source|file|directory|folder|command|function|class|component|api|cli|tui|worker|artifact|checkpoint|symbol|module|package)\b)/i.test(trimmed);
	const deliverable = /\b(ascii|svg|logo|markdown|md|json|patch|diff|test|fix|implement|add|write|generate|report|summary|recommendations?|design|proposal)\b/i.test(trimmed);

	if (unfinishedTail && (meaningful.length <= 5 || genericStart)) return true;
	if (meaningful.length <= 2) return true;
	if (genericStart && meaningful.length <= 3 && !concreteScope && !deliverable) return true;
	if (genericStart && !concreteScope && !deliverable) return true;
	return false;
}

function summarySaysNoEvidence(summary: string | undefined): boolean {
	if (!summary) return false;
	return /\b(no|not|nothing|couldn'?t|could not|didn'?t|did not|zero)\b.{0,60}\b(found|find|matches?|hits?|refs?|references?|related|evidence)\b/i.test(summary)
		|| /\b(found|find|matches?|hits?|refs?|references?|evidence)\b.{0,60}\b(no|nothing|zero)\b/i.test(summary);
}

export function workerDoneClarificationQuestion(worker: WorkerStatus, input: WorkerDoneInput = {}, options: { artifactEvidenceCount?: number } = {}): string | undefined {
	const done = normalizeWorkerDoneInput(input);
	const evidenceCount = (done.evidence?.length ?? 0) + (options.artifactEvidenceCount ?? 0);
	const scopeUnclear = done.scopeConfidence === "unclear";
	const vague = scopeUnclear || workerTaskLooksVague(worker.task);
	if (!vague) return undefined;
	if (scopeUnclear || done.outcome === "no_evidence" || summarySaysNoEvidence(done.summary) || (!done.outcome && evidenceCount === 0)) {
		const task = truncatePlain(worker.task, 80);
		return `I didn't find enough evidence to complete "${task}". What exactly should I search for, and where?`;
	}
	return undefined;
}

export function workerQuestions(worker: WorkerStatus): WorkerQuestion[] {
	if (worker.questions?.length) return worker.questions;
	if (worker.question) return [{ id: "legacy", text: worker.question, createdAt: worker.updatedAt }];
	return [];
}

export function deriveWorkerState(worker: WorkerStatus, now = Date.now()): WorkerDerivedState {
	return deriveWorkerLifecycleState(worker, now);
}

export function workerStateRank(worker: WorkerStatus, now = Date.now()): number {
	const state = deriveWorkerState(worker, now);
	if (state === "needs_input") return 0;
	if (state === "failed") return 1;
	if (state === "ready_open_todos") return 2;
	if (state === "ready") return 3;
	if (state === "thinking") return 4;
	if (state === "starting") return 5;
	if (state === "stale") return 6;
	if (state === "reviewed") return 8;
	return 7;
}

export function isPromptDockWorker(worker: WorkerStatus, now = Date.now()): boolean {
	return deriveWorkerState(worker, now) !== "empty";
}

export function buildWorkerInitialPrompt(input: { label: string; id: string; taskFile: string; artifactsFile: string; worktreePath?: string; kind?: string; depth?: number; parentWorkerLabel?: string }): string {
	const kindLine = input.kind && input.kind !== "default" ? `You are operating under worker kind \`${input.kind}\`. Kind-specific rules are in <docket_worker_guardrails>.` : undefined;
	const parentLine = input.parentWorkerLabel ? `You were dispatched by worker ${input.parentWorkerLabel} (depth ${input.depth ?? 1}). Your docket_done returns to that worker, not directly to the human user.` : undefined;
	return [
		`You are Docket worker ${input.label} (${input.id}).`,
		`Your task is in ${input.taskFile}. Read it, then begin.`,
		`Artifacts are auto-snapshotted to ${input.artifactsFile}.`,
		input.worktreePath ? `Worker workspace: ${input.worktreePath}` : undefined,
		kindLine,
		parentLine,
		"Operating rules and tool contracts live in <docket_worker_guardrails> in your system prompt. Follow them; do not skip the protocol tools (`docket_wait`, `docket_done`, `docket_fail`, `docket_todos`).",
	].filter((line): line is string => line !== undefined).join("\n");
}

export function appendWorkerQuestionPatch(worker: WorkerStatus, text: string, question: WorkerQuestion): Partial<WorkerStatus> | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const legacy = worker.question && !worker.questions?.length
		? [{ id: "legacy", text: worker.question, createdAt: worker.updatedAt }]
		: [];
	const questions = [...legacy, ...(worker.questions ?? []), { ...question, text: trimmed }];
	return { state: "needs_input", question: questions.length === 1 ? trimmed : `${questions.length} questions`, questions, reviewedAt: undefined };
}

export function workerInputAcceptedPatch(): Partial<WorkerStatus> {
	return { state: "active", question: undefined, questions: [], reviewedAt: undefined };
}

export const HEARTBEAT_ARTIFACT_CAP = 200;

export function heartbeatArtifactSignature(artifacts: Artifact[]): string {
	if (artifacts.length === 0) return "0:";
	const last = artifacts[artifacts.length - 1]!;
	const ts = last.timestamp ?? 0;
	return `${artifacts.length}:${last.ref}:${ts}`;
}

export function workerHeartbeatPatch(current: WorkerStatus | undefined, input: { pid: number; sessionFile?: string; artifactCount: number }): Partial<WorkerStatus> {
	const stickyState = current?.state === "needs_input" || current?.state === "ready" || current?.state === "failed" || current?.state === "idle";
	return {
		state: stickyState ? current.state : "active",
		pid: input.pid,
		sessionFile: input.sessionFile,
		artifactCount: input.artifactCount,
	};
}

export function workerProtocolPatch(worker: WorkerStatus, state: WorkerProtocolState, text: string | undefined, question: WorkerQuestion, doneInput?: WorkerDoneInput): Partial<WorkerStatus> | undefined {
	if (state === "needs_input") return appendWorkerQuestionPatch(worker, text ?? "", question);
	const patch: Partial<WorkerStatus> = {
		state,
		question: undefined,
		questions: [],
		summary: state === "ready" ? formatWorkerDoneSummary(doneInput ?? { summary: text }) : undefined,
		lastError: state === "failed" ? text : undefined,
		reviewedAt: undefined,
	};
	if (state === "ready") {
		const done = normalizeWorkerDoneInput(doneInput ?? { summary: text });
		if (done.outcome) patch.outcome = done.outcome;
		if (done.evidence?.length) patch.evidence = done.evidence;
		if (done.recommended?.length) patch.recommended = done.recommended;
		if (done.scopeConfidence) patch.scopeConfidence = done.scopeConfidence;
	}
	return patch;
}

export function workerProtocolResultText(state: WorkerProtocolState): string {
	if (state === "needs_input") return "Docket wait recorded. Stop now and wait for parent reply.";
	if (state === "ready") return "Docket done recorded. Parent can review the worker output.";
	return "Docket failure recorded. Parent can review the failure.";
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
	if (state !== "needs_input" && state !== "ready_open_todos" && state !== "ready" && state !== "failed") return undefined;
	const label = workerSourceLabel(worker);
	const questions = workerQuestions(worker);
	const questionText = questions.length ? questions.map((question, index) => `${index + 1}. ${question.text}`).join("\n") : undefined;
	const ready = state === "ready" || state === "ready_open_todos";
	const text = state === "needs_input" ? questionText : ready ? worker.summary : worker.lastError;
	const todoLines = workerTodoBoardLines(worker, { includeHeader: true });
	const progress = workerTodoProgress(worker);
	const openTodos = Math.max(0, progress.total - progress.completed);
	const git = gitSnapshotLabel(worker.git);
	const title = state === "needs_input"
		? questions.length > 1 ? `${label} needs input: ${questions.length} questions` : `${label} needs input${questions[0]?.text ? `: ${questions[0].text}` : ""}`
		: ready
			? `${label} ${state === "ready_open_todos" ? `ready · progress ${progress.completed}/${progress.total}` : "ready"}${text ? `: ${text}` : ""}`
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
		meta: { workerId: worker.id, workerLabel: label, workerStatus: state, question: text, summary: worker.summary, outcome: worker.outcome, evidence: worker.evidence, recommended: worker.recommended, scopeConfidence: worker.scopeConfidence, lastError: worker.lastError, questionCount: questions.length, todoCount: worker.todos?.length ?? 0, todoOpenCount: openTodos, git: worker.git },
	};
}

/** True when the parent's dock sweep should probe this worker's tmux pane for a post-mortem capture. */
export function isPaneHarvestCandidate(worker: WorkerStatus): boolean {
	return isPaneHarvestEligible(worker);
}

export const PANE_TAIL_MAX_LINES = 200;

/**
 * Evidence artifact built from the dead pane's captured tail. Kind "command" keeps it
 * out of the review queue: it is post-mortem evidence attached to the worker, not a
 * decision item — the failed/ended status artifact already carries the decision.
 */
export function workerPaneTailArtifact(worker: WorkerStatus, tail: string): Artifact | undefined {
	const lines = tail.replace(/\s+$/, "").split(/\r?\n/).slice(-PANE_TAIL_MAX_LINES);
	const text = lines.join("\n").trim();
	if (!text) return undefined;
	const label = workerSourceLabel(worker);
	return {
		id: "pane",
		displayId: "pane",
		ref: `worker-pane:${worker.id}:0`,
		kind: "command",
		title: `${label} terminal tail`,
		subtitle: "terminal output at exit",
		body: text,
		timestamp: Date.parse(worker.updatedAt),
		meta: { workerId: worker.id, workerLabel: label, paneTail: true },
	};
}

export function namespaceWorkerArtifacts(worker: WorkerStatus, artifacts: Artifact[]): Artifact[] {
	const slot = workerSourceLabel(worker);
	return artifacts.map((artifact) => ({ ...artifact, id: `${slot}.${artifact.displayId}`, displayId: `${slot}.${artifact.displayId}`, source: slot }));
}
