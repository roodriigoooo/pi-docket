import { deriveWorkerState, workerActivityChip, workerDisplayName, workerQuestions, workerSourceLabel, workerStatusArtifact, workerTodoBoardLines, workerTodoSummary, type WorkerStatus } from "./background-work.js";
import type { Artifact } from "./types.js";

function firstLine(text: string | undefined): string | undefined {
	const line = text?.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
	return line || undefined;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function latestArtifact(artifacts: Artifact[], kinds: Artifact["kind"][]): Artifact | undefined {
	return artifacts
		.filter((artifact) => kinds.includes(artifact.kind))
		.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
}

export function isWorkerStatusArtifact(artifact: Artifact | undefined): boolean {
	if (!artifact) return false;
	return artifact.meta?.workerStatus !== undefined || artifact.ref.startsWith("worker-status:") || artifact.displayId === "status" || artifact.id === "status";
}

function workerAnswerArtifacts(artifacts: Artifact[]): Artifact[] {
	return artifacts.filter((artifact) => !isWorkerStatusArtifact(artifact));
}

export function workerResultSummary(worker: WorkerStatus, artifacts: Artifact[] = []): string {
	const state = deriveWorkerState(worker);
	const question = workerQuestions(worker).map((item, index) => `${index + 1}. ${item.text}`).join(" ");
	const answer = latestArtifact(workerAnswerArtifacts(artifacts), ["response", "code"]);
	const failure = latestArtifact(workerAnswerArtifacts(artifacts), ["error"]);
	return firstLine(
		state === "needs_input" ? question :
		state === "failed" ? worker.lastError ?? failure?.title ?? failure?.body :
		worker.summary ?? answer?.title ?? answer?.body ?? workerTodoSummary(worker) ?? workerDisplayName(worker),
	) ?? workerDisplayName(worker);
}

export function workerResultHeadline(worker: WorkerStatus, artifacts: Artifact[] = [], max = 72): string {
	return truncate(workerResultSummary(worker, artifacts).replace(/\s+/g, " "), max);
}

export function workerResultArtifact(worker: WorkerStatus, artifacts: Artifact[] = []): Artifact | undefined {
	const label = workerSourceLabel(worker);
	const answer = latestArtifact(workerAnswerArtifacts(artifacts), ["response", "code", "error"]);
	const status = artifacts.find((artifact) => artifact.meta?.workerId === worker.id && artifact.meta?.workerStatus)
		?? artifacts.find((artifact) => artifact.displayId === `${label}.status` || artifact.id === `${label}.status` || artifact.id === "status")
		?? workerStatusArtifact(worker);
	return answer ?? status;
}

export function workerResultText(worker: WorkerStatus, artifacts: Artifact[] = [], maxBodyLines = 8): string {
	const label = workerSourceLabel(worker);
	const result = workerResultArtifact(worker, artifacts);
	const resultIsStatus = isWorkerStatusArtifact(result);
	const summary = workerResultSummary(worker, artifacts);
	const body = !resultIsStatus ? result?.body?.split(/\r?\n/).slice(0, maxBodyLines).join("\n") : undefined;
	const questions = workerQuestions(worker).map((item, index) => `${index + 1}. ${item.text}`).join("\n");
	const todos = workerTodoBoardLines(worker, { includeHeader: true, maxItems: 8 });
	return [
		`${workerActivityChip(worker, { verbose: true })} ${summary}`,
		body && body !== summary ? `answer:\n${body}` : undefined,
		questions ? `needs input:\n${questions}` : undefined,
		todos.length ? `progress:\n${todos.join("\n")}` : undefined,
		`actions: /docket use ${label} · /docket ask ${label}`,
		result && !resultIsStatus ? `ref: @${result.displayId}` : undefined,
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
	state: ReturnType<typeof deriveWorkerState>;
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

const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;

function extractBullets(text: string | undefined, max = 6): string[] {
	if (!text) return [];
	const out: string[] = [];
	let inSection = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) { if (inSection) break; continue; }
		if (/^(recommended|recommendations?|suggested|suggestions?):?$/i.test(line)) { inSection = true; continue; }
		const match = line.match(BULLET_RE);
		if (match) out.push(line.slice(match[0].length).trim());
		else if (inSection) out.push(line);
	}
	return out.slice(0, max);
}

function fallbackSentences(text: string | undefined, max = 3): string[] {
	if (!text) return [];
	return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).slice(0, max);
}

function workerProgressLine(worker: WorkerStatus): string {
	const todos = worker.todos ?? [];
	if (todos.length === 0) return "no todos";
	const completed = todos.filter((t) => t.state === "completed").length;
	const open = todos.length - completed;
	if (open === 0) return `${completed}/${todos.length} todos complete`;
	return `${completed}/${todos.length} todos · ${open} open`;
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
	const candidates = artifacts.filter((a) => !isWorkerStatusArtifact(a));
	const order: Artifact["kind"][] = ["response", "code", "file", "command", "error"];
	const grouped = order.flatMap((kind) => candidates.filter((a) => a.kind === kind));
	const seen = new Set<string>();
	const refs: WorkerResultReference[] = [];
	for (const artifact of grouped) {
		const id = `${label}.${artifact.displayId}`;
		if (seen.has(id)) continue;
		seen.add(id);
		refs.push({ displayId: id, kind: artifact.kind, label: firstLine(artifact.title) ?? artifact.kind });
		if (refs.length >= max) break;
	}
	return refs;
}

export function workerResultReport(worker: WorkerStatus, artifacts: Artifact[] = []): WorkerResultReport {
	const label = workerSourceLabel(worker);
	const state = deriveWorkerState(worker);
	const result = workerResultArtifact(worker, artifacts);
	const resultIsStatus = isWorkerStatusArtifact(result);
	const summary = workerResultSummary(worker, artifacts);
	const summarySource = worker.summary ?? (result && !resultIsStatus ? `${result.title}\n${result.body}` : undefined);
	const recommendations = extractBullets(summarySource);
	if (recommendations.length === 0 && state !== "needs_input" && state !== "failed") {
		recommendations.push(...fallbackSentences(summarySource, 2).filter((s) => s !== summary));
	}
	const questions = workerQuestions(worker);
	const primarySection: WorkerResultReportSection = state === "needs_input" ? "question" : state === "failed" ? "failure" : "outcome";
	const primaryBody = primarySection === "question"
		? questions.map((q, i) => `${i + 1}. ${q.text}`).join("\n") || summary
		: primarySection === "failure"
			? worker.lastError ?? summary
			: summary;
	const stateLabel = state === "ready_open_todos" ? "ready · open todos" : state === "needs_input" ? "needs reply" : state;
	const nextActions: Array<{ key: string; label: string }> = [];
	if (state === "needs_input") nextActions.push({ key: "c", label: "Reply" });
	else if (state === "failed") nextActions.push({ key: "Enter", label: "Inspect failure" });
	else nextActions.push({ key: "Enter", label: "Review answer" });
	nextActions.push({ key: "c", label: state === "needs_input" ? "Send answer" : "Ask follow-up" });
	nextActions.push({ key: "l", label: "Load into prompt" });
	nextActions.push({ key: "a", label: "Attach tmux" });
	nextActions.push({ key: "x", label: "Dismiss" });
	const uniqueActions = nextActions.filter((entry, index, arr) => arr.findIndex((other) => other.key === entry.key && other.label === entry.label) === index);
	return {
		label,
		state,
		stateLabel,
		taskLabel: worker.task,
		progressLine: workerProgressLine(worker),
		changesLine: workerChangesLine(artifacts),
		primarySection,
		primaryBody,
		recommendations,
		references: workerReferences(label, artifacts),
		nextActions: uniqueActions,
		...(result && !resultIsStatus ? { resultRef: `@${label}.${result.displayId}` } : {}),
	};
}
