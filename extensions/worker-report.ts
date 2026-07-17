import {
	deriveWorkerState,
	workerQuestions,
	workerSourceLabel,
	workerTodoBoardLines,
	workerTodoProgress,
	type WorkerDerivedState,
	type WorkerStatus,
} from "./background-work.js";
import type { Artifact, ArtifactSummary } from "./types.js";
import { workerChangeSetArtifact } from "./worker-changes.js";
import { workerDeliverableFromArtifact, type WorkerDeliverable } from "./worker-deliverable.js";
import {
	extractWorkerRecommendations,
	firstWorkerReviewLine,
	truncateWorkerReviewText,
	workerAnswerArtifacts,
	workerRecommendedItems,
	workerSummaryHeadline,
} from "./worker-review.js";

export type WorkerReportCommandStatus = "ok" | "failed" | "unknown";

export type WorkerReportCommand = {
	displayId: string;
	title: string;
	status: WorkerReportCommandStatus;
};

export type WorkerReportRef = {
	displayId: string;
	kind: Artifact["kind"];
	label: string;
	ref: string;
};

export type WorkerReportFile = {
	path: string;
	additions?: number;
	deletions?: number;
};

export type WorkerReportChangeTotals = {
	files: number;
	additions: number;
	deletions: number;
	hunkCount?: number;
};

export type WorkerReportCheckCounts = {
	ok: number;
	failed: number;
	unknown: number;
	total: number;
};

export type WorkerReport = {
	label: string;
	task: string;
	kind?: string;
	state: WorkerDerivedState;
	stateLabel: string;
	outcome?: string;
	updatedAt: string;
	scopeConfidence?: string;
	progressLine: string;
	/** Full summary with any Recommended: block stripped so recommendations stay separate. */
	summary: string;
	summaryHeadline: string;
	recommendations: string[];
	evidence: string[];
	changeTotals: WorkerReportChangeTotals;
	changedFiles: WorkerReportFile[];
	changeSetRef?: string;
	checks: WorkerReportCheckCounts;
	recentCommands: WorkerReportCommand[];
	commandsOverflow: number;
	refs: WorkerReportRef[];
	primarySection: "outcome" | "question" | "failure";
	primaryBody: string;
	deliverableId?: string;
	deliverableVersion?: number;
	deliverableRef?: string;
	sourceHandoff?: WorkerDeliverable["sourceHandoff"];
};

const VERDICT_FILE_CAP = 5;
const VERDICT_EVIDENCE_CAP = 3;
const VERDICT_RECOMMENDATION_CAP = 2;
const REPORT_COMMAND_CAP = 8;
const REPORT_REF_CAP = 8;

export function displayWorkerSummary(worker: WorkerStatus): string {
	const raw = typeof worker.summary === "string" ? worker.summary : "";
	if (!raw) return "";
	const recommendedIdx = raw.search(/\brecommend(ed|ations?):?/i);
	if (recommendedIdx < 0) return raw.trim();
	const hasStructured = Array.isArray(worker.recommended) && worker.recommended.length > 0;
	const embedded = extractWorkerRecommendations(raw, Number.POSITIVE_INFINITY);
	if (hasStructured || embedded.length > 0) return raw.slice(0, recommendedIdx).trim();
	return raw.trim();
}

function progressLine(worker: WorkerStatus): string {
	const todos = worker.todos ?? [];
	if (todos.length === 0) return "no progress";
	const completed = todos.filter((t) => t.state === "completed").length;
	const open = todos.length - completed;
	if (open === 0) return `${completed}/${todos.length} progress complete`;
	return `${completed}/${todos.length} progress · ${open} open`;
}

function commandStatus(artifact: Artifact): WorkerReportCommandStatus {
	const exitCode = artifact.meta?.exitCode;
	if (typeof exitCode === "number") return exitCode === 0 ? "ok" : "failed";
	const subtitle = artifact.subtitle?.toLowerCase() ?? "";
	if (/\bfailed\b|\berror\b/.test(subtitle)) return "failed";
	if (/\bok\b/.test(subtitle)) return "ok";
	const body = artifact.body ?? "";
	if (/^status:\s*error\b/im.test(body) || /^status:\s*failed\b/im.test(body)) return "failed";
	if (/^status:\s*ok\b/im.test(body)) return "ok";
	if (typeof artifact.meta?.isError === "boolean") return artifact.meta.isError ? "failed" : "ok";
	return "unknown";
}

function changeFilesFromArtifact(changeSet: Artifact | undefined): WorkerReportFile[] {
	const raw = changeSet?.meta?.changedFiles;
	if (!Array.isArray(raw)) return [];
	return raw
		.map((file) => {
			if (!file || typeof file !== "object") return undefined;
			const entry = file as { path?: unknown; additions?: unknown; deletions?: unknown };
			if (typeof entry.path !== "string" || !entry.path) return undefined;
			return {
				path: entry.path,
				...(typeof entry.additions === "number" ? { additions: entry.additions } : {}),
				...(typeof entry.deletions === "number" ? { deletions: entry.deletions } : {}),
			};
		})
		.filter((file): file is WorkerReportFile => file !== undefined);
}

function fallbackEditedFiles(artifacts: Artifact[]): WorkerReportFile[] {
	const edited = artifacts.filter((a) => a.kind === "file" && (a.meta?.tool === "edit" || a.meta?.tool === "write"));
	const seen = new Set<string>();
	const files: WorkerReportFile[] = [];
	for (const artifact of edited) {
		const path = typeof artifact.meta?.path === "string" ? artifact.meta.path : artifact.title;
		if (!path || seen.has(path)) continue;
		seen.add(path);
		files.push({ path });
	}
	return files;
}

function collectCommands(artifacts: Artifact[]): WorkerReportCommand[] {
	return artifacts
		.filter((a) => a.kind === "command")
		.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
		.map((artifact) => ({
			displayId: artifact.displayId,
			title: firstWorkerReviewLine(artifact.title) ?? artifact.displayId,
			status: commandStatus(artifact),
		}));
}

function collectRefs(label: string, artifacts: Artifact[], changeSet: Artifact | undefined, max: number, frozenRefs: ArtifactSummary[] = []): WorkerReportRef[] {
	const useful = workerAnswerArtifacts(artifacts).filter((a) => a.meta?.workerDeliverable !== true && (a.kind === "response" || a.kind === "code" || a.kind === "error" || a.kind === "file"));
	const order: Artifact["kind"][] = ["response", "code", "error", "file"];
	const grouped = order.flatMap((kind) => useful.filter((a) => a.kind === kind));
	const seen = new Set<string>();
	const refs: WorkerReportRef[] = [];
	if (changeSet?.ref) {
		seen.add(changeSet.ref);
		refs.push({
			displayId: `${label}.changes`,
			kind: changeSet.kind,
			label: firstWorkerReviewLine(changeSet.title) ?? "change set",
			ref: changeSet.ref,
		});
	}
	for (const artifact of frozenRefs) {
		if (seen.has(artifact.ref)) continue;
		seen.add(artifact.ref);
		refs.push({ displayId: `${label}.${artifact.displayId}`, kind: artifact.kind, label: firstWorkerReviewLine(artifact.title) ?? artifact.kind, ref: artifact.ref });
		if (refs.length >= max) return refs;
	}
	for (const artifact of grouped) {
		if (seen.has(artifact.ref)) continue;
		seen.add(artifact.ref);
		refs.push({
			displayId: `${label}.${artifact.displayId}`,
			kind: artifact.kind,
			label: firstWorkerReviewLine(artifact.title) ?? artifact.kind,
			ref: artifact.ref,
		});
		if (refs.length >= max) break;
	}
	return refs;
}

export function projectWorkerReport(
	worker: WorkerStatus,
	artifacts: Artifact[] = [],
	changeSet?: Artifact,
	deliverable?: WorkerDeliverable,
): WorkerReport {
	const resolvedDeliverable = deliverable ?? artifacts.map((artifact) => workerDeliverableFromArtifact(artifact)).find((item): item is WorkerDeliverable => item !== undefined);
	const resolvedChangeSet = changeSet ?? workerChangeSetArtifact(worker, resolvedDeliverable);
	const label = workerSourceLabel(worker);
	const state = deriveWorkerState(worker);
	const stateLabel = state === "ready_open_todos" ? "ready · progress" : state === "needs_input" ? "needs reply" : state.replace(/_/g, " ");
	const summary = resolvedDeliverable ? resolvedDeliverable.body : displayWorkerSummary(worker);
	const fromSummary = resolvedDeliverable ? firstWorkerReviewLine(resolvedDeliverable.summary) ?? firstWorkerReviewLine(resolvedDeliverable.body) : workerSummaryHeadline(worker) ?? firstWorkerReviewLine(summary);
	const headline = fromSummary ?? (state === "failed" ? worker.lastError : undefined) ?? worker.task;
	const recommendations = resolvedDeliverable?.recommendations ?? workerRecommendedItems(worker, Number.POSITIVE_INFINITY);
	const evidence = resolvedDeliverable?.evidence ?? (Array.isArray(worker.evidence) ? worker.evidence.map((item) => String(item).trim()).filter(Boolean) : []);

	const fromChangeSet = changeFilesFromArtifact(resolvedChangeSet);
	const changedFiles = fromChangeSet.length > 0 ? fromChangeSet : fallbackEditedFiles(artifacts);
	const additions = changedFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0);
	const deletions = changedFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
	const hunkCount = typeof resolvedChangeSet?.meta?.hunkCount === "number" ? resolvedChangeSet.meta.hunkCount : undefined;

	const allCommands = collectCommands(artifacts);
	const checks: WorkerReportCheckCounts = { ok: 0, failed: 0, unknown: 0, total: allCommands.length };
	for (const command of allCommands) {
		if (command.status === "ok") checks.ok++;
		else if (command.status === "failed") checks.failed++;
		else checks.unknown++;
	}
	const recentCommands = allCommands.slice(0, REPORT_COMMAND_CAP);
	const refs = collectRefs(label, artifacts, resolvedChangeSet, REPORT_REF_CAP, resolvedDeliverable?.refs);

	const questions = workerQuestions(worker);
	const primarySection: WorkerReport["primarySection"] =
		state === "needs_input" ? "question" : state === "failed" ? "failure" : "outcome";
	const primaryBody =
		primarySection === "question"
			? questions.map((q, i) => `${i + 1}. ${q.text}`).join("\n") || worker.question || headline
			: primarySection === "failure"
				? worker.lastError ?? headline
				: summary || headline;

	const kind = worker.kind?.trim() && worker.kind !== "default" ? worker.kind : undefined;

	return {
		label,
		task: worker.task,
		...(kind ? { kind } : {}),
		state,
		stateLabel,
		...(resolvedDeliverable?.outcome ?? worker.outcome ? { outcome: resolvedDeliverable?.outcome ?? worker.outcome } : {}),
		updatedAt: resolvedDeliverable?.createdAt ?? worker.updatedAt,
		...(worker.scopeConfidence ? { scopeConfidence: worker.scopeConfidence } : {}),
		progressLine: progressLine(worker),
		summary,
		summaryHeadline: headline,
		recommendations,
		evidence,
		changeTotals: {
			files: changedFiles.length,
			additions,
			deletions,
			...(hunkCount !== undefined ? { hunkCount } : {}),
		},
		changedFiles,
		...(resolvedChangeSet?.ref ? { changeSetRef: resolvedChangeSet.ref } : {}),
		checks,
		recentCommands,
		commandsOverflow: Math.max(0, allCommands.length - recentCommands.length),
		refs,
		primarySection,
		primaryBody,
		...(resolvedDeliverable ? { deliverableId: resolvedDeliverable.id, deliverableVersion: resolvedDeliverable.version, deliverableRef: resolvedDeliverable.ref } : {}),
		...(resolvedDeliverable?.sourceHandoff ? { sourceHandoff: resolvedDeliverable.sourceHandoff } : {}),
	};
}

export type VerdictEvidencePreview = {
	changeLine?: string;
	fileLines: string[];
	filesOverflow: number;
	checksLine?: string;
	evidenceLines: string[];
	evidenceOverflow: number;
	refsLine?: string;
};

export type VerdictWorkerSaysPreview = {
	headline: string;
	recommendations: string[];
	recommendationsOverflow: number;
};

/** Compact evidence + claims for the ready verdict card. */
export function verdictReadyPreview(report: WorkerReport): {
	evidence: VerdictEvidencePreview;
	workerSays: VerdictWorkerSaysPreview;
} {
	const files = report.changedFiles.slice(0, VERDICT_FILE_CAP);
	const evidence = report.evidence.slice(0, VERDICT_EVIDENCE_CAP);
	const recommendations = report.recommendations.slice(0, VERDICT_RECOMMENDATION_CAP);
	const changeLine =
		report.changeTotals.files > 0
			? `${report.changeTotals.files} file${report.changeTotals.files === 1 ? "" : "s"}   +${report.changeTotals.additions}/-${report.changeTotals.deletions}${
					report.changeTotals.hunkCount !== undefined ? `   ${report.changeTotals.hunkCount} hunk${report.changeTotals.hunkCount === 1 ? "" : "s"}` : ""
				}`
			: undefined;
	const checksLine =
		report.checks.total > 0
			? `checks ${report.checks.ok} ok · ${report.checks.failed} failed${report.checks.unknown ? ` · ${report.checks.unknown} unknown` : ""}`
			: undefined;
	const refsLine = report.refs.length > 0 ? `${report.refs.length} ref${report.refs.length === 1 ? "" : "s"}` : undefined;
	return {
		evidence: {
			...(changeLine ? { changeLine } : {}),
			fileLines: files.map((file) => {
				const stats =
					file.additions === undefined && file.deletions === undefined
						? ""
						: `   +${file.additions ?? 0}/-${file.deletions ?? 0}`;
				return `${file.path}${stats}`;
			}),
			filesOverflow: Math.max(0, report.changedFiles.length - files.length),
			...(checksLine ? { checksLine } : {}),
			evidenceLines: evidence,
			evidenceOverflow: Math.max(0, report.evidence.length - evidence.length),
			...(refsLine ? { refsLine } : {}),
		},
		workerSays: {
			headline: truncateWorkerReviewText(report.summaryHeadline, 120),
			recommendations,
			recommendationsOverflow: Math.max(0, report.recommendations.length - recommendations.length),
		},
	};
}

/** Full Report body: structured completion data and evidence metadata, zero model context. */
export function formatWorkerReportText(report: WorkerReport): string {
	const lines: string[] = [];
	lines.push(`Task: ${report.task}`);
	if (report.deliverableRef) lines.push(`Deliverable: ${report.deliverableRef} (v${report.deliverableVersion})`);
	if (report.kind) lines.push(`Kind: ${report.kind}`);
	lines.push(`State: ${report.stateLabel}${report.outcome ? ` · ${report.outcome}` : ""}`);
	lines.push(`Updated: ${report.updatedAt}`);
	if (report.scopeConfidence) lines.push(`Scope confidence: ${report.scopeConfidence}`);
	lines.push(`Progress: ${report.progressLine}`);
	if (report.sourceHandoff) lines.push(`Handoff source: ${report.sourceHandoff.sourceRef} from ${report.sourceHandoff.sourceWorkerLabel} · approved ${report.sourceHandoff.approvedAt} (${report.sourceHandoff.approvingDecisionId})`);
	lines.push("");
	lines.push("Evidence");
	if (report.changeTotals.files > 0) {
		lines.push(
			`Changes: ${report.changeTotals.files} file${report.changeTotals.files === 1 ? "" : "s"} · +${report.changeTotals.additions}/-${report.changeTotals.deletions}${
				report.changeTotals.hunkCount !== undefined ? ` · ${report.changeTotals.hunkCount} hunk${report.changeTotals.hunkCount === 1 ? "" : "s"}` : ""
			}`,
		);
		for (const file of report.changedFiles) {
			const stats =
				file.additions === undefined && file.deletions === undefined
					? ""
					: `  +${file.additions ?? 0}/-${file.deletions ?? 0}`;
			lines.push(`  ${file.path}${stats}`);
		}
	} else {
		lines.push("Changes: none");
	}
	if (report.checks.total > 0) {
		lines.push(
			`Checks: ${report.checks.ok} ok · ${report.checks.failed} failed${report.checks.unknown ? ` · ${report.checks.unknown} unknown` : ""} (${report.checks.total} total)`,
		);
	} else {
		lines.push("Checks: none");
	}
	if (report.evidence.length > 0) {
		lines.push("Reported evidence:");
		for (const item of report.evidence) lines.push(`  - ${item}`);
	} else {
		lines.push("Reported evidence: none");
	}
	if (report.recentCommands.length > 0) {
		lines.push(`Commands (latest ${report.recentCommands.length}${report.commandsOverflow ? ` · +${report.commandsOverflow} more` : ""}):`);
		for (const command of report.recentCommands) {
			lines.push(`  [${command.status}] ${command.title}`);
		}
	}
	if (report.refs.length > 0) {
		lines.push("Refs:");
		for (const ref of report.refs) lines.push(`  @${ref.displayId} /${ref.kind}  ${ref.label}`);
	}
	lines.push("");
	lines.push(report.deliverableRef ? "Deliverable" : "Worker says");
	lines.push(report.summary || report.summaryHeadline || "(no summary)");
	if (report.recommendations.length > 0) {
		lines.push("");
		lines.push("Recommendations (worker claims):");
		for (const item of report.recommendations) lines.push(`  - ${item}`);
	}
	return lines.join("\n");
}

/** Informational progress detail shared with the expanded result widget. */
export function workerReportProgressDetail(worker: WorkerStatus): string | undefined {
	const board = workerTodoBoardLines(worker, { includeHeader: true, maxItems: 8 });
	return board.length ? board.join("\n") : undefined;
}

export function workerReportTodoProgress(worker: WorkerStatus): { completed: number; total: number } {
	return workerTodoProgress(worker);
}
