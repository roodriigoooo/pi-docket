import { workerActivityChip, workerTodoBoardLines, type WorkerDerivedState, type WorkerStatus } from "./background-work.js";
import type { Artifact } from "./types.js";
import { projectWorkerReport, type WorkerReport } from "./worker-report.js";
import { projectWorkerReview, truncateWorkerReviewText } from "./worker-review.js";

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

function changesLineFromReport(report: WorkerReport): string {
	if (report.changeTotals.files === 0) return "none";
	if (report.changeTotals.files === 1) {
		const path = report.changedFiles[0]?.path;
		return path ? `1 file (${path})` : "1 file";
	}
	return `${report.changeTotals.files} files`;
}

export function workerResultReport(worker: WorkerStatus, artifacts: Artifact[] = []): WorkerResultReport {
	const report = projectWorkerReport(worker, artifacts);
	const review = projectWorkerReview(worker, artifacts);
	const nextActions: Array<{ key: string; label: string }> = [];
	if (report.state === "needs_input") nextActions.push({ key: "c", label: "Reply" });
	else if (report.state === "failed") nextActions.push({ key: "Enter", label: "Inspect failure" });
	else nextActions.push({ key: "Enter", label: "Review answer" });
	nextActions.push({ key: "c", label: report.state === "needs_input" ? "Send answer" : "Ask follow-up" });
	nextActions.push({ key: "l", label: "Load into prompt" });
	nextActions.push({ key: "x", label: "Dismiss" });
	const uniqueActions = nextActions.filter((entry, index, arr) => arr.findIndex((other) => other.key === entry.key && other.label === entry.label) === index);
	return {
		label: report.label,
		state: report.state,
		stateLabel: report.stateLabel,
		taskLabel: report.task,
		progressLine: report.progressLine,
		changesLine: changesLineFromReport(report),
		primarySection: report.primarySection,
		primaryBody: report.primaryBody,
		recommendations: report.recommendations,
		references: report.refs
			.filter((ref) => !ref.displayId.endsWith(".changes"))
			.map((ref) => ({ displayId: ref.displayId, kind: ref.kind, label: ref.label })),
		nextActions: uniqueActions,
		...(review.result && !review.resultIsStatus ? { resultRef: `@${review.label}.${review.result.displayId}` } : {}),
	};
}
