import { deriveWorkerState, workerDisplayName, workerQuestions, workerSourceLabel, workerStatusArtifact, workerTodoSummary, type WorkerDerivedState, type WorkerQuestion, type WorkerStatus } from "./background-work.js";
import type { Artifact } from "./types.js";
import { workerDeliverableArtifact, workerDeliverableFromArtifact, type WorkerDeliverable } from "./worker-deliverable.js";

const BULLET_PREFIX = /^\s*(?:[-*•]|\d+[.)])\s+/;
const RECOMMENDATION_HEADING = /^(recommended|recommendations?|suggested|suggestions?):?$/i;

export type WorkerReviewProjection = {
	worker: WorkerStatus;
	label: string;
	state: WorkerDerivedState;
	questions: WorkerQuestion[];
	deliverable?: WorkerDeliverable;
	result?: Artifact;
	resultIsStatus: boolean;
	summary: string;
	summarySource?: string;
	recommendations: string[];
};

export type WorkerArtifactReviewProjection = {
	status?: WorkerDerivedState;
	label?: string;
	summary?: string;
	recommendations: string[];
};

export function firstWorkerReviewLine(text: string | undefined): string | undefined {
	const line = text?.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
	return line || undefined;
}

export function truncateWorkerReviewText(text: string, max: number): string {
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

export function workerAnswerArtifacts(artifacts: Artifact[]): Artifact[] {
	return artifacts.filter((artifact) => !isWorkerStatusArtifact(artifact));
}

export function extractWorkerRecommendations(text: string | undefined, max = 6): string[] {
	if (!text) return [];
	const out: string[] = [];
	let inSection = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) { if (inSection) break; continue; }
		if (RECOMMENDATION_HEADING.test(line)) { inSection = true; continue; }
		const match = line.match(BULLET_PREFIX);
		if (match) out.push(line.slice(match[0].length).trim());
		else if (inSection) out.push(line);
	}
	return out.filter(Boolean).slice(0, max);
}

export function countWorkerRecommendations(text: string | undefined): number {
	const bullets = extractWorkerRecommendations(text, Number.POSITIVE_INFINITY);
	if (bullets.length > 0) return bullets.length;
	const numbered = text?.match(/\b(\d+)\s+(?:suggestions?|recommendations?|recs?)\b/i);
	return numbered ? Number(numbered[1]) : 0;
}

export function workerRecommendedItems(worker: WorkerStatus, max = 6): string[] {
	const fromField = Array.isArray(worker.recommended)
		? worker.recommended.map((r) => String(r).trim()).filter(Boolean)
		: [];
	if (fromField.length > 0) return fromField.slice(0, max);
	return extractWorkerRecommendations(worker.summary, max);
}

export function fallbackWorkerSentences(text: string | undefined, max = 3): string[] {
	if (!text) return [];
	return text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean).slice(0, max);
}

export function workerSummaryHeadline(worker: WorkerStatus): string | undefined {
	const summary = worker.summary;
	if (typeof summary !== "string") return undefined;
	const recommendedIdx = summary.search(/\brecommend(ed|ations?):?/i);
	const prelude = recommendedIdx >= 0 ? summary.slice(0, recommendedIdx) : summary;
	return firstWorkerReviewLine(prelude) ?? firstWorkerReviewLine(summary);
}

export function workerResultArtifactFromReview(worker: WorkerStatus, artifacts: Artifact[] = [], deliverable?: WorkerDeliverable): Artifact | undefined {
	if (deliverable) return artifacts.find((artifact) => artifact.ref === deliverable.ref) ?? workerDeliverableArtifact(deliverable);
	const label = workerSourceLabel(worker);
	const answer = latestArtifact(workerAnswerArtifacts(artifacts), ["response", "code", "error"]);
	const status = artifacts.find((artifact) => artifact.meta?.workerId === worker.id && artifact.meta?.workerStatus)
		?? artifacts.find((artifact) => artifact.displayId === `${label}.status` || artifact.id === `${label}.status` || artifact.id === "status")
		?? workerStatusArtifact(worker);
	return answer ?? status;
}

export function projectWorkerReview(worker: WorkerStatus, artifacts?: Artifact[], now?: number, deliverable?: WorkerDeliverable): WorkerReviewProjection;
export function projectWorkerReview(worker: WorkerStatus, deliverable: WorkerDeliverable, artifacts?: Artifact[], now?: number): WorkerReviewProjection;
export function projectWorkerReview(
	worker: WorkerStatus,
	artifactsOrDeliverable: Artifact[] | WorkerDeliverable = [],
	nowOrArtifacts: number | Artifact[] = Date.now(),
	deliverableOrNow?: WorkerDeliverable | number,
): WorkerReviewProjection {
	const explicitDeliverable = Array.isArray(artifactsOrDeliverable)
		? (typeof deliverableOrNow === "object" ? deliverableOrNow : undefined)
		: artifactsOrDeliverable;
	const artifacts = Array.isArray(artifactsOrDeliverable)
		? artifactsOrDeliverable
		: Array.isArray(nowOrArtifacts) ? nowOrArtifacts : [];
	const now = Array.isArray(artifactsOrDeliverable)
		? typeof nowOrArtifacts === "number" ? nowOrArtifacts : Date.now()
		: typeof deliverableOrNow === "number" ? deliverableOrNow : Date.now();
	const deliverable = explicitDeliverable ?? artifacts.map((artifact) => workerDeliverableFromArtifact(artifact)).find((item): item is WorkerDeliverable => item !== undefined);
	const label = workerSourceLabel(worker);
	const state = deriveWorkerState(worker, now);
	const questions = workerQuestions(worker);
	const questionText = questions.map((item, index) => `${index + 1}. ${item.text}`).join(" ");
	const answer = latestArtifact(workerAnswerArtifacts(artifacts), ["response", "code"]);
	const failure = latestArtifact(workerAnswerArtifacts(artifacts), ["error"]);
	const result = workerResultArtifactFromReview(worker, artifacts, deliverable);
	const resultIsStatus = isWorkerStatusArtifact(result);
	const summary = firstWorkerReviewLine(
		state === "needs_input" ? questionText :
		state === "failed" ? worker.lastError ?? failure?.title ?? failure?.body :
		deliverable?.summary ?? worker.summary ?? answer?.title ?? answer?.body ?? workerTodoSummary(worker) ?? workerDisplayName(worker),
	) ?? workerDisplayName(worker);
	const summaryParts: string[] = [];
	if (deliverable) summaryParts.push(deliverable.body);
	else {
		if (typeof worker.summary === "string" && worker.summary.length > 0) summaryParts.push(worker.summary);
		if (result && !resultIsStatus) summaryParts.push(`${result.title}\n${result.body}`);
	}
	const summarySource = summaryParts.length ? summaryParts.join("\n") : undefined;
	return {
		worker,
		label,
		state,
		questions,
		...(deliverable ? { deliverable } : {}),
		...(result ? { result } : {}),
		resultIsStatus,
		summary,
		...(summarySource ? { summarySource } : {}),
		recommendations: deliverable?.recommendations ?? workerRecommendedItems(worker),
	};
}

function artifactMeta(artifact: Artifact): Record<string, unknown> {
	return artifact.meta ?? {};
}

function metaString(artifact: Artifact, key: string): string | undefined {
	const value = artifactMeta(artifact)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function artifactWorkerStatus(artifact: Artifact): WorkerDerivedState | undefined {
	const status = artifactMeta(artifact).workerStatus;
	if (status === "needs_input" || status === "ready" || status === "ready_open_todos" || status === "failed" || status === "stale" || status === "starting" || status === "thinking" || status === "empty" || status === "idle" || status === "reviewed") return status;
	if (artifactMeta(artifact).workerDeliverable === true) return "ready";
	return undefined;
}

export function artifactWorkerRef(artifact: Artifact): string | undefined {
	const label = artifactMeta(artifact).workerLabel;
	if (typeof label === "string" && label.length > 0) return label;
	return artifact.source;
}

export function stripWorkerStatePrefix(text: string, label: string | undefined): string {
	if (!label) return text;
	const patterns = [
		new RegExp(`^${label}\s+ready(?:[\/\s][^:]*)?:\s*`, "i"),
		new RegExp(`^${label}\s+failed(?:[^:]*)?:\s*`, "i"),
		new RegExp(`^${label}\s+needs input(?:[^:]*)?:\s*`, "i"),
	];
	for (const pattern of patterns) {
		const next = text.replace(pattern, "");
		if (next !== text) return next.trim();
	}
	return text;
}

function bodyMessageSection(body: string | undefined): string | undefined {
	if (!body) return undefined;
	const idx = body.indexOf("\nmessage:\n");
	if (idx === -1) return undefined;
	return body.slice(idx + "\nmessage:\n".length).trim() || undefined;
}

export function workerArtifactSummaryText(artifact: Artifact): string | undefined {
	if (artifactMeta(artifact).workerDeliverable === true) return metaString(artifact, "summary") ?? firstWorkerReviewLine(artifact.body);
	const status = artifactWorkerStatus(artifact);
	if (status === "needs_input") return metaString(artifact, "question") ?? bodyMessageSection(artifact.body);
	if (status === "ready" || status === "ready_open_todos") return metaString(artifact, "summary") ?? bodyMessageSection(artifact.body);
	if (status === "failed") return metaString(artifact, "lastError") ?? bodyMessageSection(artifact.body);
	if (artifact.source) return bodyMessageSection(artifact.body) ?? stripWorkerStatePrefix(artifact.title, artifactWorkerRef(artifact));
	return undefined;
}

export function projectWorkerArtifactReview(artifact: Artifact): WorkerArtifactReviewProjection {
	const summary = workerArtifactSummaryText(artifact);
	return {
		...(artifactWorkerStatus(artifact) ? { status: artifactWorkerStatus(artifact) } : {}),
		...(artifactWorkerRef(artifact) ? { label: artifactWorkerRef(artifact) } : {}),
		...(summary ? { summary } : {}),
		recommendations: extractWorkerRecommendations(summary, 4),
	};
}
