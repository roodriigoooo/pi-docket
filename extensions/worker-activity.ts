import { workerActivityChip, workerDisplayName, workerQuestions, workerSourceLabel, workerStateRank, workerTodoBoardLines, workerTodoProgress, type WorkerDerivedState, type WorkerQuestion, type WorkerStatus } from "./background-work.js";
import type { Artifact } from "./types.js";
import type { WorkerEvent } from "./worker-events.js";
import { countWorkerRecommendations, firstWorkerReviewLine, isWorkerStatusArtifact, projectWorkerReview } from "./worker-review.js";
import { conflictSummary, workerConflictMap, type WorkerFileConflict } from "./worker-conflicts.js";

export type WorkerEvidence = {
	reads: number;
	commands: number;
	edits: number;
	errors: number;
	codeBlocks: number;
	sampleFiles: string[];
};

export type WorkerActivityRow = {
	worker: WorkerStatus;
	label: string;
	chip: string;
	state: WorkerDerivedState;
	stateLabel: string;
	taskLabel: string;
	message: string;
	answer?: Artifact;
	answerLine?: string;
	outputLabel: string;
	actionHint: string;
	questions: WorkerQuestion[];
	progress: { total: number; completed: number; inProgress: number; pending: number };
	todoLines: string[];
	recommendations: number;
	filesChanged: number;
	evidence: WorkerEvidence;
	loaded: boolean;
	conflicts: WorkerFileConflict[];
	summary?: string;
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
	loaded: number;
	reviewed: number;
	todos: number;
	completedTodos: number;
};

type WorkerProgress = { total: number; completed: number; inProgress: number; pending: number };

function artifactTool(artifact: Artifact): string | undefined {
	const tool = artifact.meta?.tool;
	return typeof tool === "string" ? tool : undefined;
}

function computeEvidence(artifacts: Artifact[]): { evidence: WorkerEvidence; filesChanged: number } {
	const evidence: WorkerEvidence = { reads: 0, commands: 0, edits: 0, errors: 0, codeBlocks: 0, sampleFiles: [] };
	const fileNames = new Set<string>();
	let filesChanged = 0;
	for (const artifact of artifacts) {
		if (artifact.kind === "file") {
			const tool = artifactTool(artifact);
			if (tool === "edit" || tool === "write") {
				evidence.edits++;
				filesChanged++;
				if (fileNames.size < 4) fileNames.add(artifact.title);
			} else if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") {
				evidence.reads++;
				if (fileNames.size < 4) fileNames.add(artifact.title);
			}
		} else if (artifact.kind === "command") evidence.commands++;
		else if (artifact.kind === "error") evidence.errors++;
		else if (artifact.kind === "code") evidence.codeBlocks++;
	}
	evidence.sampleFiles = [...fileNames];
	return { evidence, filesChanged };
}

function buildOutputLabel(state: WorkerDerivedState, answer: Artifact | undefined, recommendations: number, filesChanged: number, progress: { total: number; completed: number }, conflicts: WorkerFileConflict[], loaded: boolean): string {
	const conflict = conflictSummary(conflicts, 1);
	if (loaded && (state === "ready" || state === "ready_open_todos")) return conflict ? `loaded · ${conflict}` : "loaded";
	if (conflict) return conflict;
	if (state === "needs_input") return "needs reply";
	if (state === "starting" || state === "thinking") return "working";
	if (state === "failed") return "error";
	if (state === "stale") return "stale";
	if (state === "ready" || state === "ready_open_todos") {
		const parts: string[] = [];
		if (recommendations > 0) parts.push(`${recommendations} ${recommendations === 1 ? "rec" : "recs"}`);
		parts.push(filesChanged > 0 ? `${filesChanged} ${filesChanged === 1 ? "file" : "files"} changed` : "no files");
		if (progress.total > 0) parts.push(`${progress.completed}/${progress.total} progress`);
		if (parts.length === 0 || (parts.length === 1 && parts[0] === "no files")) {
			if (!answer || isWorkerStatusArtifact(answer)) return "summary only";
		}
		return parts.join(" · ");
	}
	if (state === "reviewed") return "reviewed";
	if (!answer || isWorkerStatusArtifact(answer)) return "no output";
	if (answer.kind === "error") return "error";
	if (answer.kind === "code") return "code output";
	return "text output";
}

export function shortModelLabel(id: string | undefined): string | undefined {
	if (!id) return undefined;
	const cleaned = id.replace(/^anthropic\//, "").replace(/^openai\//, "").replace(/^claude-/, "");
	const stripped = cleaned.replace(/-\d{8}$/, "");
	return stripped.length > 12 ? stripped.slice(0, 12) : stripped;
}

/** Return the kind name to show next to a worker label, or undefined for the implicit default. */
export function workerKindLabel(worker: WorkerStatus): string | undefined {
	const kind = worker.kind?.trim();
	if (!kind || kind === "default") return undefined;
	return kind.length > 16 ? kind.slice(0, 16) : kind;
}

export function pickModelBadge(worker: WorkerStatus, allWorkers: WorkerStatus[], parentModelId: string | undefined): string | undefined {
	const workerLabel = shortModelLabel(worker.model);
	if (!workerLabel) return undefined;
	const parentLabel = shortModelLabel(parentModelId);
	if (parentLabel && parentLabel === workerLabel) {
		const seen = new Set<string>();
		for (const w of allWorkers) {
			const l = shortModelLabel(w.model);
			if (l) seen.add(l);
		}
		if (seen.size <= 1) return undefined;
	}
	return workerLabel;
}

export function workerProgressBar(progress: WorkerProgress, width = 5): string | undefined {
	if (!Number.isFinite(progress.total) || progress.total <= 0) return undefined;
	const slots = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 5;
	const completed = Math.max(0, Math.min(Number.isFinite(progress.completed) ? progress.completed : 0, progress.total));
	const filled = completed >= progress.total
		? slots
		: completed <= 0
			? 0
			: Math.max(1, Math.floor((completed / progress.total) * slots));
	return `${"▰".repeat(filled)}${"▱".repeat(slots - filled)}`;
}

export function workerProgressCompact(progress: WorkerProgress, width = 5): string | undefined {
	return workerProgressBar(progress, width);
}

function workerProgressDetail(progress: WorkerProgress): string | undefined {
	const compact = workerProgressCompact(progress);
	if (!compact) return undefined;
	const parts = [compact];
	if (progress.inProgress > 0) parts.push(`${progress.inProgress} active`);
	if (progress.pending > 0) parts.push(`${progress.pending} pending`);
	return parts.join(" · ");
}

export type DockRow = {
	worker: WorkerStatus;
	label: string;
	state: WorkerDerivedState;
	taskLabel: string;
	progressLabel: string;
	ageLabel: string;
	attention: boolean;
	chip?: string;
	kindLabel?: string;
	modelBadge?: string;
	eventLine?: string;
};

export type WorkerActivityPreviewOptions = {
	showProgressDetail?: boolean;
	maxTodoItems?: number;
};

const SKIP_TOOL_EVENT_NAMES = new Set([
	"docket_wait",
	"docket_done",
	"docket_fail",
	"docket_todos",
]);

export const WORKER_SILENCE_WARN_MS = 5 * 60 * 1000;
export const NEEDS_INPUT_AGING_WARN_MS = 30 * 60 * 1000;

function truncateTool(text: string, max = 60): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function ageLabelFromMs(ageMs: number): string {
	if (!Number.isFinite(ageMs) || ageMs < 0) return "";
	const seconds = Math.round(ageMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return `${hours}h`;
}

function latestWorkerEventTs(events: WorkerEvent[] | undefined): number | undefined {
	if (!events?.length) return undefined;
	for (let i = events.length - 1; i >= 0; i--) {
		const ts = Number(events[i]?.ts);
		if (Number.isFinite(ts) && ts > 0) return ts;
	}
	return undefined;
}

function latestQuestionTs(worker: WorkerStatus | undefined): number | undefined {
	if (!worker) return undefined;
	const questions = workerQuestions(worker);
	const latest = questions[questions.length - 1];
	return latest ? Date.parse(latest.createdAt) : Date.parse(worker.updatedAt);
}

export function dockEventSubLine(events: WorkerEvent[] | undefined, state: WorkerDerivedState, options: { now?: number; worker?: WorkerStatus } = {}): string | undefined {
	const now = options.now ?? Date.now();
	if (state === "needs_input") {
		const questionTs = latestQuestionTs(options.worker);
		const ageMs = questionTs === undefined ? 0 : now - questionTs;
		if (ageMs >= NEEDS_INPUT_AGING_WARN_MS) return `waiting ${ageLabelFromMs(ageMs)} · reply, reject, or stop`;
		return undefined;
	}
	if (state !== "thinking" && state !== "starting") return undefined;
	let latestLine: string | undefined;
	for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
		const event = events?.[i];
		if (!event || event.kind !== "tool") continue;
		const tool = typeof event.payload.tool === "string" ? event.payload.tool : undefined;
		if (!tool || SKIP_TOOL_EVENT_NAMES.has(tool)) continue;
		const target = typeof event.payload.target === "string" ? event.payload.target : undefined;
		latestLine = truncateTool(target ? `tool: ${tool} ${target}` : `tool: ${tool}`);
		break;
	}
	if (!latestLine) {
		for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
			const event = events?.[i];
			if (!event || event.kind !== "todo") continue;
			const total = Number(event.payload.total ?? 0);
			const completed = Number(event.payload.completed ?? 0);
			const inProgress = Number(event.payload.inProgress ?? 0);
			if (!Number.isFinite(total) || total <= 0) continue;
			const compact = workerProgressCompact({ total, completed, inProgress, pending: Math.max(0, total - completed - inProgress) });
			const active = inProgress > 0 ? ` · ${inProgress} active` : "";
			latestLine = compact ? `progress ${compact}${active}` : `progress ${completed}/${total}${active}`;
			break;
		}
	}
	const startedAt = Date.parse(options.worker?.createdAt ?? "");
	const lastSignal = latestWorkerEventTs(events) ?? (Number.isFinite(startedAt) ? startedAt : undefined);
	const silenceMs = lastSignal === undefined ? 0 : now - lastSignal;
	if (silenceMs >= WORKER_SILENCE_WARN_MS) return latestLine ? `silent ${ageLabelFromMs(silenceMs)} · last ${latestLine}` : `silent ${ageLabelFromMs(silenceMs)} · p peek or attach`;
	return latestLine;
}

function relativeAgeLabel(updatedAtMs: number, now: number): string {
	return ageLabelFromMs(now - updatedAtMs);
}

function dockProgressLabel(row: WorkerActivityRow): string {
	const conflict = conflictSummary(row.conflicts, 1);
	if (conflict) return conflict;
	if (row.state === "reviewed") return "reviewed";
	if (row.progress.total > 0) return workerProgressCompact(row.progress) ?? `${row.progress.completed}/${row.progress.total} progress`;
	if (row.state === "ready" || row.state === "ready_open_todos") {
		if (row.recommendations > 0) return `${row.recommendations} ${row.recommendations === 1 ? "rec" : "recs"}`;
		if (row.filesChanged > 0) return `${row.filesChanged} ${row.filesChanged === 1 ? "file" : "files"} changed`;
	}
	if (row.state === "needs_input") return "needs reply";
	if (row.state === "failed") return "error";
	return "";
}

function dockChip(state: WorkerDerivedState, loaded: boolean): string | undefined {
	if (loaded && (state === "ready" || state === "ready_open_todos")) return "loaded";
	if (state === "needs_input") return "← reply";
	if (state === "failed") return "← inspect";
	if (state === "ready" || state === "ready_open_todos") return "← review";
	if (state === "reviewed") return "✓";
	return undefined;
}

function isAttentionState(state: WorkerDerivedState, loaded: boolean): boolean {
	if (loaded && (state === "ready" || state === "ready_open_todos")) return false;
	if (state === "reviewed") return false;
	return state === "needs_input" || state === "failed" || state === "ready" || state === "ready_open_todos";
}

export function dockRowsForRender(
	rows: WorkerActivityRow[],
	options: { parentModelId?: string; now?: number; eventsByWorker?: Map<string, WorkerEvent[]> } = {},
): DockRow[] {
	const now = options.now ?? Date.now();
	const workers = rows.map((row) => row.worker);
	return rows.map((row) => {
		const modelBadge = pickModelBadge(row.worker, workers, options.parentModelId);
		const chip = dockChip(row.state, row.loaded);
		const events = options.eventsByWorker?.get(row.worker.id);
		const eventLine = dockEventSubLine(events, row.state, { now, worker: row.worker });
		const kindLabel = workerKindLabel(row.worker);
		return {
			worker: row.worker,
			label: row.label,
			state: row.state,
			taskLabel: row.taskLabel,
			progressLabel: dockProgressLabel(row),
			ageLabel: relativeAgeLabel(row.updatedAt || Date.parse(row.worker.updatedAt) || now, now),
			attention: isAttentionState(row.state, row.loaded),
			...(chip ? { chip } : {}),
			...(kindLabel ? { kindLabel } : {}),
			...(modelBadge ? { modelBadge } : {}),
			...(eventLine ? { eventLine } : {}),
		};
	});
}

export function workerActivityStateLabel(state: WorkerDerivedState): string {
	if (state === "needs_input") return "needs input";
	if (state === "ready_open_todos") return "ready/progress";
	if (state === "ready") return "ready";
	if (state === "failed") return "failed";
	if (state === "reviewed") return "reviewed";
	if (state === "thinking") return "active";
	if (state === "starting") return "starting";
	if (state === "stale") return "stale";
	if (state === "empty") return "done/empty";
	return "idle";
}

function workerActivityActionHint(state: WorkerDerivedState): string {
	if (state === "needs_input") return "press c to reply";
	if (state === "ready" || state === "ready_open_todos") return "press l to load";
	if (state === "failed") return "Enter details";
	if (state === "reviewed") return "Enter re-open";
	if (state === "starting" || state === "thinking") return "working";
	return "Enter details";
}

export function workerActivityRows(workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]> = new Map(), options: { now?: number; maxTodoItems?: number; loadedWorkerIds?: ReadonlySet<string> } = {}): WorkerActivityRow[] {
	const now = options.now ?? Date.now();
	const conflictsByWorker = workerConflictMap(workers, artifactsByWorker);
	return workers.map((worker) => {
		const artifacts = artifactsByWorker.get(worker.id) ?? [];
		const review = projectWorkerReview(worker, artifacts, now);
		const state = review.state;
		const answer = review.result;
		const answerLine = answer && !review.resultIsStatus ? firstWorkerReviewLine(answer.title) ?? firstWorkerReviewLine(answer.body) : undefined;
		const questions = review.questions;
		const questionText = questions.map((question, index) => `${index + 1}. ${question.text}`).join(" ");
		const message = state === "needs_input" && questionText ? questionText : review.summary || workerDisplayName(worker);
		const summary = review.summarySource;
		const recommendations = review.recommendations.length || countWorkerRecommendations(summary);
		const { evidence, filesChanged } = computeEvidence(artifacts);
		const progress = workerTodoProgress(worker);
		const conflicts = conflictsByWorker.get(worker.id) ?? [];
		const loaded = options.loadedWorkerIds?.has(worker.id) === true;
		return {
			worker,
			label: workerSourceLabel(worker),
			chip: workerActivityChip(worker, { now }),
			state,
			stateLabel: workerActivityStateLabel(state),
			taskLabel: workerDisplayName(worker, 32),
			message,
			answer,
			answerLine,
			outputLabel: buildOutputLabel(state, answer, recommendations, filesChanged, progress, conflicts, loaded),
			actionHint: workerActivityActionHint(state),
			questions,
			progress,
			todoLines: workerTodoBoardLines(worker, { maxItems: options.maxTodoItems ?? 12, maxText: Number.POSITIVE_INFINITY }),
			recommendations,
			filesChanged,
			evidence,
			loaded,
			conflicts,
			...(summary ? { summary } : {}),
			updatedAt: Date.parse(worker.updatedAt) || 0,
		};
	}).sort((a, b) => workerStateRank(a.worker, now) - workerStateRank(b.worker, now) || b.updatedAt - a.updatedAt);
}

export function workerActivityTotals(rows: WorkerActivityRow[]): WorkerActivityTotals {
	return rows.reduce((acc, row) => {
		acc.workers++;
		if (row.loaded && (row.state === "ready" || row.state === "ready_open_todos")) acc.loaded++;
		else if (row.state === "reviewed") acc.reviewed++;
		else if (row.state === "thinking" || row.state === "starting") acc.active++;
		else if (row.state === "needs_input") acc.waiting++;
		else if (row.state === "ready_open_todos") acc.readyOpenTodos++;
		else if (row.state === "ready") acc.ready++;
		else if (row.state === "failed") acc.failed++;
		acc.todos += row.progress.total;
		acc.completedTodos += row.progress.completed;
		return acc;
	}, { workers: 0, active: 0, waiting: 0, ready: 0, readyOpenTodos: 0, failed: 0, loaded: 0, reviewed: 0, todos: 0, completedTodos: 0 });
}

export function workerActivityStackLines(rows: WorkerActivityRow[]): WorkerActivityStackLine[] {
	const lines: WorkerActivityStackLine[] = [];
	for (const row of rows) {
		const progressStatus = row.progress.total ? ` · progress ${row.progress.completed}/${row.progress.total}` : "";
		const loadedStatus = row.loaded && (row.state === "ready" || row.state === "ready_open_todos") ? " · loaded" : "";
		lines.push({ kind: "worker", state: row.state, worker: row.worker, text: `${row.chip} · ${row.stateLabel}${loadedStatus}${progressStatus} · ${row.taskLabel} · ${row.outputLabel} · ${row.actionHint}` });
	}
	return lines;
}

function previewOutcomeBody(row: WorkerActivityRow): string {
	if (row.state === "needs_input" && row.questions.length) return row.questions.map((q, i) => `${i + 1}. ${q.text}`).join("\n");
	if (row.state === "failed") return row.worker.lastError || row.message || "Failure recorded without detail.";
	if (row.state === "starting" || row.state === "thinking") return `${row.taskLabel} — working`;
	return row.message || row.answerLine || row.taskLabel;
}

function previewEvidenceBody(row: WorkerActivityRow): string {
	const counts: string[] = [];
	if (row.evidence.reads > 0) counts.push(`${row.evidence.reads} reads`);
	if (row.evidence.commands > 0) counts.push(`${row.evidence.commands} commands`);
	if (row.evidence.edits > 0) counts.push(`${row.evidence.edits} edits`);
	if (row.evidence.codeBlocks > 0) counts.push(`${row.evidence.codeBlocks} code blocks`);
	if (row.evidence.errors > 0) counts.push(`${row.evidence.errors} errors`);
	const sample = row.evidence.sampleFiles.length ? `Files: ${row.evidence.sampleFiles.slice(0, 3).join(", ")}${row.evidence.sampleFiles.length > 3 ? "…" : ""}` : undefined;
	const conflict = conflictSummary(row.conflicts, 3);
	const summary = counts.length ? counts.join(" · ") : "No artifacts captured yet.";
	return [summary, sample, conflict ? `Overlap: ${conflict}` : undefined].filter((line): line is string => line !== undefined).join("\n");
}

function previewNextActions(row: WorkerActivityRow): string {
	const primary = row.state === "failed"
		? "Enter inspect"
		: row.state === "starting" || row.state === "thinking"
			? "Enter details"
			: "Enter verdict";
	const load = row.loaded ? "l loaded" : "l load";
	return [primary, "p peek", load, "c continue", "a attach", "x dismiss"].join(" · ");
}

function previewProgressBody(row: WorkerActivityRow, options: WorkerActivityPreviewOptions): string | undefined {
	const detail = workerProgressDetail(row.progress);
	if (!detail) return undefined;
	const maxTodoItems = options.maxTodoItems ?? (options.showProgressDetail ? 12 : 3);
	const todoLines = workerTodoBoardLines(row.worker, { maxItems: maxTodoItems, maxText: options.showProgressDetail ? 96 : 72 });
	return [detail, ...todoLines].join("\n");
}

export function workerActivityPreviewLines(row: WorkerActivityRow, options: WorkerActivityPreviewOptions = {}): string[] {
	const kindLabel = workerKindLabel(row.worker);
	const progress = previewProgressBody(row, options);
	const task = row.worker.task?.trim() || row.taskLabel;
	const lines: string[] = ["Task", task];
	if (kindLabel) lines.push("Kind", kindLabel);
	if (progress) lines.push("Progress", progress);
	lines.push(
		"Outcome",
		previewOutcomeBody(row),
		"Evidence",
		previewEvidenceBody(row),
		"Next actions",
		previewNextActions(row),
	);
	return lines;
}
