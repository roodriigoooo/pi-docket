import { workerActivityChip, workerTodoBoardLines, type WorkerDerivedState, type WorkerStatus } from "./background-work.js";
import type { Artifact } from "./types.js";
import { extractWorkerRecommendations, fallbackWorkerSentences, firstWorkerReviewLine, isWorkerStatusArtifact, projectWorkerReview, truncateWorkerReviewText, workerAnswerArtifacts } from "./worker-review.js";

export { isWorkerStatusArtifact } from "./worker-review.js";

export function workerResultSummary(worker: WorkerStatus, artifacts: Artifact[] = []): string {
	return projectWorkerReview(worker, artifacts).summary;
}

export function workerResultHeadline(worker: WorkerStatus, artifacts: Artifact[] = [], max = 72): string {
	return truncateWorkerReviewText(workerResultSummary(worker, artifacts).replace(/\s+/g, " "), max);
}

export function workerResultArtifact(worker: WorkerStatus, artifacts: Artifact[] = []): Artifact | undefined {
	return projectWorkerReview(worker, artifacts).result;
}

export function workerResultText(worker: WorkerStatus, artifacts: Artifact[] = [], maxBodyLines = 8): string {
	const review = projectWorkerReview(worker, artifacts);
	const result = review.result;
	const body = !review.resultIsStatus ? result?.body?.split(/\r?\n/).slice(0, maxBodyLines).join("\n") : undefined;
	const questions = review.questions.map((item, index) => `${index + 1}. ${item.text}`).join("\n");
	const todos = workerTodoBoardLines(worker, { includeHeader: true, maxItems: 8 });
	return [
		`${workerActivityChip(worker, { verbose: true })} ${review.summary}`,
		body && body !== review.summary ? `answer:\n${body}` : undefined,
		questions ? `needs input:\n${questions}` : undefined,
		todos.length ? `progress:\n${todos.join("\n")}` : undefined,
		`actions: /docket load ${review.label} · /docket tell ${review.label}`,
		result && !review.resultIsStatus ? `ref: @${result.displayId}` : undefined,
	].filter((line): line is string => line !== undefined).join("\n");
}

export type WorkerResultReportSection = "outcome" | "question" | "failure";

export type WorkerResultReference = {
	displayId: string;
	kind: Artifact["kind"];
	label: string;
};

export type WorkerResultReport = {
	label: string;
	state: WorkerDerivedState;
	stateLabel: string;
	taskLabel: string;
	progressLine: string;
	changesLine: string;
	primarySection: WorkerResultReportSection;
	primaryBody: string;
	recommendations: string[];
	references: WorkerResultReference[];
	nextActions: Array<{ key: string; label: string }>;
	resultRef?: string;
};

function workerProgressLine(worker: WorkerStatus): string {
	const todos = worker.todos ?? [];
	if (todos.length === 0) return "no progress";
	const completed = todos.filter((t) => t.state === "completed").length;
	const open = todos.length - completed;
	if (open === 0) return `${completed}/${todos.length} progress complete`;
	return `${completed}/${todos.length} progress · ${open} open`;
}

function workerChangesLine(artifacts: Artifact[]): string {
	const changeSet = artifacts.find((a) => a.meta?.workerChangeSet === true);
	const changedFiles = Array.isArray(changeSet?.meta?.changedFiles) ? changeSet.meta.changedFiles : undefined;
	if (changedFiles?.length) return `${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}`;
	const edited = artifacts.filter((a) => a.kind === "file" && (a.meta?.tool === "edit" || a.meta?.tool === "write"));
	if (edited.length === 0) return "none";
	if (edited.length === 1) return `1 file (${edited[0]!.title})`;
	return `${edited.length} files`;
}

function workerReferences(label: string, artifacts: Artifact[], max = 4): WorkerResultReference[] {
	const candidates = workerAnswerArtifacts(artifacts);
	const order: Artifact["kind"][] = ["response", "code", "file", "command", "error"];
	const grouped = order.flatMap((kind) => candidates.filter((a) => a.kind === kind));
	const seen = new Set<string>();
	const refs: WorkerResultReference[] = [];
	for (const artifact of grouped) {
		const id = `${label}.${artifact.displayId}`;
		if (seen.has(id)) continue;
		seen.add(id);
		refs.push({ displayId: id, kind: artifact.kind, label: firstWorkerReviewLine(artifact.title) ?? artifact.kind });
		if (refs.length >= max) break;
	}
	return refs;
}

export function workerResultReport(worker: WorkerStatus, artifacts: Artifact[] = []): WorkerResultReport {
	const review = projectWorkerReview(worker, artifacts);
	const recommendations = review.recommendations.length > 0 ? [...review.recommendations] : extractWorkerRecommendations(review.summarySource);
	if (recommendations.length === 0 && review.state !== "needs_input" && review.state !== "failed") {
		recommendations.push(...fallbackWorkerSentences(review.summarySource, 2).filter((s) => s !== review.summary));
	}
	const primarySection: WorkerResultReportSection = review.state === "needs_input" ? "question" : review.state === "failed" ? "failure" : "outcome";
	const primaryBody = primarySection === "question"
		? review.questions.map((q, i) => `${i + 1}. ${q.text}`).join("\n") || review.summary
		: primarySection === "failure"
			? worker.lastError ?? review.summary
			: review.summary;
	const stateLabel = review.state === "ready_open_todos" ? "ready · progress" : review.state === "needs_input" ? "needs reply" : review.state;
	const nextActions: Array<{ key: string; label: string }> = [];
	if (review.state === "needs_input") nextActions.push({ key: "c", label: "Reply" });
	else if (review.state === "failed") nextActions.push({ key: "Enter", label: "Inspect failure" });
	else nextActions.push({ key: "Enter", label: "Review answer" });
	nextActions.push({ key: "c", label: review.state === "needs_input" ? "Send answer" : "Ask follow-up" });
	nextActions.push({ key: "l", label: "Load into prompt" });
	nextActions.push({ key: "a", label: "Attach tmux" });
	nextActions.push({ key: "x", label: "Dismiss" });
	const uniqueActions = nextActions.filter((entry, index, arr) => arr.findIndex((other) => other.key === entry.key && other.label === entry.label) === index);
	return {
		label: review.label,
		state: review.state,
		stateLabel,
		taskLabel: worker.task,
		progressLine: workerProgressLine(worker),
		changesLine: workerChangesLine(artifacts),
		primarySection,
		primaryBody,
		recommendations,
		references: workerReferences(review.label, artifacts),
		nextActions: uniqueActions,
		...(review.result && !review.resultIsStatus ? { resultRef: `@${review.label}.${review.result.displayId}` } : {}),
	};
}
