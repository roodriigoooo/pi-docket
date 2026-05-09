import type { Artifact, ArtifactKind } from "./types.js";

export type NavigatorFilter = ArtifactKind | "all";
export type NavigatorMode = "work" | "recall" | "all";
export type NavigatorSource = "current" | "all" | string;
export type NavigatorBucket = "needs" | "pinned" | "recent";

export type NavigatorState = {
	selected: number;
	filter: NavigatorFilter;
	source: NavigatorSource;
	mode: NavigatorMode;
	showDetail: boolean;
};

export type NavigatorKey = {
	raw: string;
	isDown: boolean;
	isUp: boolean;
	isEnter: boolean;
	isTab: boolean;
	isEscape: boolean;
	isCtrlC: boolean;
};

export type NavigatorAction =
	| { action: "inspect"; artifact: Artifact }
	| { action: "openFile"; artifact: Artifact }
	| { action: "reference"; artifact: Artifact }
	| { action: "injectFull"; artifact: Artifact }
	| { action: "copy"; artifact: Artifact }
	| { action: "checkpoint" }
	| { action: "close" };

export type NavigatorTransition = {
	state: NavigatorState;
	action?: NavigatorAction;
};

export type NavigatorViewModel = {
	items: Artifact[];
	selected: number;
	selectedArtifact?: Artifact;
	visible: Artifact[];
	visibleStart: number;
};

const FILTERS: NavigatorFilter[] = ["all", "error", "command", "file", "code", "prompt", "response", "checkpoint"];
const BUCKET_RANK: Record<NavigatorBucket, number> = { needs: 0, pinned: 1, recent: 2 };

export function initialNavigatorState(): NavigatorState {
	return { selected: 0, filter: "all", source: "current", mode: "work", showDetail: false };
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
	if (hasCurrent) out.push("current");
	if (hasCarryover && hasCurrent) out.push("all");
	for (const slot of [...slots].sort()) out.push(slot);
	if (out.length === 0) out.push("all");
	return out;
}

function applySourceFilter(artifacts: Artifact[], source: NavigatorSource): Artifact[] {
	if (source === "all") return artifacts;
	if (source === "current") return artifacts.filter((artifact) => !artifact.source);
	return artifacts.filter((artifact) => artifact.source === source);
}

export function navigatorBucket(artifact: Artifact): NavigatorBucket | undefined {
	const bucket = artifact.meta?.trailBucket;
	return bucket === "needs" || bucket === "pinned" || bucket === "recent" ? bucket : undefined;
}

function applyModeFilter(artifacts: Artifact[], mode: NavigatorMode): Artifact[] {
	if (mode === "all") return artifacts;
	if (mode === "recall") return artifacts.filter((artifact) => artifact.kind === "response");
	return artifacts
		.filter((artifact) => navigatorBucket(artifact) !== undefined)
		.sort((a, b) => {
			const bucketA = navigatorBucket(a) ?? "recent";
			const bucketB = navigatorBucket(b) ?? "recent";
			const rank = BUCKET_RANK[bucketA] - BUCKET_RANK[bucketB];
			if (rank !== 0) return rank;
			return (b.timestamp ?? 0) - (a.timestamp ?? 0);
		});
}

export function filteredArtifacts(state: NavigatorState, artifacts: Artifact[]): Artifact[] {
	const sourced = applySourceFilter(artifacts, state.source);
	const moded = applyModeFilter(sourced, state.mode);
	return state.filter === "all" ? moded : moded.filter((artifact) => artifact.kind === state.filter);
}

export function selectedArtifact(state: NavigatorState, artifacts: Artifact[]): Artifact | undefined {
	return filteredArtifacts(state, artifacts)[state.selected];
}

export function navigatorViewModel(state: NavigatorState, artifacts: Artifact[], windowSize = 12): NavigatorViewModel {
	const items = filteredArtifacts(state, artifacts);
	const selected = Math.min(Math.max(0, state.selected), Math.max(0, items.length - 1));
	const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), items.length - windowSize));
	const visible = items.slice(start, start + windowSize);
	return { items, selected, selectedArtifact: items[selected], visible, visibleStart: start };
}

function clampSelected(selected: number, items: Artifact[]): number {
	return Math.min(Math.max(0, selected), Math.max(0, items.length - 1));
}

function cycleFilter(filter: NavigatorFilter): NavigatorFilter {
	return FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length] ?? "all";
}

function cycleSource(current: NavigatorSource, artifacts: Artifact[]): NavigatorSource {
	const sources = availableSources(artifacts);
	const idx = sources.indexOf(current);
	if (idx === -1) return sources[0] ?? "current";
	return sources[(idx + 1) % sources.length] ?? sources[0]!;
}

function switchMode(state: NavigatorState, mode: NavigatorMode): NavigatorState {
	return { ...state, mode, selected: 0, filter: "all" };
}

function withSelectedArtifact(state: NavigatorState, artifacts: Artifact[], action: "inspect" | "openFile" | "reference" | "injectFull" | "copy"): NavigatorTransition {
	const artifact = selectedArtifact(state, artifacts);
	return artifact ? { state, action: { action, artifact } } : { state };
}

export function handleNavigatorKey(state: NavigatorState, artifacts: Artifact[], key: NavigatorKey): NavigatorTransition {
	const items = filteredArtifacts(state, artifacts);
	const selected = clampSelected(state.selected, items);
	const normalizedState = selected === state.selected ? state : { ...state, selected };

	if (key.isEscape || key.isCtrlC || key.raw === "q") return { state: normalizedState, action: { action: "close" } };
	if (key.raw === "j" || key.isDown) return { state: { ...normalizedState, selected: clampSelected(selected + 1, items) } };
	if (key.raw === "k" || key.isUp) return { state: { ...normalizedState, selected: Math.max(0, selected - 1) } };
	if (key.raw === "g") return { state: { ...normalizedState, selected: 0 } };
	if (key.raw === "G") return { state: { ...normalizedState, selected: Math.max(0, items.length - 1) } };
	if (key.raw === "v") return { state: { ...normalizedState, showDetail: !normalizedState.showDetail } };
	if (key.raw === "/") return { state: switchMode(normalizedState, normalizedState.mode === "recall" ? "work" : "recall") };
	if (key.raw === "w") return { state: switchMode(normalizedState, "work") };
	if (key.raw === "a") return { state: switchMode(normalizedState, "all") };
	if (key.raw === "\t" || key.isTab) return { state: { ...normalizedState, filter: cycleFilter(normalizedState.filter), selected: 0 } };
	if (key.raw === "s") return { state: { ...normalizedState, source: cycleSource(normalizedState.source, artifacts), selected: 0 } };
	if (key.isEnter) return withSelectedArtifact(normalizedState, artifacts, "inspect");
	if (key.raw === "o") return withSelectedArtifact(normalizedState, artifacts, "openFile");
	if (key.raw === "r" || key.raw === "i") return withSelectedArtifact(normalizedState, artifacts, "reference");
	if (key.raw === "I") return withSelectedArtifact(normalizedState, artifacts, "injectFull");
	if (key.raw === "y") return withSelectedArtifact(normalizedState, artifacts, "copy");
	if (key.raw === "c") return { state: normalizedState, action: { action: "checkpoint" } };
	return { state: normalizedState };
}
