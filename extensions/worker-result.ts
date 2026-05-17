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

export function workerResultSummary(worker: WorkerStatus, artifacts: Artifact[] = []): string {
	const state = deriveWorkerState(worker);
	const question = workerQuestions(worker).map((item, index) => `${index + 1}. ${item.text}`).join(" ");
	const answer = latestArtifact(artifacts, ["response", "code"]);
	const failure = latestArtifact(artifacts, ["error"]);
	return firstLine(
		state === "needs_input" ? question :
		state === "failed" ? worker.lastError ?? failure?.title ?? failure?.body :
		worker.summary ?? workerTodoSummary(worker) ?? answer?.title ?? answer?.body ?? workerDisplayName(worker),
	) ?? workerDisplayName(worker);
}

export function workerResultHeadline(worker: WorkerStatus, artifacts: Artifact[] = [], max = 72): string {
	return truncate(workerResultSummary(worker, artifacts).replace(/\s+/g, " "), max);
}

export function workerResultArtifact(worker: WorkerStatus, artifacts: Artifact[] = []): Artifact | undefined {
	const label = workerSourceLabel(worker);
	return artifacts.find((artifact) => artifact.meta?.workerId === worker.id && artifact.meta?.workerStatus)
		?? artifacts.find((artifact) => artifact.displayId === `${label}.status` || artifact.id === `${label}.status` || artifact.id === "status")
		?? latestArtifact(artifacts, ["response", "code", "error"])
		?? workerStatusArtifact(worker);
}

export function workerResultText(worker: WorkerStatus, artifacts: Artifact[] = [], maxBodyLines = 8): string {
	const result = workerResultArtifact(worker, artifacts);
	const summary = workerResultSummary(worker, artifacts);
	const body = result?.body?.split(/\r?\n/).slice(0, maxBodyLines).join("\n");
	const todos = workerTodoBoardLines(worker, { includeHeader: true, maxItems: 8 });
	return [
		`${workerActivityChip(worker, { verbose: true })}`,
		`task: ${worker.task}`,
		`summary: ${summary}`,
		todos.length ? `progress:\n${todos.join("\n")}` : undefined,
		result ? `ref: @${result.displayId}` : undefined,
		body && body !== summary ? "" : undefined,
		body && body !== summary ? body : undefined,
	].filter((line): line is string => line !== undefined).join("\n");
}
