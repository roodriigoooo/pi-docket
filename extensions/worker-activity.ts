import { deriveWorkerState, workerActivityChip, workerDisplayName, workerQuestions, workerSourceLabel, workerStateRank, workerTodoBoardLines, workerTodoProgress, type WorkerDerivedState, type WorkerQuestion, type WorkerStatus } from "./background-work.js";
import { isWorkerStatusArtifact, workerResultArtifact, workerResultSummary } from "./worker-result.js";
import type { Artifact } from "./types.js";

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
	todos: number;
	completedTodos: number;
};

function firstLine(text: string | undefined): string | undefined {
	const line = text?.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
	return line || undefined;
}

const BULLET_PREFIX = /^\s*(?:[-*•]|\d+[.)])\s+/;

function countRecommendations(summary: string | undefined): number {
	if (!summary) return 0;
	let count = 0;
	let inRecommended = false;
	for (const raw of summary.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) { if (inRecommended) break; continue; }
		if (/^recommended:?$/i.test(line) || /^recommendations:?$/i.test(line) || /^suggested:?$/i.test(line)) { inRecommended = true; continue; }
		if (BULLET_PREFIX.test(line)) count++;
		else if (inRecommended) count++;
	}
	if (count > 0) return count;
	const numbered = summary.match(/\b(\d+)\s+(?:suggestions?|recommendations?|recs?)\b/i);
	return numbered ? Number(numbered[1]) : 0;
}

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

function buildOutputLabel(state: WorkerDerivedState, answer: Artifact | undefined, recommendations: number, filesChanged: number, progress: { total: number; completed: number }): string {
	if (state === "needs_input") return "needs reply";
	if (state === "starting" || state === "thinking") return "working";
	if (state === "failed") return "error";
	if (state === "stale") return "stale";
	if (state === "ready" || state === "ready_open_todos") {
		const parts: string[] = [];
		if (recommendations > 0) parts.push(`${recommendations} ${recommendations === 1 ? "rec" : "recs"}`);
		parts.push(filesChanged > 0 ? `${filesChanged} ${filesChanged === 1 ? "file" : "files"} changed` : "no files");
		if (progress.total > 0) parts.push(`${progress.completed}/${progress.total} todos`);
		if (parts.length === 0 || (parts.length === 1 && parts[0] === "no files")) {
			if (!answer || isWorkerStatusArtifact(answer)) return "summary only";
		}
		return parts.join(" · ");
	}
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

export type DockRow = {
	worker: WorkerStatus;
	label: string;
	state: WorkerDerivedState;
	taskLabel: string;
	progressLabel: string;
	ageLabel: string;
	attention: boolean;
	chip?: string;
	modelBadge?: string;
};

function relativeAgeLabel(updatedAtMs: number, now: number): string {
	const ageMs = now - updatedAtMs;
	if (!Number.isFinite(ageMs) || ageMs < 0) return "";
	const seconds = Math.round(ageMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return `${hours}h`;
}

function dockProgressLabel(row: WorkerActivityRow): string {
	if (row.progress.total > 0) return `${row.progress.completed}/${row.progress.total} todos`;
	if (row.state === "ready" || row.state === "ready_open_todos") {
		if (row.recommendations > 0) return `${row.recommendations} ${row.recommendations === 1 ? "rec" : "recs"}`;
		if (row.filesChanged > 0) return `${row.filesChanged} ${row.filesChanged === 1 ? "file" : "files"} changed`;
	}
	if (row.state === "needs_input") return "needs reply";
	if (row.state === "failed") return "error";
	return "";
}

function dockChip(state: WorkerDerivedState): string | undefined {
	if (state === "needs_input") return "← reply";
	if (state === "failed") return "← inspect";
	if (state === "ready" || state === "ready_open_todos") return "← review";
	return undefined;
}

function isAttentionState(state: WorkerDerivedState): boolean {
	return state === "needs_input" || state === "failed" || state === "ready" || state === "ready_open_todos";
}

export function dockRowsForRender(
	rows: WorkerActivityRow[],
	options: { parentModelId?: string; now?: number } = {},
): DockRow[] {
	const now = options.now ?? Date.now();
	const workers = rows.map((row) => row.worker);
	return rows.map((row) => {
		const modelBadge = pickModelBadge(row.worker, workers, options.parentModelId);
		const chip = dockChip(row.state);
		return {
			worker: row.worker,
			label: row.label,
			state: row.state,
			taskLabel: row.taskLabel,
			progressLabel: dockProgressLabel(row),
			ageLabel: relativeAgeLabel(row.updatedAt || Date.parse(row.worker.updatedAt) || now, now),
			attention: isAttentionState(row.state),
			...(chip ? { chip } : {}),
			...(modelBadge ? { modelBadge } : {}),
		};
	});
}

export function workerActivityStateLabel(state: WorkerDerivedState): string {
	if (state === "needs_input") return "needs input";
	if (state === "ready_open_todos") return "ready/open todos";
	if (state === "ready") return "ready";
	if (state === "failed") return "failed";
	if (state === "thinking") return "active";
	if (state === "starting") return "starting";
	if (state === "stale") return "stale";
	if (state === "empty") return "done/empty";
	return "idle";
}

function workerSummaryForCounts(worker: WorkerStatus, answer: Artifact | undefined): string | undefined {
	const parts: string[] = [];
	if (typeof worker.summary === "string" && worker.summary.length > 0) parts.push(worker.summary);
	if (answer && !isWorkerStatusArtifact(answer)) parts.push(`${answer.title}\n${answer.body}`);
	return parts.length ? parts.join("\n") : undefined;
}

function workerActivityActionHint(state: WorkerDerivedState): string {
	if (state === "needs_input") return "press c to reply";
	if (state === "ready" || state === "ready_open_todos") return "press l to load";
	if (state === "failed") return "Enter details";
	if (state === "starting" || state === "thinking") return "working";
	return "Enter details";
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
		const summary = workerSummaryForCounts(worker, answer);
		const recommendations = countRecommendations(summary);
		const { evidence, filesChanged } = computeEvidence(artifacts);
		const progress = workerTodoProgress(worker);
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
			outputLabel: buildOutputLabel(state, answer, recommendations, filesChanged, progress),
			actionHint: workerActivityActionHint(state),
			questions,
			progress,
			todoLines: workerTodoBoardLines(worker, { maxItems: options.maxTodoItems ?? 12, maxText: Number.POSITIVE_INFINITY }),
			recommendations,
			filesChanged,
			evidence,
			...(summary ? { summary } : {}),
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
		lines.push({ kind: "worker", state: row.state, worker: row.worker, text: `${row.chip} · ${row.stateLabel}${todoStatus} · ${row.taskLabel} · ${row.outputLabel} · ${row.actionHint}` });
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
	if (row.progress.total > 0) counts.push(`${row.progress.completed}/${row.progress.total} todos`);
	const sample = row.evidence.sampleFiles.length ? `Files: ${row.evidence.sampleFiles.slice(0, 3).join(", ")}${row.evidence.sampleFiles.length > 3 ? "…" : ""}` : undefined;
	const summary = counts.length ? counts.join(" · ") : "No artifacts captured yet.";
	return sample ? `${summary}\n${sample}` : summary;
}

function previewNextActions(row: WorkerActivityRow): string {
	const primary = row.state === "needs_input"
		? "[c Reply]"
		: row.state === "failed"
			? "[Enter Inspect failure]"
			: row.state === "ready" || row.state === "ready_open_todos"
				? "[Enter Review answer]"
				: "[Enter Open]";
	const buttons = [primary, "[l Load summary]", "[c Continue]", "[a Attach tmux]", "[x Dismiss]"];
	return buttons.join(" ");
}

export function workerActivityPreviewLines(row: WorkerActivityRow): string[] {
	return [
		"Outcome",
		previewOutcomeBody(row),
		"Evidence",
		previewEvidenceBody(row),
		"Next actions",
		previewNextActions(row),
	];
}
