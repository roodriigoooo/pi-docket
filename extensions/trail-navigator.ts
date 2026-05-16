import type { Artifact, ArtifactKind } from "./types.js";

export type NavigatorFilter = ArtifactKind | "all";
export type NavigatorMode = "review" | "answers" | "all";
export type NavigatorSource =
	| { kind: "current" }
	| { kind: "all" }
	| { kind: "artifactSource"; source: string };
export type ReviewBucket = "needs" | "pinned" | "recent";
export type ReviewActionId =
	| "inspect"
	| "openFile"
	| "tellWorker"
	| "attachReference"
	| "injectFull"
	| "copyArtifact"
	| "pin"
	| "markDone";
export type ReviewReasonId =
	| "pinned"
	| "done"
	| "workerNeedsInput"
	| "workerFailed"
	| "workerReady"
	| "error"
	| "changedFile"
	| "createdFile"
	| "failedCommand"
	| "workerAnswer"
	| "workerOutput"
	| "assistantAnswer";

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
	| { kind: "createCheckpoint" }
	| { kind: "search" }
	| { kind: "close" };

export type NavigatorAction =
	| { action: "runReviewAction"; id: ReviewActionId; item: ReviewItem }
	| { action: "createCheckpoint" }
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

type ArtifactWorkerStatus = "starting" | "thinking" | "stale" | "needs_input" | "ready" | "empty" | "failed" | "idle";

function artifactWorkerStatus(artifact: Artifact): ArtifactWorkerStatus | undefined {
	const status = artifactMeta(artifact).workerStatus;
	if (status === "needs_input" || status === "ready" || status === "failed" || status === "stale" || status === "starting" || status === "thinking" || status === "empty" || status === "idle") return status;
	return undefined;
}

function artifactWorkerRef(artifact: Artifact): string | undefined {
	const label = artifactMeta(artifact).workerLabel;
	if (typeof label === "string" && label.length > 0) return label;
	return artifact.source;
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
	if (workerStatus === "needs_input" || workerStatus === "ready" || workerStatus === "failed") return "needs";
	if (artifact.kind === "error") return "needs";
	if (isChangedFileArtifact(artifact)) return "needs";
	if (isFailedCommandArtifact(artifact)) return "needs";
	if (artifact.source && (artifact.kind === "response" || artifact.kind === "code")) return "needs";
	return undefined;
}

function attentionRank(item: ReviewItem): number {
	const artifact = item.artifact;
	const status = artifactWorkerStatus(artifact);
	if (status === "needs_input") return 0;
	if (status === "failed") return 1;
	if (artifact.kind === "error" || isFailedCommandArtifact(artifact)) return 2;
	if (isChangedFileArtifact(artifact)) return 3;
	if (status === "ready") return 4;
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
	if (status === "ready") return "workerReady";
	if (artifact.kind === "error") return "error";
	if (isChangedFileArtifact(artifact)) return artifactHasDiff(artifact) ? "changedFile" : "createdFile";
	if (isFailedCommandArtifact(artifact)) return "failedCommand";
	if (artifact.source && artifact.kind === "response") return "workerAnswer";
	if (artifact.source && artifact.kind === "code") return "workerOutput";
	if (artifact.kind === "response") return "assistantAnswer";
	return undefined;
}

function primaryAction(artifact: Artifact): ReviewActionId {
	if (artifactWorkerStatus(artifact) === "needs_input") return "tellWorker";
	if (artifact.kind === "file" && !artifactHasDiff(artifact)) return "openFile";
	return "inspect";
}

function reviewActions(artifact: Artifact): ReviewActionId[] {
	const actions: ReviewActionId[] = ["inspect"];
	if (artifact.kind === "file") actions.push("openFile");
	if (artifactWorkerRef(artifact)) actions.push("tellWorker");
	actions.push("attachReference", "injectFull", "copyArtifact", "pin", "markDone");
	return [...new Set(actions)];
}

export function reviewItemForArtifact(artifact: Artifact, queueState: ReviewQueueState = EMPTY_QUEUE): ReviewItem {
	const bucket = reviewBucket(artifact, queueState);
	const action = primaryAction(artifact);
	const actions = reviewActions(artifact);
	return {
		artifact,
		...(bucket ? { bucket } : {}),
		...(reviewReason(artifact, bucket) ? { reasonId: reviewReason(artifact, bucket) } : {}),
		primaryAction: action,
		actions: actions.includes(action) ? actions : [action, ...actions],
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
	if (mode === "all") return items;
	if (mode === "answers") return items.filter((item) => item.artifact.kind === "response");
	const queued = items.filter((item) => item.bucket !== undefined);
	const active = queued.filter((item) => item.bucket !== "recent");
	return sortReviewItems(active.length > 0 ? active : queued);
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
	if (mode === "answers") return "all";
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
	if (intent.kind === "createCheckpoint") return { state: normalizedState, action: { action: "createCheckpoint" } };
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
