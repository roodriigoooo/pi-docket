import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import { createEvidenceBundleKeymap, formatKeyHints } from "./docket-keymap.js";
import type { Artifact, ArtifactKind, CheckpointMode } from "./types.js";

export type CheckpointSelectionState = {
	selected: number;
	checked: boolean[];
};

export type CheckpointSelectionStats = {
	total: number;
	selected: number;
	estimatedTokens: number;
};

function artifactChars(artifact: Artifact): number {
	return artifact.title.length + artifact.subtitle.length + artifact.body.length;
}

export function initialCheckpointSelection(artifacts: Artifact[]): CheckpointSelectionState {
	return { selected: 0, checked: artifacts.map(() => true) };
}

export function toggleCheckpointSelection(state: CheckpointSelectionState, index = state.selected): CheckpointSelectionState {
	if (index < 0 || index >= state.checked.length) return state;
	return { ...state, checked: state.checked.map((checked, i) => (i === index ? !checked : checked)) };
}

export function selectAllCheckpointArtifacts(state: CheckpointSelectionState): CheckpointSelectionState {
	return { ...state, checked: state.checked.map(() => true) };
}

export function selectNoCheckpointArtifacts(state: CheckpointSelectionState): CheckpointSelectionState {
	return { ...state, checked: state.checked.map(() => false) };
}

export function selectedCheckpointArtifacts(artifacts: Artifact[], state: CheckpointSelectionState): Artifact[] {
	return artifacts.filter((_, index) => state.checked[index]);
}

export function checkpointSelectionStats(artifacts: Artifact[], state: CheckpointSelectionState): CheckpointSelectionStats {
	const selected = selectedCheckpointArtifacts(artifacts, state);
	return {
		total: artifacts.length,
		selected: selected.length,
		estimatedTokens: Math.ceil(selected.reduce((sum, artifact) => sum + artifactChars(artifact), 0) / 4),
	};
}

function clampSelected(selected: number, artifacts: Artifact[]): number {
	return Math.min(Math.max(0, selected), Math.max(0, artifacts.length - 1));
}

function kindLabel(kind: ArtifactKind): string {
	const labels: Record<ArtifactKind, string> = { command: "cmd", error: "err", file: "file", code: "code", prompt: "user", response: "ai", checkpoint: "ckpt" };
	return labels[kind];
}

function colorKind(theme: any, kind: ArtifactKind, text: string): string {
	if (kind === "error") return theme.fg("error", text);
	if (kind === "command") return theme.fg("success", text);
	if (kind === "file") return theme.fg("toolDiffAdded", text);
	if (kind === "code") return theme.fg("warning", text);
	if (kind === "checkpoint") return theme.fg("accent", text);
	if (kind === "prompt") return theme.fg("customMessageLabel", text);
	return theme.fg("muted", text);
}

class CheckpointSelectorView implements Component {
	private state: CheckpointSelectionState;
	private message = "";
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private tui: TUI,
		private theme: any,
		private artifacts: Artifact[],
		private mode: CheckpointMode,
		private done: (result: Artifact[] | null) => void,
	) {
		this.state = initialCheckpointSelection(artifacts);
	}

	handleInput(data: string): void {
		const selected = clampSelected(this.state.selected, this.artifacts);
		this.state = selected === this.state.selected ? this.state : { ...this.state, selected };

		const action = createEvidenceBundleKeymap().resolve(data);
		if (action === "close") {
			this.done(null);
			return;
		}
		if (action === "down") this.state = { ...this.state, selected: clampSelected(selected + 1, this.artifacts) };
		else if (action === "up") this.state = { ...this.state, selected: Math.max(0, selected - 1) };
		else if (action === "top") this.state = { ...this.state, selected: 0 };
		else if (action === "bottom") this.state = { ...this.state, selected: Math.max(0, this.artifacts.length - 1) };
		else if (action === "toggle") this.state = toggleCheckpointSelection(this.state);
		else if (action === "all") this.state = selectAllCheckpointArtifacts(this.state);
		else if (action === "none") this.state = selectNoCheckpointArtifacts(this.state);
		else if (action === "save") {
			const selectedArtifacts = selectedCheckpointArtifacts(this.artifacts, this.state);
			if (selectedArtifacts.length === 0) this.message = "select at least one artifact or q cancel";
			else this.done(selectedArtifacts);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		this.message = "";
		this.invalidate();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const container = new Box(2, 1, (s) => this.theme.bg("customMessageBg", s));
		const innerWidth = Math.max(20, width - 4);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const warning = (s: string) => this.theme.fg("warning", s);
		const stats = checkpointSelectionStats(this.artifacts, this.state);
		const header = `${accent(this.theme.bold("docket · evidence bundle"))} ${dim(this.mode)} ${dim("·")} ${stats.selected}/${stats.total} selected ${dim("·")} ~${stats.estimatedTokens} tok`;
		container.addChild(new Text(truncateToWidth(header, innerWidth - 2), 1, 0));

		const windowSize = 14;
		const selected = clampSelected(this.state.selected, this.artifacts);
		const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), this.artifacts.length - windowSize));
		const visible = this.artifacts.slice(start, start + windowSize);
		for (let i = 0; i < visible.length; i++) {
			const artifact = visible[i]!;
			const absolute = start + i;
			const isSelected = absolute === selected;
			const marker = isSelected ? accent("▸") : dim(" ");
			const checked = this.state.checked[absolute] ? accent("[x]") : muted("[ ]");
			const id = isSelected ? accent(this.theme.bold(artifact.displayId.padEnd(5))) : muted(artifact.displayId.padEnd(5));
			const kind = colorKind(this.theme, artifact.kind, kindLabel(artifact.kind).padEnd(5));
			const title = isSelected ? this.theme.bold(this.theme.fg("text", artifact.title)) : muted(artifact.title);
			const line = `${marker} ${checked} ${id} ${kind} ${title} ${dim(artifact.subtitle)}`;
			container.addChild(new Text(truncateToWidth(line, innerWidth - 2), 1, 0));
		}
		for (let i = visible.length; i < windowSize; i++) container.addChild(new Text("", 1, 0));

		if (this.message) container.addChild(new Text(warning(this.message), 1, 0));
		else container.addChild(new Text(dim(formatKeyHints(createEvidenceBundleKeymap(), "footer")), 1, 0));

		this.cachedLines = container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

export async function showCheckpointSelector(ctx: ExtensionCommandContext, artifacts: Artifact[], mode: CheckpointMode): Promise<Artifact[] | null> {
	return ctx.ui.custom((tui, theme, _kb, done) => new CheckpointSelectorView(tui, theme, artifacts, mode, done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "88%", minWidth: 84, maxHeight: "90%", margin: 1 },
	});
}
