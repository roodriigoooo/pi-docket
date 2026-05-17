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
		`actions: /trail use ${label} · /trail ask ${label}`,
		result && !resultIsStatus ? `ref: @${result.displayId}` : undefined,
	].filter((line): line is string => line !== undefined).join("\n");
}
