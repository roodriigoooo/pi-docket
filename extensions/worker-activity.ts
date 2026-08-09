import { visibleWidth } from "@mariozechner/pi-tui";
import { deriveWorkerState, workerActivityChip, workerDisplayName, workerQuestions, workerSourceLabel, workerStateRank, workerTodoBoardLines, workerTodoProgress, type WorkerDerivedState, type WorkerQuestion, type WorkerStatus } from "./background-work.js";
import type { Artifact } from "./types.js";
import type { WorkerEvent } from "./worker-events.js";
import { countWorkerRecommendations, firstWorkerReviewLine, isWorkerStatusArtifact, projectWorkerReview } from "./worker-review.js";
import { conflictSummary, workerConflictMap, type WorkerFileConflict } from "./worker-conflicts.js";
import { pendingWorkerMessageLine, type WorkerMessage } from "./worker-mailbox.js";
import { isAttentionWorker, isReviewableWorker, workerIsGone } from "./worker-lifecycle.js";
import { workerDeliverableFromArtifact, type WorkerDeliverable } from "./worker-deliverable.js";

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
	/** Observed: no process remains to act on anything this row offers. */
	gone: boolean;
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
	let label: string;
	if (conflict) label = conflict;
	else if (state === "consulting") label = "asking parent";
	else if (state === "needs_input") label = "needs reply";
	else if (state === "starting" || state === "thinking") label = "working";
	else if (state === "failed") label = "error";
	else if (state === "stale") label = "stale";
	else if (state === "ready" || state === "ready_open_todos") {
		const parts: string[] = [];
		if (recommendations > 0) parts.push(`${recommendations} ${recommendations === 1 ? "rec" : "recs"}`);
		parts.push(filesChanged > 0 ? `${filesChanged} ${filesChanged === 1 ? "file" : "files"} changed` : "no files");
		if (progress.total > 0) parts.push(`${progress.completed}/${progress.total} progress`);
		if (parts.length === 0 || (parts.length === 1 && parts[0] === "no files")) {
			label = !answer || isWorkerStatusArtifact(answer) ? "summary only" : parts.join(" · ");
		} else {
			label = parts.join(" · ");
		}
	} else if (state === "reviewed") label = "reviewed";
	else if (!answer || isWorkerStatusArtifact(answer)) label = "no output";
	else if (answer.kind === "error") label = "error";
	else if (answer.kind === "code") label = "code output";
	else label = "text output";
	return loaded ? `${label} · loaded` : label;
}

export function shortModelLabel(id: string | undefined): string | undefined {
	if (!id) return undefined;
	const providerSlash = id.indexOf("/");
	const cleaned = (providerSlash >= 0 ? id.slice(providerSlash + 1) : id).replace(/^claude-/, "");
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
	loaded: boolean;
	/** Observed: the worker's process is gone, whatever its work amounts to. */
	gone: boolean;
	/** The decision is behind this row: it leaves the dock and lives in `f8`. */
	settled: boolean;
	/** Untruncated task text. The dock has a task column now, so the column decides the cut. */
	taskFull: string;
	chip?: string;
	kindLabel?: string;
	modelBadge?: string;
	eventLine?: string;
};

/** Plain text of one dock row's cells, before any colour, so widths can be measured. */
export type DockRowCells = {
	label: string;
	state: string;
	task: string;
	meta: string;
	age: string;
	chip: string;
};

/** Fixed column widths for one dock render. A zero width means the column is dropped. */
export type DockColumns = {
	label: number;
	state: number;
	task: number;
	meta: number;
	age: number;
	chip: number;
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

export function dockEventSubLine(events: WorkerEvent[] | undefined, state: WorkerDerivedState, options: { now?: number; worker?: WorkerStatus; messages?: WorkerMessage[]; staleLine?: string } = {}): string | undefined {
	const now = options.now ?? Date.now();
	// A message the worker has not taken outranks every other hint: it is the one case where
	// the human already acted and nothing has happened yet.
	const pending = options.messages ? pendingWorkerMessageLine(options.messages, workerIsGone(options.worker, now)) : undefined;
	if (pending) return pending;
	// Next: the worker is building on something that is no longer true. It outranks the state
	// hints below because those describe what the worker is doing, and this describes whether
	// what it is doing still holds. Not once a verdict is recorded, though: there is no decision
	// left for it to change, and if the worker produces another generation the fact returns on
	// the verdict card, which is where it acts.
	if (options.staleLine && state !== "reviewed") return options.staleLine;
	if (state === "consulting") {
		// Nobody is blocked on the human yet, so this is a status line, not a warning.
		return "asking the parent agent · escalates to you if unanswered";
	}
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
	return undefined;
}

function relativeAgeLabel(updatedAtMs: number, now: number): string {
	return ageLabelFromMs(now - updatedAtMs);
}

function dockProgressLabel(row: WorkerActivityRow): string {
	// Overlap warns about a decision still to come. Once the verdict is recorded there is nothing
	// left to warn about, so the settled state wins the cell.
	if (row.state === "reviewed") return "reviewed";
	const conflict = conflictSummary(row.conflicts, 1, { shortPaths: true });
	if (conflict) return conflict;
	if (row.progress.total > 0) return workerProgressCompact(row.progress) ?? `${row.progress.completed}/${row.progress.total} progress`;
	if (row.state === "ready" || row.state === "ready_open_todos") {
		if (row.recommendations > 0) return `${row.recommendations} ${row.recommendations === 1 ? "rec" : "recs"}`;
		if (row.filesChanged > 0) return `${row.filesChanged} ${row.filesChanged === 1 ? "file" : "files"} changed`;
	}
	if (row.state === "consulting") return "asking parent";
	if (row.state === "needs_input") return "needs reply";
	if (row.state === "failed") return "error";
	if (row.state === "stopped") return "no report";
	return "";
}

function dockChip(state: WorkerDerivedState): string | undefined {
	if (state === "needs_input" || state === "consulting" || state === "failed" || state === "ready" || state === "ready_open_todos") return "f8 verdict";
	if (state === "reviewed") return "✓";
	return undefined;
}

function isAttentionState(worker: WorkerStatus, now: number): boolean {
	return isAttentionWorker(worker, now);
}

/**
 * A settled worker has its decision behind it: the human recorded a verdict, or the process
 * ended without ever making a claim. Nothing on such a row is waiting on anyone, so it leaves
 * the dock — the dock answers "is anything waiting on me", and `f8` answers "what is the whole
 * fleet doing".
 *
 * A message the worker never took un-settles it. There the human already acted and nothing has
 * happened yet, which is precisely the case the dock exists to show.
 */
export function isSettledDockState(state: WorkerDerivedState): boolean {
	return state === "reviewed" || state === "stopped";
}

/** Splits a rendered dock into the rows that stay and the rows the heading now stands for. */
export function partitionDockRows(rows: DockRow[]): { visible: DockRow[]; settled: DockRow[] } {
	const visible: DockRow[] = [];
	const settled: DockRow[] = [];
	for (const row of rows) (row.settled ? settled : visible).push(row);
	return { visible, settled };
}

/** The one line that stands for every folded row. Absent when nothing is folded. */
export function dockSettledLine(count: number): string | undefined {
	return count > 0 ? `${count} settled · f8` : undefined;
}

export function dockRowCells(row: DockRow): DockRowCells {
	const kindCell = row.kindLabel ? `·${row.kindLabel}` : "";
	const modelCell = row.modelBadge ? `[${row.modelBadge}]` : "";
	const state = row.state === "thinking" || row.state === "starting"
		? ""
		: row.state === "ready_open_todos"
			? "ready/progress"
			: row.gone && row.state === "ready"
				? "ready · gone"
				: row.state.replace(/_/g, " ");
	return {
		label: `${row.label}${kindCell}${modelCell}`,
		state,
		task: row.taskFull || row.taskLabel,
		meta: [row.progressLabel, row.loaded ? "loaded" : undefined].filter(Boolean).join(" · "),
		age: row.ageLabel,
		chip: row.chip ?? "",
	};
}

/** Two spaces, not one: with the columns doing the separating, the air is what makes them read. */
export const DOCK_GUTTER = 2;
const DOCK_LABEL_MIN = 5;
const DOCK_LABEL_MAX = 24;
const DOCK_STATE_MAX = 14;
const DOCK_META_MIN = 20;
const DOCK_META_MAX = 34;
const DOCK_TASK_PREFERRED = 30;
const DOCK_CHIP_MAX = 12;
const DOCK_AGE_MAX = 4;
const DOCK_TASK_MIN = 18;

/**
 * One set of column widths for the whole dock, so the separators between rows line up instead of
 * landing wherever the previous cell happened to end. Same discipline the `f8` table already
 * uses; a dock that grows with the fleet has to be scannable down a column, not across a line.
 *
 * Under pressure the secondary columns go first — meta, then state, then the chip — because the
 * task text is the handle a human actually navigates by.
 */
export function dockColumns(rows: DockRow[], width: number): DockColumns {
	const cells = rows.map(dockRowCells);
	const widest = (pick: (cell: DockRowCells) => string, max: number): number =>
		Math.min(max, cells.reduce((acc, cell) => Math.max(acc, visibleWidth(pick(cell))), 0));
	const columns: DockColumns = {
		label: widest((cell) => cell.label, DOCK_LABEL_MAX),
		state: widest((cell) => cell.state, DOCK_STATE_MAX),
		task: 0,
		meta: widest((cell) => cell.meta, DOCK_META_MAX),
		age: widest((cell) => cell.age, DOCK_AGE_MAX),
		chip: widest((cell) => cell.chip, DOCK_CHIP_MAX),
	};
	// The marker and its single space, then one gutter for every other column the task shares the
	// line with.
	const spent = (): number => 2 + [columns.label, columns.state, columns.meta, columns.age, columns.chip]
		.reduce((acc, column) => column > 0 ? acc + column + DOCK_GUTTER : acc, 0);
	// The ladder below encodes what a row is for. Task text and kind identify the worker, so they
	// give ground last (P6: `w3` alone is never the only handle). Everything else is detail the
	// card behind `f8` carries in full.
	const short = (target: number): number => target - (width - spent());
	// 1. A wide meta cell hands back what it can.
	if (short(DOCK_TASK_PREFERRED) > 0) columns.meta = Math.max(Math.min(columns.meta, DOCK_META_MIN), columns.meta - short(DOCK_TASK_PREFERRED));
	// 2. Then meta, the state word, and the chip leave entirely rather than starve the task.
	for (const column of ["meta", "state", "chip"] as const) {
		if (short(column === "meta" ? DOCK_TASK_PREFERRED : DOCK_TASK_MIN) <= 0) break;
		columns[column] = 0;
	}
	// 3. Only then does the label give back its kind and model badge.
	if (short(DOCK_TASK_MIN) > 0) columns.label = Math.max(DOCK_LABEL_MIN, columns.label - short(DOCK_TASK_MIN));
	columns.task = Math.max(0, width - spent());
	return columns;
}

export function dockRowsForRender(
	rows: WorkerActivityRow[],
	options: { parentModelId?: string; now?: number; eventsByWorker?: Map<string, WorkerEvent[]>; messagesByWorker?: ReadonlyMap<string, WorkerMessage[]>; staleLineByWorker?: ReadonlyMap<string, string> } = {},
): DockRow[] {
	const now = options.now ?? Date.now();
	const workers = rows.map((row) => row.worker);
	return rows.map((row) => {
		const modelBadge = pickModelBadge(row.worker, workers, options.parentModelId);
		const chip = dockChip(row.state);
		const events = options.eventsByWorker?.get(row.worker.id);
		const messages = options.messagesByWorker?.get(row.worker.id);
		const staleLine = options.staleLineByWorker?.get(row.worker.id);
		const eventLine = dockEventSubLine(events, row.state, { now, worker: row.worker, ...(messages ? { messages } : {}), ...(staleLine ? { staleLine } : {}) });
		const untaken = messages ? pendingWorkerMessageLine(messages, workerIsGone(row.worker, now)) : undefined;
		const kindLabel = workerKindLabel(row.worker);
		return {
			worker: row.worker,
			label: row.label,
			state: row.state,
			taskLabel: row.taskLabel,
			progressLabel: dockProgressLabel(row),
			ageLabel: relativeAgeLabel(row.updatedAt || Date.parse(row.worker.updatedAt) || now, now),
			attention: isAttentionState(row.worker, now),
			loaded: row.loaded,
			gone: row.gone,
			settled: isSettledDockState(row.state) && !untaken,
			taskFull: workerDisplayName(row.worker, Number.POSITIVE_INFINITY),
			...(chip ? { chip } : {}),
			...(kindLabel ? { kindLabel } : {}),
			...(modelBadge ? { modelBadge } : {}),
			...(eventLine ? { eventLine } : {}),
		};
	});
}

export function workerActivityStateLabel(state: WorkerDerivedState): string {
	if (state === "consulting") return "consulting";
	if (state === "needs_input") return "needs input";
	if (state === "ready_open_todos") return "ready/progress";
	if (state === "ready") return "ready";
	if (state === "failed") return "failed";
	if (state === "reviewed") return "reviewed";
	if (state === "thinking") return "active";
	if (state === "starting") return "starting";
	if (state === "stale") return "stale";
	if (state === "stopped") return "stopped";
	if (state === "empty") return "done/empty";
	return "idle";
}

function workerActivityActionHint(worker: WorkerStatus, state: WorkerDerivedState, now: number): string {
	if (isReviewableWorker(worker, now)) return "press Enter for verdict";
	if (state === "reviewed") return "Enter re-open";
	if (state === "starting" || state === "thinking") return "working";
	return "Enter details";
}

export type WorkerActivityActionProjection = {
	enter: "verdict" | "details";
	load: boolean;
	peek: "peek";
	/** `queue` when nothing is running to take it: the key still works, the promise does not. */
	tell: "tell" | "queue";
	stop: "stop" | "dismiss";
};

export function workerActivityActionProjection(row: WorkerActivityRow, now = Date.now()): WorkerActivityActionProjection {
	const gone = row.gone;
	return {
		enter: isReviewableWorker(row.worker, now) || deriveWorkerState(row.worker, now) === "reviewed" ? "verdict" : "details",
		load: !row.loaded,
		peek: "peek",
		tell: gone ? "queue" : "tell",
		stop: gone ? "dismiss" : "stop",
	};
}

export function workerActivityRows(workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]> = new Map(), options: { now?: number; maxTodoItems?: number; explicitlyLoadedWorkerIds?: ReadonlySet<string>; deliverablesByWorker?: ReadonlyMap<string, WorkerDeliverable> } = {}): WorkerActivityRow[] {
	const now = options.now ?? Date.now();
	const conflictsByWorker = workerConflictMap(workers, artifactsByWorker);
	return workers.map((worker) => {
		const artifacts = artifactsByWorker.get(worker.id) ?? [];
		const deliverable = options.deliverablesByWorker?.get(worker.id)
			?? artifacts.map((artifact) => workerDeliverableFromArtifact(artifact)).find((item): item is WorkerDeliverable => item !== undefined);
		const review = projectWorkerReview(worker, artifacts, now, deliverable);
		const state = review.state;
		const answer = review.result;
		const answerLine = answer && !review.resultIsStatus ? firstWorkerReviewLine(answer.title) ?? firstWorkerReviewLine(answer.body) : undefined;
		const questions = review.questions;
		const questionText = questions.map((question, index) => `${index + 1}. ${question.text}`).join(" ");
		const message = (state === "needs_input" || state === "consulting") && questionText ? questionText : review.summary || workerDisplayName(worker);
		const summary = review.summarySource;
		const recommendations = review.recommendations.length || countWorkerRecommendations(summary);
		const computedEvidence = computeEvidence(artifacts);
		const evidence = computedEvidence.evidence;
		const filesChanged = deliverable?.changeSet?.files.length ?? computedEvidence.filesChanged;
		const progress = workerTodoProgress(worker);
		const conflicts = conflictsByWorker.get(worker.id) ?? [];
		const loaded = options.explicitlyLoadedWorkerIds?.has(worker.id) === true;
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
			actionHint: workerActivityActionHint(worker, state, now),
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
			gone: workerIsGone(worker, now),
		};
	}).sort((a, b) => workerStateRank(a.worker, now) - workerStateRank(b.worker, now) || b.updatedAt - a.updatedAt);
}

export function workerActivityTotals(rows: WorkerActivityRow[]): WorkerActivityTotals {
	return rows.reduce((acc, row) => {
		acc.workers++;
		if (row.loaded) acc.loaded++;
		if (row.state === "reviewed") acc.reviewed++;
		else if (isReviewableWorker(row.worker)) {
			if (row.state === "thinking" || row.state === "starting") acc.active++;
			else if (row.state === "needs_input") acc.waiting++;
			else if (row.state === "ready_open_todos") acc.readyOpenTodos++;
			else if (row.state === "ready") acc.ready++;
			else if (row.state === "failed") acc.failed++;
		} else if (row.state === "thinking" || row.state === "starting") acc.active++;
		acc.todos += row.progress.total;
		acc.completedTodos += row.progress.completed;
		return acc;
	}, { workers: 0, active: 0, waiting: 0, ready: 0, readyOpenTodos: 0, failed: 0, loaded: 0, reviewed: 0, todos: 0, completedTodos: 0 });
}

export function workerActivityStackLines(rows: WorkerActivityRow[]): WorkerActivityStackLine[] {
	const lines: WorkerActivityStackLine[] = [];
	for (const row of rows) {
		const progressStatus = row.progress.total ? ` · progress ${row.progress.completed}/${row.progress.total}` : "";
		lines.push({ kind: "worker", state: row.state, worker: row.worker, text: `${row.chip} · ${row.stateLabel}${progressStatus} · ${row.taskLabel} · ${row.outputLabel} · ${row.actionHint}` });
	}
	return lines;
}

function previewOutcomeBody(row: WorkerActivityRow): string {
	if ((row.state === "needs_input" || row.state === "consulting") && row.questions.length) return row.questions.map((q, i) => `${i + 1}. ${q.text}`).join("\n");
	if (row.state === "failed") return row.worker.lastError || row.message || "Failure recorded without detail.";
	if (row.state === "starting" || row.state === "thinking") return `${row.taskLabel} — working`;
	if (row.state === "stopped") return "Stopped before reporting. The evidence below is how far it had got.";
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
	const actions = workerActivityActionProjection(row);
	return [
		`p ${actions.peek}`,
		`r ${actions.tell}`,
		`Enter ${actions.enter}`,
		actions.load ? "l load" : undefined,
		`x ${actions.stop}`,
	].filter((item): item is string => item !== undefined).join(" · ");
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
