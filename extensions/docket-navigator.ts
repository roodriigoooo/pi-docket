import type { Artifact, ArtifactKind } from "./types.js";
import type { WorkerDerivedState } from "./background-work.js";
import { artifactWorkerRef, artifactWorkerStatus, fallbackWorkerSentences, firstWorkerReviewLine, projectWorkerArtifactReview, stripWorkerStatePrefix } from "./worker-review.js";

export type NavigatorFilter = ArtifactKind | "all";
export type NavigatorMode = "review" | "answers" | "log";
export type NavigatorSource =
	| { kind: "current" }
	| { kind: "all" }
	| { kind: "artifactSource"; source: string };
export type ReviewBucket = "needs" | "pinned" | "recent";
export type ReviewActionId =
	| "inspect"
	| "openFile"
	| "promoteWorker"
	| "tellWorker"
	| "openVerdict"
	| "attachReference"
	| "injectFull"
	| "copyArtifact"
	| "save"
	| "useDeliverable"
	| "pin"
	| "markDone";
export type ReviewReasonId =
	| "pinned"
	| "done"
	| "workerNeedsInput"
	| "workerFailed"
	| "workerReady"
	| "workerChangeSet"
	| "error"
	| "changedFile"
	| "createdFile"
	| "failedCommand"
	| "workerAnswer"
	| "workerOutput"
	| "assistantAnswer"
	| "checkpointAvailable";

export type ReviewCategory =
	| "needs-decision"
	| "ready-for-review"
	| "failed-blocked"
	| "patch-proposed"
	| "checkpoint-available"
	| "pinned"
	| "recent";

export type ReviewQueueState = {
	pinnedRefs: ReadonlySet<string>;
	doneRefs: ReadonlySet<string>;
};

export type ReviewItem = {
	artifact: Artifact;
	bucket?: ReviewBucket;
	reasonId?: ReviewReasonId;
	primaryAction: ReviewActionId;
	actions: ReviewActionId[];
	headline: string;
	recommendations: string[];
	statusChip?: string;
	provenance: string;
	category?: ReviewCategory;
};

export type NavigatorState = {
	selected: number;
	filter: NavigatorFilter;
	source: NavigatorSource;
	mode: NavigatorMode;
	showDetail: boolean;
};

export type NavigatorIntent =
	| { kind: "move"; by: number }
	| { kind: "top" }
	| { kind: "bottom" }
	| { kind: "setMode"; mode: NavigatorMode }
	| { kind: "cycleMode" }
	| { kind: "cycleFilter" }
	| { kind: "cycleSource" }
	| { kind: "toggleDetail" }
	| { kind: "activatePrimary" }
	| { kind: "runAction"; action: ReviewActionId }
	| { kind: "save" }
	| { kind: "search" }
	| { kind: "close" };

export type NavigatorAction =
	| { action: "runReviewAction"; id: ReviewActionId; item: ReviewItem }
	| { action: "save" }
	| { action: "search" }
	| { action: "close" };

export type NavigatorTransition = {
	state: NavigatorState;
	action?: NavigatorAction;
};

export type NavigatorViewModel = {
	items: ReviewItem[];
	selected: number;
	selectedItem?: ReviewItem;
	visible: ReviewItem[];
	visibleStart: number;
};

const FILTERS: NavigatorFilter[] = ["all", "error", "command", "file", "code", "prompt", "response", "checkpoint"];
const BUCKET_RANK: Record<ReviewBucket, number> = { needs: 0, pinned: 1, recent: 2 };
const EMPTY_REFS: ReadonlySet<string> = new Set<string>();
const EMPTY_QUEUE: ReviewQueueState = { pinnedRefs: EMPTY_REFS, doneRefs: EMPTY_REFS };

export function currentNavigatorSource(): NavigatorSource {
	return { kind: "current" };
}

export function allNavigatorSource(): NavigatorSource {
	return { kind: "all" };
}

export function artifactNavigatorSource(source: string): NavigatorSource {
	return { kind: "artifactSource", source };
}

export function navigatorSourceLabel(source: NavigatorSource): string {
	if (source.kind === "artifactSource") return source.source;
	return source.kind;
}

export function sameNavigatorSource(a: NavigatorSource, b: NavigatorSource): boolean {
	if (a.kind !== b.kind) return false;
	return a.kind !== "artifactSource" || a.source === (b as Extract<NavigatorSource, { kind: "artifactSource" }>).source;
}

export function initialNavigatorState(): NavigatorState {
	return { selected: 0, filter: "all", source: currentNavigatorSource(), mode: "review", showDetail: false };
}

export function availableSources(artifacts: Artifact[]): NavigatorSource[] {
	const slots = new Set<string>();
	let hasCurrent = false;
	let hasCarryover = false;
	for (const artifact of artifacts) {
		if (artifact.source) { slots.add(artifact.source); hasCarryover = true; }
		else hasCurrent = true;
	}
	const out: NavigatorSource[] = [];
	if (hasCurrent) out.push(currentNavigatorSource());
	if (hasCarryover && hasCurrent) out.push(allNavigatorSource());
	for (const slot of [...slots].sort()) out.push(artifactNavigatorSource(slot));
	if (out.length === 0) out.push(allNavigatorSource());
	return out;
}

function applySourceFilter(artifacts: Artifact[], source: NavigatorSource): Artifact[] {
	if (source.kind === "all") return artifacts;
	if (source.kind === "current") return artifacts.filter((artifact) => !artifact.source);
	return artifacts.filter((artifact) => artifact.source === source.source);
}

function artifactMeta(artifact: Artifact): Record<string, unknown> {
	return artifact.meta ?? {};
}

function artifactTool(artifact: Artifact): string | undefined {
	const tool = artifactMeta(artifact).tool;
	return typeof tool === "string" ? tool : undefined;
}

function artifactHasDiff(artifact: Artifact): boolean {
	const diff = artifactMeta(artifact).diff;
	return typeof diff === "string" && diff.length > 0;
}

function isWorkerChangeSet(artifact: Artifact): boolean {
	return artifactMeta(artifact).workerChangeSet === true;
}

function isChangedFileArtifact(artifact: Artifact): boolean {
	return artifact.kind === "file" && ["edit", "write"].includes(artifactTool(artifact) ?? "");
}

function isFailedCommandArtifact(artifact: Artifact): boolean {
	if (artifact.kind !== "command") return false;
	const exitCode = artifactMeta(artifact).exitCode;
	return typeof exitCode === "number" && exitCode !== 0;
}

export function reviewBucket(artifact: Artifact, queueState: ReviewQueueState = EMPTY_QUEUE): ReviewBucket | undefined {
	if (queueState.pinnedRefs.has(artifact.ref)) return "pinned";
	if (queueState.doneRefs.has(artifact.ref)) return "recent";
	const workerStatus = artifactWorkerStatus(artifact);
	if (workerStatus === "needs_input" || workerStatus === "ready" || workerStatus === "ready_open_todos" || workerStatus === "failed") return "needs";
	if (isWorkerChangeSet(artifact)) return "needs";
	if (artifact.kind === "error") return "needs";
	if (isChangedFileArtifact(artifact) && artifact.source) return "needs";
	if (isFailedCommandArtifact(artifact)) return "needs";
	if (artifact.source && (artifact.kind === "response" || artifact.kind === "code")) return "needs";
	if (artifact.kind === "checkpoint") return "needs";
	return undefined;
}

function attentionRank(item: ReviewItem): number {
	const artifact = item.artifact;
	const status = artifactWorkerStatus(artifact);
	if (status === "needs_input") return 0;
	if (status === "failed") return 1;
	if (artifact.kind === "error" || isFailedCommandArtifact(artifact)) return 2;
	if (isWorkerChangeSet(artifact)) return 3;
	if (isChangedFileArtifact(artifact)) return 4;
	if (status === "ready") return 5;
	if (artifact.source && artifact.kind === "response") return 5;
	if (artifact.source && artifact.kind === "code") return 6;
	return 100;
}

function reviewReason(artifact: Artifact, bucket: ReviewBucket | undefined): ReviewReasonId | undefined {
	const status = artifactWorkerStatus(artifact);
	if (bucket === "pinned") return "pinned";
	if (bucket === "recent") return "done";
	if (status === "needs_input") return "workerNeedsInput";
	if (status === "failed") return "workerFailed";
	if (isWorkerChangeSet(artifact)) return "workerChangeSet";
	if (status === "ready" || status === "ready_open_todos") return "workerReady";
	if (artifact.kind === "error") return "error";
	if (isChangedFileArtifact(artifact)) return artifactHasDiff(artifact) ? "changedFile" : "createdFile";
	if (isFailedCommandArtifact(artifact)) return "failedCommand";
	if (artifact.source && artifact.kind === "response") return "workerAnswer";
	if (artifact.source && artifact.kind === "code") return "workerOutput";
	if (artifact.kind === "checkpoint") return "checkpointAvailable";
	if (artifact.kind === "response") return "assistantAnswer";
	return undefined;
}

export function reviewCategory(reasonId: ReviewReasonId | undefined, bucket: ReviewBucket | undefined): ReviewCategory | undefined {
	if (bucket === "pinned") return "pinned";
	if (bucket === "recent") return "recent";
	if (reasonId === "workerNeedsInput") return "needs-decision";
	if (reasonId === "workerReady" || reasonId === "workerAnswer" || reasonId === "workerOutput") return "ready-for-review";
	if (reasonId === "workerFailed" || reasonId === "error" || reasonId === "failedCommand") return "failed-blocked";
	if (reasonId === "workerChangeSet" || reasonId === "changedFile" || reasonId === "createdFile") return "patch-proposed";
	if (reasonId === "checkpointAvailable") return "checkpoint-available";
	return undefined;
}

export function reviewCategoryLabel(category: ReviewCategory | undefined): string {
	if (category === "needs-decision") return "Needs decision";
	if (category === "ready-for-review") return "Ready for review";
	if (category === "failed-blocked") return "Failed / blocked";
	if (category === "patch-proposed") return "Patch proposed";
	if (category === "checkpoint-available") return "Legacy bundle available";
	if (category === "pinned") return "Pinned";
	if (category === "recent") return "Recently reviewed";
	return "Other";
}

function primaryAction(artifact: Artifact): ReviewActionId {
	const status = artifactWorkerStatus(artifact);
	if (status === "needs_input" || status === "failed") return "openVerdict";
	if (isWorkerChangeSet(artifact)) return "openVerdict";
	if (artifact.kind === "file" && !artifactHasDiff(artifact)) return "openFile";
	return "inspect";
}

function cardRecommendations(artifact: Artifact): string[] {
	const review = projectWorkerArtifactReview(artifact);
	if (review.recommendations.length > 0) return review.recommendations;
	if (artifact.kind === "response" || artifact.kind === "code") return fallbackWorkerSentences(review.summary ?? artifact.body, 2);
	return [];
}

function workerHeadline(artifact: Artifact, status: WorkerDerivedState, label: string): string {
	const subtitle = artifact.subtitle?.trim();
	const task = subtitle && subtitle.length > 0 ? subtitle : undefined;
	if (status === "needs_input") return task ? `${label} needs input · ${task}` : `${label} needs input`;
	if (status === "failed") return task ? `${label} failed · ${task}` : `${label} failed`;
	if (status === "ready" || status === "ready_open_todos") return task ? `${label} finished · ${task}` : `${label} finished`;
	return task ? `${label} · ${task}` : label;
}

function cardHeadline(artifact: Artifact): string {
	const status = artifactWorkerStatus(artifact);
	const label = artifactWorkerRef(artifact);
	if (isWorkerChangeSet(artifact)) return firstWorkerReviewLine(artifact.title) ?? "Worker change set";
	if (status && label) return workerHeadline(artifact, status, label);
	if (artifact.kind === "error") return firstWorkerReviewLine(artifact.title) ?? "Error";
	if (isChangedFileArtifact(artifact)) {
		const verb = artifactHasDiff(artifact) ? "Edited" : "Created";
		return `${verb} ${artifact.title}`;
	}
	if (isFailedCommandArtifact(artifact)) return `Command failed: ${artifact.title}`;
	if (artifact.source && artifact.kind === "response" && label) {
		const cleaned = stripWorkerStatePrefix(artifact.title, label);
		return `${label} answered${cleaned ? ` · ${cleaned}` : ""}`;
	}
	return firstWorkerReviewLine(artifact.title) ?? artifact.kind;
}

function cardStatusChip(artifact: Artifact, bucket: ReviewBucket | undefined): string | undefined {
	const status = artifactWorkerStatus(artifact);
	if (status === "needs_input") return "needs reply";
	if (status === "failed") return "failed";
	if (status === "ready") return isWorkerChangeSet(artifact) ? "change set" : "ready";
	if (status === "ready_open_todos") return "ready · progress";
	if (status === "stale") return "stale";
	if (artifact.kind === "error") return "error";
	if (isFailedCommandArtifact(artifact)) return "failed";
	if (isChangedFileArtifact(artifact)) return artifactHasDiff(artifact) ? "changed" : "new file";
	if (artifact.source && (artifact.kind === "response" || artifact.kind === "code")) return artifact.kind === "code" ? "code" : "answer";
	if (bucket === "pinned") return "pinned";
	if (bucket === "recent") return "done";
	return undefined;
}

function cardProvenance(artifact: Artifact): string {
	const label = artifactWorkerRef(artifact);
	return label ? `worker ${label}` : "current session";
}

function reviewActions(artifact: Artifact): ReviewActionId[] {
	const actions: ReviewActionId[] = ["inspect"];
	const status = artifactWorkerStatus(artifact);
	if (status === "needs_input" || status === "failed" || isWorkerChangeSet(artifact)) actions.push("openVerdict");
	if (isWorkerChangeSet(artifact)) actions.push("promoteWorker");
	if (artifact.kind === "file") actions.push("openFile");
	if (artifactWorkerRef(artifact)) actions.push("tellWorker");
	actions.push("attachReference", "injectFull", "copyArtifact", "save", "pin", "markDone");
	if (artifact.meta?.storedDeliverable === true) actions.push("useDeliverable");
	return [...new Set(actions)];
}

export function reviewItemForArtifact(artifact: Artifact, queueState: ReviewQueueState = EMPTY_QUEUE): ReviewItem {
	const bucket = reviewBucket(artifact, queueState);
	const action = primaryAction(artifact);
	const actions = reviewActions(artifact);
	const reason = reviewReason(artifact, bucket);
	const category = reviewCategory(reason, bucket);
	return {
		artifact,
		...(bucket ? { bucket } : {}),
		...(reason ? { reasonId: reason } : {}),
		primaryAction: action,
		actions: actions.includes(action) ? actions : [action, ...actions],
		headline: cardHeadline(artifact),
		recommendations: cardRecommendations(artifact),
		...(cardStatusChip(artifact, bucket) ? { statusChip: cardStatusChip(artifact, bucket) } : {}),
		provenance: cardProvenance(artifact),
		...(category ? { category } : {}),
	};
}

function sortReviewItems(items: ReviewItem[]): ReviewItem[] {
	return [...items].sort((a, b) => {
		const bucketA = a.bucket ?? "recent";
		const bucketB = b.bucket ?? "recent";
		const rank = BUCKET_RANK[bucketA] - BUCKET_RANK[bucketB];
		if (rank !== 0) return rank;
		const attention = attentionRank(a) - attentionRank(b);
		if (attention !== 0) return attention;
		return (b.artifact.timestamp ?? 0) - (a.artifact.timestamp ?? 0);
	});
}

function applyModeFilter(items: ReviewItem[], mode: NavigatorMode): ReviewItem[] {
	if (mode === "log") return sortLogItems(items);
	if (mode === "answers") return items.filter((item) => item.artifact.kind === "response");
	const queued = items.filter((item) => item.bucket !== undefined);
	const active = queued.filter((item) => item.bucket !== "recent");
	return sortReviewItems(active.length > 0 ? active : queued);
}

function episodeOrderKey(source: string | undefined): string {
	return source ?? "";
}

function sortLogItems(items: ReviewItem[]): ReviewItem[] {
	return [...items].sort((a, b) => {
		const sa = episodeOrderKey(a.artifact.source);
		const sb = episodeOrderKey(b.artifact.source);
		if (sa !== sb) return sa.localeCompare(sb);
		return (a.artifact.timestamp ?? 0) - (b.artifact.timestamp ?? 0);
	});
}

export type EpisodeSummary = {
	id: string;
	source?: string;
	label: string;
	taskLabel?: string;
	artifactCount: number;
	firstTimestamp: number;
	lastTimestamp: number;
};

export function episodesFromItems(items: ReviewItem[]): EpisodeSummary[] {
	const map = new Map<string, EpisodeSummary>();
	for (const item of items) {
		const source = item.artifact.source;
		const id = source ?? "current";
		const existing = map.get(id);
		const taskLabel = item.artifact.subtitle?.trim() || undefined;
		const ts = item.artifact.timestamp ?? 0;
		if (!existing) {
			map.set(id, {
				id,
				...(source ? { source } : {}),
				label: source ? `Worker ${source}` : "Current session",
				...(taskLabel ? { taskLabel } : {}),
				artifactCount: 1,
				firstTimestamp: ts,
				lastTimestamp: ts,
			});
		} else {
			existing.artifactCount++;
			existing.firstTimestamp = Math.min(existing.firstTimestamp, ts);
			existing.lastTimestamp = Math.max(existing.lastTimestamp, ts);
			if (!existing.taskLabel && taskLabel) existing.taskLabel = taskLabel;
		}
	}
	return [...map.values()].sort((a, b) => {
		if (!a.source && b.source) return -1;
		if (a.source && !b.source) return 1;
		return (a.source ?? "").localeCompare(b.source ?? "");
	});
}

export function filteredReviewItems(state: NavigatorState, artifacts: Artifact[], queueState: ReviewQueueState = EMPTY_QUEUE): ReviewItem[] {
	const sourced = applySourceFilter(artifacts, state.source);
	const items = sourced.map((artifact) => reviewItemForArtifact(artifact, queueState));
	const moded = applyModeFilter(items, state.mode);
	return state.filter === "all" ? moded : moded.filter((item) => item.artifact.kind === state.filter);
}

export function selectedReviewItem(state: NavigatorState, artifacts: Artifact[], queueState: ReviewQueueState = EMPTY_QUEUE): ReviewItem | undefined {
	return filteredReviewItems(state, artifacts, queueState)[state.selected];
}

export function navigatorViewModel(state: NavigatorState, artifacts: Artifact[], queueState: ReviewQueueState = EMPTY_QUEUE, windowSize = 12): NavigatorViewModel {
	const items = filteredReviewItems(state, artifacts, queueState);
	const selected = Math.min(Math.max(0, state.selected), Math.max(0, items.length - 1));
	const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), items.length - windowSize));
	const visible = items.slice(start, start + windowSize);
	return { items, selected, selectedItem: items[selected], visible, visibleStart: start };
}

function clampSelected(selected: number, items: ReviewItem[]): number {
	return Math.min(Math.max(0, selected), Math.max(0, items.length - 1));
}

function cycleFilter(filter: NavigatorFilter): NavigatorFilter {
	return FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length] ?? "all";
}

function cycleMode(mode: NavigatorMode): NavigatorMode {
	if (mode === "review") return "answers";
	if (mode === "answers") return "log";
	return "review";
}

function cycleSource(current: NavigatorSource, artifacts: Artifact[]): NavigatorSource {
	const sources = availableSources(artifacts);
	const idx = sources.findIndex((source) => sameNavigatorSource(source, current));
	if (idx === -1) return sources[0] ?? currentNavigatorSource();
	return sources[(idx + 1) % sources.length] ?? sources[0]!;
}

function switchMode(state: NavigatorState, mode: NavigatorMode): NavigatorState {
	return { ...state, mode, selected: 0, filter: "all" };
}

function withSelectedReviewAction(state: NavigatorState, items: ReviewItem[], action: ReviewActionId): NavigatorTransition {
	const selected = clampSelected(state.selected, items);
	const normalizedState = selected === state.selected ? state : { ...state, selected };
	const item = items[selected];
	if (!item || !item.actions.includes(action)) return { state: normalizedState };
	return { state: normalizedState, action: { action: "runReviewAction", id: action, item } };
}

export function handleNavigatorIntent(state: NavigatorState, artifacts: Artifact[], queueState: ReviewQueueState, intent: NavigatorIntent): NavigatorTransition {
	const items = filteredReviewItems(state, artifacts, queueState);
	const selected = clampSelected(state.selected, items);
	const normalizedState = selected === state.selected ? state : { ...state, selected };

	if (intent.kind === "close") return { state: normalizedState, action: { action: "close" } };
	if (intent.kind === "search") return { state: normalizedState, action: { action: "search" } };
	if (intent.kind === "save") return { state: normalizedState, action: { action: "save" } };
	if (intent.kind === "move") return { state: { ...normalizedState, selected: clampSelected(selected + intent.by, items) } };
	if (intent.kind === "top") return { state: { ...normalizedState, selected: 0 } };
	if (intent.kind === "bottom") return { state: { ...normalizedState, selected: Math.max(0, items.length - 1) } };
	if (intent.kind === "toggleDetail") return { state: { ...normalizedState, showDetail: !normalizedState.showDetail } };
	if (intent.kind === "setMode") return { state: switchMode(normalizedState, intent.mode) };
	if (intent.kind === "cycleMode") return { state: switchMode(normalizedState, cycleMode(normalizedState.mode)) };
	if (intent.kind === "cycleFilter") return { state: { ...normalizedState, filter: cycleFilter(normalizedState.filter), selected: 0 } };
	if (intent.kind === "cycleSource") return { state: { ...normalizedState, source: cycleSource(normalizedState.source, artifacts), selected: 0 } };
	if (intent.kind === "activatePrimary") {
		const item = items[selected];
		return item ? { state: normalizedState, action: { action: "runReviewAction", id: item.primaryAction, item } } : { state: normalizedState };
	}
	if (intent.kind === "runAction") return withSelectedReviewAction(normalizedState, items, intent.action);
	return { state: normalizedState };
}
