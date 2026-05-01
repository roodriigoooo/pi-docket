import type { Artifact, ArtifactKind } from "./types.js";

export type NavigatorFilter = ArtifactKind | "all";

export type NavigatorState = {
	selected: number;
	filter: NavigatorFilter;
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

export function initialNavigatorState(): NavigatorState {
	return { selected: 0, filter: "all", showDetail: true };
}

export function filteredArtifacts(state: NavigatorState, artifacts: Artifact[]): Artifact[] {
	return state.filter === "all" ? artifacts : artifacts.filter((artifact) => artifact.kind === state.filter);
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

function withSelectedArtifact(state: NavigatorState, artifacts: Artifact[], action: "inspect" | "reference" | "injectFull" | "copy"): NavigatorTransition {
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
	if (key.raw === "\t" || key.isTab) return { state: { ...normalizedState, filter: cycleFilter(normalizedState.filter), selected: 0 } };
	if (key.isEnter) return withSelectedArtifact(normalizedState, artifacts, "inspect");
	if (key.raw === "r" || key.raw === "i") return withSelectedArtifact(normalizedState, artifacts, "reference");
	if (key.raw === "I") return withSelectedArtifact(normalizedState, artifacts, "injectFull");
	if (key.raw === "y") return withSelectedArtifact(normalizedState, artifacts, "copy");
	if (key.raw === "c") return { state: normalizedState, action: { action: "checkpoint" } };
	return { state: normalizedState };
}
