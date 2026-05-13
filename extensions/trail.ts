/**
 * Trail — session artifacts as first-class objects.
 *
 * Commands:
 *   /trail                         open review inbox
 *   /trail memory [query]           browse assistant/worker answers
 *   /trail search <query>           ranked artifact search
 *   /trail checkpoint [flags] [note]
 *   /trail continue <id|last>
 *   /trail resume [id|last]
 *   /trail list
 *   /trail delete [id|last]
 *   /trail ref <artifact-id>
 *   /trail inject <artifact-id>     alias for ref
 *   /trail inject-full <artifact-id>
 *   /trail copy <artifact-id>
 *
 * Checkpoint flags:
 *   --handoff (default), --compact, --debug, --review, --once, --raw
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, MessageRenderer } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getLanguageFromPath, highlightCode } from "@mariozechner/pi-coding-agent";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import {
	Box,
	Container,
	Key,
	Spacer,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@mariozechner/pi-tui";
import { artifactFilePath, createArtifactCatalog, formatArtifact, type ArtifactCatalog } from "./artifact-catalog.js";
import { createCheckpointCommands, type ResumeAction, type ResumeMode, type ResumeSelection } from "./checkpoint-commands.js";
import { createCheckpointLifecycle } from "./checkpoint-lifecycle.js";
import { createCheckpointStore, type CheckpointSummary } from "./checkpoint-store.js";
import { createLoadedArtifactContext, type Chip, type ChipToggleResult } from "./loaded-artifact-context.js";
import { loadConfig } from "./trail-config.js";
import { parseTrailCommand, trailUsage, TRAIL_COMMANDS } from "./trail-command-grammar.js";
import { availableSources, handleNavigatorKey, initialNavigatorState, navigatorBucket, navigatorViewModel, selectedArtifact, type NavigatorAction, type NavigatorKey, type NavigatorMode, type NavigatorState } from "./trail-navigator.js";
import type { Artifact, ArtifactKind, CheckpointIndexEntry } from "./types.js";
import { createWorkerCommands, workerAge, workerCompletionCandidates } from "./worker-commands.js";
import { createWorkerStore, TRAIL_WORKER_ENV, workerShortLabel, workerSummaryName, type WorkerStatus } from "./worker-store.js";

async function runCommand(command: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => (stdout += data.toString("utf8")));
		child.stderr.on("data", (data) => (stderr += data.toString("utf8")));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(input ?? "");
	});
}

async function copyToClipboard(text: string): Promise<boolean> {
	const candidates = process.platform === "darwin" ? [["pbcopy", []]] : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
	for (const [cmd, args] of candidates as Array<[string, string[]]>) {
		try {
			const result = await runCommand(cmd, args, text);
			if (result.code === 0) return true;
		} catch {
			// try next clipboard command
		}
	}
	return false;
}

class TrailTextViewer implements Component {
	private offset = 0;
	private lines: string[];
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private tui: TUI, private theme: any, private title: string, text: string, private done: () => void) {
		this.lines = text.split("\n");
	}

	handleInput(data: string): void {
		const maxOffset = Math.max(0, this.lines.length - 34);
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
			this.done();
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) this.offset = Math.min(maxOffset, this.offset + 1);
		else if (data === "k" || matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
		else if (data === "d") this.offset = Math.min(maxOffset, this.offset + 17);
		else if (data === "u") this.offset = Math.max(0, this.offset - 17);
		else if (data === "g") this.offset = 0;
		else if (data === "G") this.offset = maxOffset;
		this.invalidate();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const container = new Box(2, 1, trailCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const outerBorder = (s: string) => this.theme.fg("borderAccent", s);
		const headerLeft = ` ${accent(this.theme.bold("trail · inspect"))} ${dim(this.title)} `;
		const headerRight = ` ${dim(`${Math.min(this.offset + 1, this.lines.length)}-${Math.min(this.offset + 34, this.lines.length)}/${this.lines.length}`)} `;
		container.addChild(new Text(fitBorder(headerLeft, headerRight, innerWidth, outerBorder, TOP_CORNERS), 0, 0));
		for (const line of this.lines.slice(this.offset, this.offset + 34)) {
			container.addChild(new Text(truncateToWidth(line, innerWidth - 2), 1, 0));
		}
		container.addChild(new Text(dim("j/k scroll · d/u half-page · g/G top/bottom · q close"), 1, 0));
		container.addChild(new Text(fitBorder("", "", innerWidth, outerBorder, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

class TrailFileViewer implements Component {
	private offset = 0;
	private viewportHeight = 30;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private tui: TUI,
		private theme: any,
		private filePath: string,
		private language: string | undefined,
		private lines: string[],
		private done: () => void,
	) {}

	handleInput(data: string): void {
		const maxOffset = Math.max(0, this.lines.length - this.viewportHeight);
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
			this.done();
			return;
		}
		const half = Math.floor(this.viewportHeight / 2);
		if (data === "j" || matchesKey(data, Key.down)) this.offset = Math.min(maxOffset, this.offset + 1);
		else if (data === "k" || matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
		else if (data === "d") this.offset = Math.min(maxOffset, this.offset + half);
		else if (data === "u") this.offset = Math.max(0, this.offset - half);
		else if (data === "g") this.offset = 0;
		else if (data === "G") this.offset = maxOffset;
		this.invalidate();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const container = new Box(2, 1, trailCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const outerBorder = (s: string) => this.theme.fg("borderAccent", s);

		const lineNumWidth = Math.max(3, String(this.lines.length).length);
		const last = Math.min(this.offset + this.viewportHeight, this.lines.length);
		const visible = this.lines.slice(this.offset, this.offset + this.viewportHeight);
		const langTag = this.language ?? "text";
		const headerLeft = ` ${accent(this.theme.bold(this.filePath))} ${dim(langTag)} `;
		const headerRight = ` ${dim(`${Math.min(this.offset + 1, this.lines.length)}-${last}/${this.lines.length}`)} `;
		container.addChild(new Text(fitBorder(headerLeft, headerRight, innerWidth, outerBorder, TOP_CORNERS), 0, 0));

		for (let i = 0; i < visible.length; i++) {
			const lineNo = this.offset + i + 1;
			const numStr = muted(String(lineNo).padStart(lineNumWidth));
			const code = visible[i] ?? "";
			container.addChild(new Text(truncateToWidth(`${numStr}  ${code}`, innerWidth - 2), 1, 0));
		}
		for (let i = visible.length; i < this.viewportHeight; i++) {
			container.addChild(new Text("", 1, 0));
		}

		container.addChild(new Text(dim("j/k scroll · d/u half-page · g/G top/bottom · q close"), 1, 0));
		container.addChild(new Text(fitBorder("", "", innerWidth, outerBorder, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

async function showFileViewer(ctx: ExtensionCommandContext, filePath: string): Promise<void> {
	let content: string;
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) {
			await showTextViewer(ctx, filePath, `[Trail: ${filePath} is not a file]`);
			return;
		}
		content = await fs.readFile(filePath, "utf8");
	} catch (err) {
		await showTextViewer(ctx, filePath, `[Trail could not read ${filePath}: ${String(err)}]`);
		return;
	}
	const language = getLanguageFromPath(filePath);
	const highlighted = highlightCode(content, language);
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => new TrailFileViewer(tui, theme, filePath, language, highlighted, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "92%", minWidth: 84, maxHeight: "95%", margin: 1 } },
	);
}

async function showTextViewer(ctx: ExtensionCommandContext, title: string, text: string): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => new TrailTextViewer(tui, theme, title, text, done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "90%", minWidth: 90, maxHeight: "95%", margin: 1 },
	});
}

async function showArtifactViewer(ctx: ExtensionCommandContext, catalog: ArtifactCatalog, artifact: Artifact): Promise<void> {
	if (artifact.kind === "file" && !artifactHasDiff(artifact)) {
		const filePath = artifactFilePath(artifact, ctx.cwd);
		if (filePath) {
			await showFileViewer(ctx, filePath);
			return;
		}
	}
	const inspected = await catalog.inspect(artifact);
	await showTextViewer(ctx, inspected.title, inspected.text);
}

function relativeTime(timestamp?: number): string {
	if (!timestamp) return "";
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(timestamp).toLocaleDateString();
}

function kindLabel(kind: ArtifactKind): string {
	const labels: Record<ArtifactKind, string> = { command: "cmd", error: "error", file: "file", code: "code", prompt: "prompt", response: "answer", checkpoint: "restore" };
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

type BorderOptions = {
	fill?: (s: string) => string;
	left?: string;
	right?: string;
};

function fitBorder(left: string, right: string, width: number, border: (s: string) => string, options: BorderOptions = {}): string {
	const cornerL = options.left ?? "─";
	const cornerR = options.right ?? "─";
	const fill = options.fill ?? border;
	if (width <= 0) return "";
	if (width === 1) return border(cornerL);
	let leftText = left;
	let rightText = right;
	const fixedWidth = 2;
	const minimumGap = leftText || rightText ? 3 : 0;
	while (fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width && visibleWidth(rightText) > 0) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width && visibleWidth(leftText) > 0) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}
	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${border(cornerL)}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border(cornerR)}`;
}

function padAnsi(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

const TOP_CORNERS: BorderOptions = { left: "╭", right: "╮" };
const BOTTOM_CORNERS: BorderOptions = { left: "╰", right: "╯" };

function trailCardBg(theme: any): (s: string) => string {
	return (s: string) => theme.bg("customMessageBg", s);
}

function activePill(theme: any, label: string): string {
	return theme.bg("selectedBg", theme.fg("text", ` ${theme.bold(label)} `));
}

function inactivePill(theme: any, label: string): string {
	return theme.fg("dim", ` ${label} `);
}

function filterBar(theme: any, active: string): string {
	const filters: Array<{ value: string; label: string }> = [
		{ value: "all", label: "all" },
		{ value: "error", label: "err" },
		{ value: "command", label: "cmd" },
		{ value: "file", label: "file" },
		{ value: "code", label: "code" },
		{ value: "prompt", label: "user" },
		{ value: "response", label: "ai" },
		{ value: "checkpoint", label: "ckpt" },
	];
	return filters.map((filter) => filter.value === active ? activePill(theme, filter.label) : inactivePill(theme, filter.label)).join(" ");
}

function sourceBar(theme: any, sources: string[], active: string): string {
	if (sources.length <= 1) return "";
	return sources
		.map((source) => source === active ? activePill(theme, source) : inactivePill(theme, source))
		.join(" ");
}

type TrailBrowserAction = { action: "inspect" | "openFile" | "reference" | "injectFull" | "copy" | "checkpoint" | "search" | "replyWorker"; artifact?: Artifact };

type TrailBucket = "needs" | "pinned" | "recent";

function modeBar(theme: any, active: NavigatorMode): string {
	const modes: Array<{ value: NavigatorMode; label: string }> = [
		{ value: "work", label: "review" },
		{ value: "recall", label: "memory" },
		{ value: "all", label: "catalog" },
	];
	return modes.map((mode) => mode.value === active ? activePill(theme, mode.label) : inactivePill(theme, mode.label)).join(" ");
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

function artifactWorkerStatus(artifact: Artifact): WorkerDerivedState | undefined {
	const status = artifactMeta(artifact).workerStatus;
	if (status === "needs_input" || status === "ready" || status === "failed" || status === "stale" || status === "starting" || status === "thinking" || status === "empty" || status === "idle") return status;
	return undefined;
}

function artifactWorkerRef(artifact: Artifact): string | undefined {
	const label = artifactMeta(artifact).workerLabel;
	if (typeof label === "string" && label.length > 0) return label;
	return artifact.source;
}

function isWorkerQuestionArtifact(artifact: Artifact | undefined): artifact is Artifact {
	return !!artifact && artifactWorkerStatus(artifact) === "needs_input";
}

function isChangedFileArtifact(artifact: Artifact): boolean {
	return artifact.kind === "file" && ["edit", "write"].includes(artifactTool(artifact) ?? "");
}

function isFailedCommandArtifact(artifact: Artifact): boolean {
	if (artifact.kind !== "command") return false;
	const exitCode = artifactMeta(artifact).exitCode;
	return typeof exitCode === "number" && exitCode !== 0;
}

function trailBucketForArtifact(artifact: Artifact, pinnedRefs: Set<string>, completedRefs: Set<string>): TrailBucket | undefined {
	if (pinnedRefs.has(artifact.ref)) return "pinned";
	if (completedRefs.has(artifact.ref)) return "recent";
	if (artifactWorkerStatus(artifact) === "needs_input" || artifactWorkerStatus(artifact) === "ready" || artifactWorkerStatus(artifact) === "failed") return "needs";
	if (artifact.kind === "error") return "needs";
	if (isChangedFileArtifact(artifact)) return "needs";
	if (isFailedCommandArtifact(artifact)) return "needs";
	if (artifact.source && (artifact.kind === "response" || artifact.kind === "code")) return "needs";
	return undefined;
}

function trailAttentionRankForArtifact(artifact: Artifact): number | undefined {
	const status = artifactWorkerStatus(artifact);
	if (status === "needs_input") return 0;
	if (status === "failed") return 1;
	if (artifact.kind === "error" || isFailedCommandArtifact(artifact)) return 2;
	if (isChangedFileArtifact(artifact)) return 3;
	if (status === "ready") return 4;
	if (artifact.source && artifact.kind === "response") return 5;
	if (artifact.source && artifact.kind === "code") return 6;
	return undefined;
}

function trailPrimaryAction(artifact: Artifact): string {
	if (artifactWorkerStatus(artifact) === "needs_input") return "Reply";
	if (artifactWorkerStatus(artifact) === "failed") return "Inspect failure";
	if (artifactWorkerStatus(artifact) === "ready") return "View answer";
	if (artifact.kind === "file" && artifactHasDiff(artifact)) return "Review diff";
	if (artifact.kind === "file") return "Open file";
	if (artifact.kind === "error") return "Inspect failure";
	if (artifact.kind === "command") return isFailedCommandArtifact(artifact) ? "Inspect failure" : "Inspect output";
	if (artifact.kind === "response") return "View answer";
	if (artifact.kind === "code") return "View code";
	if (artifact.kind === "checkpoint") return "Open checkpoint";
	return "Open";
}

function trailReason(artifact: Artifact): string {
	const bucket = navigatorBucket(artifact);
	const status = artifactWorkerStatus(artifact);
	if (bucket === "pinned") return "pinned";
	if (bucket === "recent") return "recently reviewed";
	if (status === "needs_input") return "worker waiting";
	if (status === "failed") return "worker failed";
	if (status === "ready") return "worker ready";
	if (artifact.kind === "error") return "needs attention";
	if (isChangedFileArtifact(artifact)) return artifactHasDiff(artifact) ? "changed file" : "created file";
	if (isFailedCommandArtifact(artifact)) return "failed command";
	if (artifact.source && artifact.kind === "response") return "worker answer";
	if (artifact.source && artifact.kind === "code") return "worker output";
	if (artifact.kind === "response") return "assistant answer";
	return "";
}

function bucketName(bucket: TrailBucket | undefined, mode: NavigatorMode): string {
	if (bucket === "needs") return "next";
	if (bucket === "pinned") return "pinned";
	if (bucket === "recent") return "recent";
	return mode === "recall" ? "answer" : "item";
}

function bucketGlyph(bucket: TrailBucket | undefined, mode: NavigatorMode): string {
	if (bucket === "needs") return "◆";
	if (bucket === "pinned") return "●";
	if (bucket === "recent") return "✓";
	return mode === "recall" ? "✦" : "·";
}

function colorBucket(theme: any, bucket: TrailBucket | undefined, mode: NavigatorMode, text: string): string {
	if (bucket === "needs") return theme.fg("warning", text);
	if (bucket === "pinned") return theme.fg("accent", text);
	if (bucket === "recent") return theme.fg("success", text);
	return mode === "recall" ? theme.fg("accent", text) : theme.fg("muted", text);
}

function selectedActionHints(artifact: Artifact, pinned: boolean, completed: boolean): string[] {
	const hints = [`enter ${trailPrimaryAction(artifact).toLowerCase()}`];
	if (isWorkerQuestionArtifact(artifact)) hints.push("r reply");
	if (artifact.kind === "file") hints.push("o open");
	hints.push("a attach", "I full", "y copy", pinned ? "p unpin" : "p pin", completed ? "x restore" : "x done", "v preview");
	return hints;
}

function decorateTrailArtifacts(artifacts: Artifact[], pinnedRefs: Set<string>, completedRefs: Set<string>): Artifact[] {
	return artifacts.map((artifact) => {
		const bucket = trailBucketForArtifact(artifact, pinnedRefs, completedRefs);
		const attentionRank = trailAttentionRankForArtifact(artifact);
		return {
			...artifact,
			meta: {
				...(artifact.meta ?? {}),
				...(bucket ? { trailBucket: bucket } : {}),
				...(attentionRank !== undefined ? { trailAttentionRank: attentionRank } : {}),
				trailPrimaryAction: trailPrimaryAction(artifact),
				trailReason: trailReason({ ...artifact, meta: { ...(artifact.meta ?? {}), ...(bucket ? { trailBucket: bucket } : {}) } }),
			},
		};
	});
}

function trailMetaString(artifact: Artifact, key: string): string | undefined {
	const value = artifactMeta(artifact)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bucketCounts(artifacts: Artifact[]): Record<TrailBucket, number> {
	const counts: Record<TrailBucket, number> = { needs: 0, pinned: 0, recent: 0 };
	for (const artifact of artifacts) {
		const bucket = navigatorBucket(artifact);
		if (bucket) counts[bucket]++;
	}
	return counts;
}

function navigatorModeLabel(mode: NavigatorMode): string {
	if (mode === "work") return "review";
	if (mode === "recall") return "memory";
	return "catalog";
}

function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function trailStatusLine(mode: NavigatorMode, items: Artifact[], artifacts: Artifact[]): string {
	if (artifacts.length === 0) return "quiet until something needs attention";
	if (mode === "recall") return plural(items.length, "memory", "memories");
	if (mode === "all") return plural(items.length, "artifact");
	const counts = bucketCounts(items);
	const parts: string[] = [];
	if (counts.needs > 0) parts.push(`${counts.needs} needs review`);
	if (counts.pinned > 0) parts.push(plural(counts.pinned, "pinned", "pinned"));
	if (parts.length > 0) return parts.join(" · ");
	if (counts.recent > 0) return `✓ all clear · ${plural(counts.recent, "recent item")}`;
	return "✓ all clear";
}

type EmptyTrailMessage = {
	title: string;
	body: string;
	actions: string[];
};

function emptyTrailMessage(state: NavigatorState, hasArtifacts: boolean): EmptyTrailMessage {
	if (!hasArtifacts) {
		return {
			title: "No session activity yet",
			body: "Trail fills as you work: commands, file changes, errors, answers, and checkpoints become browsable here.",
			actions: ["ask agent to inspect a file", "run a command", "load a checkpoint or worker"],
		};
	}
	if (state.mode === "work") {
		return {
			title: "All clear",
			body: "Trail will surface changed files, failures, pinned items, and worker output when they need review.",
			actions: ["press tab for memory", "press / to search", "pin useful items with p"],
		};
	}
	if (state.mode === "recall") {
		return {
			title: "No memories yet",
			body: "Memory stays quiet until assistant or worker answers exist for this source/filter.",
			actions: ["press tab for catalog", "press / to search", "cycle filters with f"],
		};
	}
	const filter = state.filter === "all" ? "" : `${kindLabel(state.filter)} `;
	return {
		title: `No ${filter}artifacts here`,
		body: "This view is filtered. Your activity may still exist in another source, kind, or mode.",
		actions: ["press f to change filter", "press s to switch source", "press w for review"],
	};
}

class TrailView implements Component {
	private container: Container | Box = new Container();
	private state: NavigatorState;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private showHelp = false;

	constructor(
		private tui: TUI,
		private theme: any,
		private artifacts: Artifact[],
		private pinnedRefs: Set<string>,
		private completedRefs: Set<string>,
		initialMode: NavigatorMode,
		private fullText: (artifact: Artifact) => string,
		private done: (result: TrailBrowserAction | null) => void,
	) {
		const sources = availableSources(artifacts);
		const source = sources.includes("all") ? "all" : sources.includes("current") ? "current" : sources[0] ?? "all";
		this.state = { ...initialNavigatorState(), source, mode: initialMode };
	}

	private decoratedArtifacts(): Artifact[] {
		return decorateTrailArtifacts(this.artifacts, this.pinnedRefs, this.completedRefs);
	}

	handleInput(data: string): void {
		const artifacts = this.decoratedArtifacts();
		if (data === "p") {
			const artifact = selectedArtifact(this.state, artifacts);
			if (artifact) {
				if (this.pinnedRefs.has(artifact.ref)) this.pinnedRefs.delete(artifact.ref);
				else this.pinnedRefs.add(artifact.ref);
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (data === "x") {
			const artifact = selectedArtifact(this.state, artifacts);
			if (artifact) {
				if (this.completedRefs.has(artifact.ref)) this.completedRefs.delete(artifact.ref);
				else {
					this.pinnedRefs.delete(artifact.ref);
					this.completedRefs.add(artifact.ref);
				}
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (data === "?") {
			this.showHelp = !this.showHelp;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		const current = selectedArtifact(this.state, artifacts);
		if ((data === "r" || matchesKey(data, Key.enter)) && isWorkerQuestionArtifact(current)) {
			this.done({ action: "replyWorker", artifact: current });
			return;
		}
		const key: NavigatorKey = {
			raw: data,
			isDown: matchesKey(data, Key.down),
			isUp: matchesKey(data, Key.up),
			isEnter: matchesKey(data, Key.enter),
			isTab: matchesKey(data, Key.tab),
			isEscape: matchesKey(data, Key.escape),
			isCtrlC: matchesKey(data, Key.ctrl("c")),
		};
		const transition = handleNavigatorKey(this.state, artifacts, key);
		this.state = transition.state;
		if (transition.action) this.finish(transition.action);
		this.invalidate();
		this.tui.requestRender();
	}

	private finish(action: NavigatorAction): void {
		if (action.action === "close") this.done(null);
		else this.done(action);
	}

	invalidate(): void {
		this.container.invalidate();
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const artifacts = this.decoratedArtifacts();
		this.container = new Box(2, 1, trailCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		const view = navigatorViewModel(this.state, artifacts, this.state.showDetail ? 7 : 12);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const outerBorder = (s: string) => this.theme.fg("border", s);
		const dividerBorder = (s: string) => this.theme.fg("borderMuted", s);

		const sel = view.selectedArtifact;
		const sources = availableSources(artifacts);
		const sourceLabel = this.state.source;
		const counts = bucketCounts(view.items);
		const headerLeft = ` ${accent(this.theme.bold("trail"))} ${dim("·")} ${accent(navigatorModeLabel(this.state.mode))} `;
		const headerRight = ` ${dim("Esc close")} `;
		this.container.addChild(new Text(fitBorder(headerLeft, headerRight, innerWidth, outerBorder, TOP_CORNERS), 0, 0));
		const position = view.items.length ? `${view.selected + 1}/${view.items.length}` : "";
		const status = [trailStatusLine(this.state.mode, view.items, artifacts), position].filter(Boolean).join(" · ");
		this.container.addChild(new Text(truncateToWidth(` ${muted(status)}`, innerWidth - 2), 1, 0));
		if (this.state.filter !== "all") this.container.addChild(new Text(`${muted("filter")} ${filterBar(this.theme, this.state.filter)}`, 1, 0));
		const sourceLine = sourceBar(this.theme, sources, sourceLabel);
		const defaultSource = sources.includes("all") ? "all" : sources[0];
		const sourceNarrowed = sources.length > 1 && sourceLabel !== defaultSource;
		if ((sourceNarrowed || this.showHelp) && sourceLine) this.container.addChild(new Text(`${muted("source")} ${sourceLine}`, 1, 0));
		this.container.addChild(new DynamicBorder(dividerBorder));

		const listWidth = Math.max(30, innerWidth);
		if (view.visible.length === 0) {
			const empty = emptyTrailMessage(this.state, artifacts.length > 0);
			const emptyWidth = Math.max(20, listWidth - 2);
			this.container.addChild(new Spacer(1));
			this.container.addChild(new Text(truncateToWidth(` ${accent(this.theme.bold(empty.title))}`, emptyWidth), 1, 0));
			this.container.addChild(new Text(truncateToWidth(` ${muted(empty.body)}`, emptyWidth), 1, 0));
			this.container.addChild(new Text(truncateToWidth(` ${dim(`Try: ${empty.actions.join(" · ")}`)}`, emptyWidth), 1, 0));
			this.container.addChild(new Spacer(1));
		} else {
			for (let i = 0; i < view.visible.length; i++) {
				const artifact = view.visible[i];
				if (!artifact) continue;
				const absolute = view.visibleStart + i;
				const selected = absolute === view.selected;
				const bucket = navigatorBucket(artifact);
				if (this.state.mode === "work") {
					const previousBucket = absolute > 0 ? navigatorBucket(view.items[absolute - 1]!) : undefined;
					if (bucket && bucket !== previousBucket) {
						const count = counts[bucket];
						const label = `${bucketName(bucket, this.state.mode)} ${count}`;
						this.container.addChild(new Text(` ${colorBucket(this.theme, bucket, this.state.mode, label)}`, 1, 0));
					}
				}
				const marker = selected ? "▸" : " ";
				const glyphText = bucketGlyph(bucket, this.state.mode);
				const provenance = artifact.source ? `from ${artifact.source}` : "current";
				const meta = [kindLabel(artifact.kind), provenance, relativeTime(artifact.timestamp), `@${artifact.id}`].filter(Boolean).join(" · ");
				if (selected) {
					const plainLine = `${marker} ${glyphText} ${artifact.title} ${meta}`;
					const row = padAnsi(truncateToWidth(plainLine, listWidth - 2), listWidth - 2);
					this.container.addChild(new Text(this.theme.bg("selectedBg", this.theme.fg("text", row)), 1, 0));
				} else {
					const glyph = colorBucket(this.theme, bucket, this.state.mode, glyphText);
					const title = muted(artifact.title);
					const line = `${dim(marker)} ${glyph} ${title} ${dim(meta)}`;
					const row = padAnsi(truncateToWidth(line, listWidth - 2), listWidth - 2);
					this.container.addChild(new Text(row, 1, 0));
				}
			}
		}

		if (sel) {
			const bucket = navigatorBucket(sel);
			const primary = trailMetaString(sel, "trailPrimaryAction") ?? trailPrimaryAction(sel);
			const focusMeta = [kindLabel(sel.kind), trailMetaString(sel, "trailReason"), sel.source ? `from ${sel.source}` : "current", relativeTime(sel.timestamp), `@${sel.id}`].filter(Boolean).join(" · ");
			this.container.addChild(new DynamicBorder(dividerBorder));
			this.container.addChild(new Text(truncateToWidth(`${accent(primary)} ${dim("·")} ${muted(sel.title)}`, listWidth - 2), 1, 0));
			if (focusMeta) this.container.addChild(new Text(truncateToWidth(dim(focusMeta), listWidth - 2), 1, 0));
			const hints = selectedActionHints(sel, this.pinnedRefs.has(sel.ref), this.completedRefs.has(sel.ref));
			this.container.addChild(new Text(truncateToWidth(hints.map((hint, index) => index === 0 ? accent(`[${hint}]`) : dim(hint)).join(" · "), listWidth - 2), 1, 0));
		}

		if (this.state.showDetail && view.selectedArtifact) {
			this.container.addChild(new DynamicBorder(dividerBorder));
			this.container.addChild(new Text(`${accent("preview")} ${muted(view.selectedArtifact.ref)}`, 1, 0));
			const detail = this.fullText(view.selectedArtifact).split("\n").slice(0, 14);
			for (const line of detail) this.container.addChild(new Text(truncateToWidth(dim(line), listWidth - 2), 1, 0));
		}

		this.container.addChild(new DynamicBorder(dividerBorder));
		const nextMode = this.state.mode === "work" ? "memory" : this.state.mode === "recall" ? "catalog" : "review";
		this.container.addChild(new Text(dim(`↑↓ move · Enter open · a attach · / search · tab ${nextMode} · ? help · Esc close`), 1, 0));
		if (this.showHelp) {
			this.container.addChild(new Text(`${muted("Modes")} ${modeBar(this.theme, this.state.mode)} ${dim("· w review · m memory · A catalog")}`, 1, 0));
			this.container.addChild(new Text(`${muted("Filters")} ${dim("f kind · s source")}`, 1, 0));
			this.container.addChild(new Text(`${muted("Actions")} ${dim("o open file · r/i attach aliases · I full · y copy · p pin · x done · c checkpoint · v preview")}`, 1, 0));
		}
		this.container.addChild(new Text(fitBorder("", "", innerWidth, outerBorder, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = this.container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

async function showTrailBrowser(
	ctx: ExtensionCommandContext,
	catalog: ArtifactCatalog,
	artifacts: Artifact[],
	pinnedRefs: Set<string>,
	completedRefs: Set<string>,
	initialMode: NavigatorMode = "work",
): Promise<TrailBrowserAction | null> {
	return ctx.ui.custom((tui, theme, _kb, done) => new TrailView(tui, theme, artifacts, pinnedRefs, completedRefs, initialMode, (artifact) => catalog.fullText(artifact), done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "88%", minWidth: 84, maxHeight: "90%", margin: 1 },
	});
}

function compactTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

class TrailResumeView implements Component {
	private container: Container | Box = new Container();
	private selected: number;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private tui: TUI,
		private theme: any,
		private summaries: CheckpointSummary[],
		initialSelected: number,
		private done: (result: ResumeSelection) => void,
		private mode: ResumeMode = "resume",
	) {
		this.selected = Math.min(Math.max(0, initialSelected), Math.max(0, summaries.length - 1));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
			this.done(null);
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) this.selected = Math.min(this.selected + 1, Math.max(0, this.summaries.length - 1));
		else if (data === "k" || matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (data === "g") this.selected = 0;
		else if (data === "G") this.selected = Math.max(0, this.summaries.length - 1);
		else if (matchesKey(data, Key.enter)) {
			const action: ResumeAction = this.mode === "delete" ? "delete" : this.mode === "load" ? "load" : "continue";
			this.finish(action);
		}
		else if (data === "p") this.finish("preview");
		else if (data === "e" && this.mode === "resume") this.finish("edit");
		else if (data === "d" && this.mode !== "load") this.finish("delete");
		this.invalidate();
		this.tui.requestRender();
	}

	private finish(action: ResumeAction): void {
		const summary = this.summaries[this.selected];
		if (summary) this.done({ action, summary, index: this.selected });
	}

	invalidate(): void {
		this.container.invalidate();
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.container = new Box(2, 1, trailCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const outerBorder = (s: string) => this.theme.fg("borderAccent", s);
		const dividerBorder = (s: string) => this.theme.fg("borderMuted", s);
		const listWidth = Math.max(30, innerWidth);
		const start = Math.max(0, Math.min(this.selected - 5, this.summaries.length - 11));
		const visible = this.summaries.slice(start, start + 11);

		const headerLeft = ` ${accent(this.theme.bold(`trail · ${this.mode}`))} ${dim(`${this.summaries.length} checkpoint${this.summaries.length === 1 ? "" : "s"}`)} `;
		this.container.addChild(new Text(fitBorder(headerLeft, "", innerWidth, outerBorder, TOP_CORNERS), 0, 0));
		for (let i = 0; i < visible.length; i++) {
			const summary = visible[i];
			if (!summary) continue;
			const absolute = start + i;
			const entry = summary.entry;
			const selected = absolute === this.selected;
			const marker = selected ? accent("▸") : dim(" ");
			const id = selected ? accent(this.theme.bold(entry.id.slice(0, 18).padEnd(18))) : muted(entry.id.slice(0, 18).padEnd(18));
			const mode = entry.consumeOnUse ? `${entry.mode}:once` : entry.mode;
			const stats = `${compactTokens(summary.estimatedTokens)} tok · ${summary.files} files · ${summary.errors} err · ${summary.commands} cmd`;
			const line = `${marker} ${id} ${accent(mode.padEnd(12))} ${dim(relativeTime(Date.parse(entry.createdAt)).padEnd(9))} ${stats} ${muted(entry.note ?? "")}`;
			this.container.addChild(new Text(truncateToWidth(line, listWidth - 2), 1, 0));
		}
		this.container.addChild(new DynamicBorder(dividerBorder));
		const help = this.mode === "delete"
			? "j/k move · enter delete · p preview · q close"
			: this.mode === "load"
				? "j/k move · enter load · p preview · q close"
				: "j/k move · enter continue · p preview · e edit · d delete · q close";
		this.container.addChild(new Text(dim(help), 1, 0));
		this.container.addChild(new Text(fitBorder("", "", innerWidth, outerBorder, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = this.container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

async function showCheckpointResumeSelector(ctx: ExtensionCommandContext, summaries: CheckpointSummary[], selected: number, mode: ResumeMode = "resume"): Promise<ResumeSelection> {
	return ctx.ui.custom((tui, theme, _kb, done) => new TrailResumeView(tui, theme, summaries, selected, done, mode), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "88%", minWidth: 84, maxHeight: "90%", margin: 1 },
	});
}

type WorkerDerivedState = "starting" | "thinking" | "stale" | "needs_input" | "ready" | "empty" | "failed" | "idle";

type ParallelKindFilter = ArtifactKind | "all";
type ParallelSource = "all" | string;

type ParallelWorkEntry = {
	worker: WorkerStatus;
	artifact: Artifact;
};

type ParallelWorkAction =
	| { action: "peek"; entry: ParallelWorkEntry }
	| { action: "load" | "attach" | "recall"; worker: WorkerStatus }
	| null;

const PARALLEL_KIND_FILTERS: ParallelKindFilter[] = ["all", "error", "response", "file", "command", "checkpoint", "code", "prompt"];

function workerDerivedState(worker: WorkerStatus, now = Date.now()): WorkerDerivedState {
	if (worker.state === "needs_input") return "needs_input";
	if (worker.state === "failed" || worker.state === "error") return "failed";
	if (worker.state === "ready") return "ready";
	if (worker.state === "ended") return (worker.artifactCount ?? 0) > 0 ? "ready" : "empty";
	const ageMs = now - Date.parse(worker.updatedAt);
	if (Number.isFinite(ageMs) && ageMs > 90_000) return "stale";
	if (worker.state === "active") return "thinking";
	if (worker.state === "starting") return "starting";
	if (worker.state === "idle") return "idle";
	return "idle";
}

function workerStateGlyph(state: WorkerDerivedState): string {
	if (state === "starting") return "◌";
	if (state === "thinking") return "◐";
	if (state === "needs_input") return "?";
	if (state === "stale") return "◯";
	if (state === "ready") return "✓";
	if (state === "failed") return "!";
	if (state === "empty") return "□";
	return "○";
}

function workerStateColor(theme: any, state: WorkerDerivedState, text: string): string {
	if (state === "needs_input") return theme.fg("warning", text);
	if (state === "ready") return theme.fg("success", text);
	if (state === "failed") return theme.fg("error", text);
	if (state === "starting" || state === "thinking") return theme.fg("accent", text);
	return theme.fg("muted", text);
}

function workerStateRank(worker: WorkerStatus): number {
	const state = workerDerivedState(worker);
	if (state === "needs_input") return 0;
	if (state === "failed") return 1;
	if (state === "ready") return 2;
	if (state === "thinking") return 3;
	if (state === "starting") return 4;
	if (state === "stale") return 5;
	return 6;
}

function artifactInboxRank(kind: ArtifactKind): number {
	if (kind === "error") return 0;
	if (kind === "response") return 1;
	if (kind === "checkpoint") return 2;
	if (kind === "file") return 3;
	if (kind === "command") return 4;
	if (kind === "code") return 5;
	if (kind === "prompt") return 6;
	return 7;
}

function parallelKindLabel(kind: ArtifactKind): string {
	return kind === "response" ? "answer" : kindLabel(kind);
}

function parallelKindGlyph(kind: ArtifactKind): string {
	if (kind === "error") return "!";
	if (kind === "response") return "✦";
	if (kind === "file") return "f";
	if (kind === "command") return "$";
	if (kind === "checkpoint") return "◆";
	if (kind === "code") return "{}";
	return "·";
}

function workerSourceLabel(worker: WorkerStatus): string {
	return workerShortLabel(worker.index);
}

function workerDisplayName(worker: WorkerStatus, max = 34): string {
	return workerSummaryName(worker, max);
}

function workerAttentionLabel(worker: WorkerStatus): string {
	const state = workerDerivedState(worker);
	const label = workerSourceLabel(worker);
	if (state === "needs_input") return `? ${label} needs input`;
	if (state === "failed") return `! ${label} failed`;
	if (state === "ready") return `✓ ${label} ready`;
	if (state === "stale") return `◯ ${label} stale`;
	if (state === "empty") return `□ ${label} done`;
	return `${workerStateGlyph(state)} ${label} ${workerDisplayName(worker, 28)}`;
}

function workerStatusArtifact(worker: WorkerStatus): Artifact | undefined {
	const state = workerDerivedState(worker);
	if (state !== "needs_input" && state !== "ready" && state !== "failed") return undefined;
	const label = workerSourceLabel(worker);
	const text = state === "needs_input" ? worker.question : state === "ready" ? worker.summary : worker.lastError;
	const title = state === "needs_input"
		? `${label} needs input${text ? `: ${text}` : ""}`
		: state === "ready"
			? `${label} ready${text ? `: ${text}` : ""}`
			: `${label} failed${text ? `: ${text}` : ""}`;
	return {
		id: "status",
		displayId: "status",
		ref: `worker-status:${worker.id}:0`,
		kind: state === "failed" ? "error" : "response",
		title,
		subtitle: workerDisplayName(worker),
		body: [`worker: ${label}`, `state: ${state}`, `task: ${worker.task}`, text ? `message: ${text}` : undefined].filter((line): line is string => line !== undefined).join("\n"),
		timestamp: Date.parse(worker.updatedAt),
		meta: { workerId: worker.id, workerLabel: label, workerStatus: state, question: worker.question, summary: worker.summary, lastError: worker.lastError },
	};
}

async function readWorkerArtifactsForReview(worker: WorkerStatus): Promise<Artifact[]> {
	const artifacts = await createWorkerStore().readArtifacts(worker.id);
	const status = workerStatusArtifact(worker);
	return status ? [status, ...artifacts.filter((artifact) => artifact.ref !== status.ref)] : artifacts;
}

function namespaceWorkerArtifacts(worker: WorkerStatus, artifacts: Artifact[]): Artifact[] {
	const slot = workerSourceLabel(worker);
	return artifacts.map((artifact) => ({ ...artifact, id: `${slot}.${artifact.displayId}`, displayId: `${slot}.${artifact.displayId}`, source: slot }));
}

function parallelEntries(workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]>, source: ParallelSource, filter: ParallelKindFilter, dismissed: Set<string>): ParallelWorkEntry[] {
	const entries: ParallelWorkEntry[] = [];
	for (const worker of workers) {
		if (source !== "all" && source !== worker.id) continue;
		for (const artifact of namespaceWorkerArtifacts(worker, artifactsByWorker.get(worker.id) ?? [])) {
			if (filter !== "all" && artifact.kind !== filter) continue;
			if (dismissed.has(`${worker.id}:${artifact.ref}`)) continue;
			entries.push({ worker, artifact });
		}
	}
	return entries.sort((a, b) => {
		const rank = artifactInboxRank(a.artifact.kind) - artifactInboxRank(b.artifact.kind);
		if (rank !== 0) return rank;
		return (b.artifact.timestamp ?? Date.parse(b.worker.updatedAt)) - (a.artifact.timestamp ?? Date.parse(a.worker.updatedAt));
	});
}

async function readWorkersWithArtifacts(store = createWorkerStore()): Promise<{ workers: WorkerStatus[]; artifactsByWorker: Map<string, Artifact[]> }> {
	const workers = await store.list();
	const artifactsByWorker = new Map<string, Artifact[]>();
	await Promise.all(workers.map(async (worker) => {
		artifactsByWorker.set(worker.id, await readWorkerArtifactsForReview(worker));
	}));
	return { workers, artifactsByWorker };
}

function renderParallelWorkList(workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]>): string {
	const entries = parallelEntries(workers, artifactsByWorker, "all", "all", new Set());
	if (workers.length === 0) return "No Trail workers";
	const header = `${workers.length} workers · ${entries.length} artifacts`;
	const lines = entries.slice(0, 20).map((entry) => `${workerSourceLabel(entry.worker)}\t${entry.artifact.kind}\t${entry.artifact.displayId}\t${entry.artifact.title}`);
	return [header, ...lines].join("\n");
}

class TrailParallelWorkView implements Component {
	private container: Container | Box = new Container();
	private selected = 0;
	private source: ParallelSource = "all";
	private filter: ParallelKindFilter = "all";
	private showHelp = false;
	private dismissed = new Set<string>();
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private tui: TUI,
		private theme: any,
		private workers: WorkerStatus[],
		private artifactsByWorker: Map<string, Artifact[]>,
		private done: (result: ParallelWorkAction) => void,
	) {}

	private entries(): ParallelWorkEntry[] {
		return parallelEntries(this.workers, this.artifactsByWorker, this.source, this.filter, this.dismissed);
	}

	private selectedEntry(): ParallelWorkEntry | undefined {
		return this.entries()[this.selected];
	}

	private selectedWorker(): WorkerStatus | undefined {
		return this.selectedEntry()?.worker ?? this.workers.find((worker) => worker.id === this.source);
	}

	private cycleSource(): void {
		const sources: ParallelSource[] = ["all", ...this.workers.map((worker) => worker.id)];
		const idx = sources.indexOf(this.source);
		this.source = sources[(idx + 1) % sources.length] ?? "all";
		this.selected = 0;
	}

	private cycleFilter(): void {
		const idx = PARALLEL_KIND_FILTERS.indexOf(this.filter);
		this.filter = PARALLEL_KIND_FILTERS[(idx + 1) % PARALLEL_KIND_FILTERS.length] ?? "all";
		this.selected = 0;
	}

	handleInput(data: string): void {
		const entries = this.entries();
		const max = Math.max(0, entries.length - 1);
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
			this.done(null);
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) this.selected = Math.min(max, this.selected + 1);
		else if (data === "k" || matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (data === "g") this.selected = 0;
		else if (data === "G") this.selected = max;
		else if (matchesKey(data, Key.tab)) this.cycleSource();
		else if (data === "f") this.cycleFilter();
		else if (data === "?") this.showHelp = !this.showHelp;
		else if (data === "x") {
			const entry = this.selectedEntry();
			if (entry) this.dismissed.add(`${entry.worker.id}:${entry.artifact.ref}`);
			this.selected = Math.min(this.selected, Math.max(0, this.entries().length - 1));
		}
		else if (matchesKey(data, Key.enter)) {
			const entry = this.selectedEntry();
			if (entry) this.done({ action: "peek", entry });
			return;
		}
		else if (data === "l") {
			const worker = this.selectedWorker();
			if (worker) this.done({ action: "load", worker });
			return;
		}
		else if (data === "a") {
			const worker = this.selectedWorker();
			if (worker) this.done({ action: "attach", worker });
			return;
		}
		else if (data === "r") {
			const worker = this.selectedWorker();
			if (worker) this.done({ action: "recall", worker });
			return;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.container.invalidate();
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.container = new Box(2, 1, trailCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		const listWidth = Math.max(30, innerWidth);
		const entries = this.entries();
		this.selected = Math.min(this.selected, Math.max(0, entries.length - 1));
		const selected = entries[this.selected];
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const border = (s: string) => this.theme.fg("border", s);
		const divider = (s: string) => this.theme.fg("borderMuted", s);
		const workerCounts = this.workers.reduce((acc, worker) => {
			const state = workerDerivedState(worker);
			if (state === "thinking" || state === "starting") acc.active++;
			if (state === "needs_input") acc.waiting++;
			if (state === "ready") acc.ready++;
			if (state === "failed") acc.failed++;
			return acc;
		}, { active: 0, waiting: 0, ready: 0, failed: 0 });
		const status = [
			workerCounts.waiting ? `${workerCounts.waiting} waiting` : undefined,
			workerCounts.failed ? `${workerCounts.failed} failed` : undefined,
			workerCounts.ready ? `${workerCounts.ready} ready` : undefined,
			workerCounts.active ? `${workerCounts.active} active` : undefined,
		].filter(Boolean).join(" · ") || plural(this.workers.length, "worker");

		this.container.addChild(new Text(fitBorder(` ${accent(this.theme.bold("trail"))} ${dim("·")} ${accent("workers")} `, ` ${dim("Esc close")} `, innerWidth, border, TOP_CORNERS), 0, 0));
		this.container.addChild(new Text(truncateToWidth(` ${muted(status)} ${dim(entries.length ? `· ${entries.length} items` : "")}`, innerWidth - 2), 1, 0));
		if (this.source !== "all" || this.showHelp) this.container.addChild(new Text(`${muted("workers")} ${this.renderWorkerPills(innerWidth - 10)}`, 1, 0));
		if (this.filter !== "all" || this.showHelp) this.container.addChild(new Text(`${muted("filter")}  ${activePill(this.theme, this.filter === "response" ? "answer" : this.filter)} ${dim("f kind · tab worker")}`, 1, 0));
		this.container.addChild(new DynamicBorder(divider));

		if (entries.length === 0) {
			const title = this.workers.length === 0 ? "No parallel work yet" : "No artifacts in this view";
			const body = this.workers.length === 0
				? "Spawn a side investigation when you want evidence without interrupting current flow."
				: "Workers may still be starting, or this worker/kind filter has no matching artifacts yet.";
			this.container.addChild(new Spacer(1));
			this.container.addChild(new Text(fitBorder(` ${accent(this.theme.bold(title))} `, "", listWidth - 2, divider, TOP_CORNERS), 1, 0));
			this.container.addChild(new Text(truncateToWidth(` ${muted(body)}`, listWidth - 2), 1, 0));
			this.container.addChild(new Text(truncateToWidth(` ${dim("Try: /trail spawn <task> · f filter · tab worker")}`, listWidth - 2), 1, 0));
			this.container.addChild(new Text(fitBorder("", "", listWidth - 2, divider, BOTTOM_CORNERS), 1, 0));
			this.container.addChild(new Spacer(1));
		} else {
			const visible = entries.slice(Math.max(0, this.selected - 5), Math.max(0, this.selected - 5) + 11);
			const start = entries.indexOf(visible[0]!);
			for (let i = 0; i < visible.length; i++) {
				const entry = visible[i];
				if (!entry) continue;
				const absolute = start + i;
				const isSelected = absolute === this.selected;
				const workerLabel = workerSourceLabel(entry.worker).padEnd(4);
				const kind = parallelKindLabel(entry.artifact.kind).padEnd(8);
				const age = relativeTime(entry.artifact.timestamp ?? Date.parse(entry.worker.updatedAt));
				const plain = `${isSelected ? "▸" : " "} ${parallelKindGlyph(entry.artifact.kind)} ${workerLabel} ${kind} ${entry.artifact.title} ${age}`;
				if (isSelected) {
					this.container.addChild(new Text(this.theme.bg("selectedBg", this.theme.fg("text", padAnsi(truncateToWidth(plain, listWidth - 2), listWidth - 2))), 1, 0));
				} else {
					const marker = dim(" ");
					const glyph = entry.artifact.kind === "error" ? this.theme.fg("error", "!") : colorKind(this.theme, entry.artifact.kind, parallelKindGlyph(entry.artifact.kind));
					const line = `${marker} ${glyph} ${muted(workerLabel)} ${colorKind(this.theme, entry.artifact.kind, kind)} ${muted(entry.artifact.title)} ${dim(age)}`;
					this.container.addChild(new Text(truncateToWidth(line, listWidth - 2), 1, 0));
				}
			}
		}

		if (selected) {
			this.container.addChild(new DynamicBorder(divider));
			this.container.addChild(new Text(`${muted(workerSourceLabel(selected.worker))} ${dim("·")} ${colorKind(this.theme, selected.artifact.kind, parallelKindLabel(selected.artifact.kind))}`, 1, 0));
			this.container.addChild(new Text(truncateToWidth(this.theme.bold(this.theme.fg("text", selected.artifact.title)), listWidth - 2), 1, 0));
			this.container.addChild(new Text(truncateToWidth(dim(`${workerDisplayName(selected.worker)} · ${workerAge(selected.worker.updatedAt)}`), listWidth - 2), 1, 0));
			const actions = `${accent("[Enter open]")} ${dim("· l review in trail · r memory · x dismiss")}`;
			this.container.addChild(new Text(truncateToWidth(actions, listWidth - 2), 1, 0));
		}

		this.container.addChild(new DynamicBorder(divider));
		this.container.addChild(new Text(dim("↑↓ move · Enter open · l review in trail · r memory · f filter · ? help · Esc close"), 1, 0));
		if (this.showHelp) {
			this.container.addChild(new Text(`${muted("Worker debug")} ${dim("a copy tmux attach command · tab worker · g/G top/bottom")}`, 1, 0));
			this.container.addChild(new Text(`${muted("Safety")} ${dim("reviewing workers mounts artifacts only; nothing enters context until attached")}`, 1, 0));
		}
		this.container.addChild(new Text(fitBorder("", "", innerWidth, border, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = this.container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	private renderWorkerPills(maxWidth: number): string {
		const parts = [this.source === "all" ? activePill(this.theme, "all") : inactivePill(this.theme, "all")];
		const sorted = [...this.workers].sort((a, b) => workerStateRank(a) - workerStateRank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
		for (const worker of sorted) {
			const state = workerDerivedState(worker);
			const label = workerAttentionLabel(worker);
			parts.push(this.source === worker.id ? activePill(this.theme, label) : workerStateColor(this.theme, state, ` ${label} `));
		}
		return truncateToWidth(parts.join(" "), maxWidth);
	}
}

async function showParallelWorkDashboard(ctx: ExtensionCommandContext, workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]>): Promise<ParallelWorkAction> {
	return ctx.ui.custom((tui, theme, _kb, done) => new TrailParallelWorkView(tui, theme, workers, artifactsByWorker, done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "88%", minWidth: 84, maxHeight: "90%", margin: 1 },
	});
}

type LoadPickerMode = "checkpoint" | "worker";
type LoadPickerSelection =
	| { kind: "checkpoint"; action: "load" | "preview"; summary: CheckpointSummary }
	| { kind: "worker"; action: "load"; worker: WorkerStatus }
	| null;

class TrailLoadPicker implements Component {
	private container: Container | Box = new Container();
	private mode: LoadPickerMode;
	private checkpointIndex = 0;
	private workerIndex = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private tui: TUI,
		private theme: any,
		private checkpoints: CheckpointSummary[],
		private workers: WorkerStatus[],
		initialMode: LoadPickerMode,
		private done: (result: LoadPickerSelection) => void,
	) {
		this.mode = this.canonicalMode(initialMode);
		this.checkpointIndex = Math.max(0, this.checkpoints.length - 1);
		this.workerIndex = Math.max(0, this.workers.length - 1);
	}

	private canonicalMode(requested: LoadPickerMode): LoadPickerMode {
		if (requested === "worker" && this.workers.length === 0 && this.checkpoints.length > 0) return "checkpoint";
		if (requested === "checkpoint" && this.checkpoints.length === 0 && this.workers.length > 0) return "worker";
		return requested;
	}

	private currentMax(): number {
		return Math.max(0, (this.mode === "checkpoint" ? this.checkpoints.length : this.workers.length) - 1);
	}

	private currentIndex(): number {
		return this.mode === "checkpoint" ? this.checkpointIndex : this.workerIndex;
	}

	private setIndex(value: number): void {
		const max = this.currentMax();
		const clamped = Math.max(0, Math.min(value, max));
		if (this.mode === "checkpoint") this.checkpointIndex = clamped;
		else this.workerIndex = clamped;
	}

	private toggleMode(target?: LoadPickerMode): void {
		const next = target ?? (this.mode === "checkpoint" ? "worker" : "checkpoint");
		if (next === "checkpoint" && this.checkpoints.length === 0) return;
		if (next === "worker" && this.workers.length === 0) return;
		this.mode = next;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
			this.done(null);
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) this.setIndex(this.currentIndex() + 1);
		else if (data === "k" || matchesKey(data, Key.up)) this.setIndex(this.currentIndex() - 1);
		else if (data === "g") this.setIndex(0);
		else if (data === "G") this.setIndex(this.currentMax());
		else if (matchesKey(data, Key.tab)) this.toggleMode();
		else if (data === "1") this.toggleMode("checkpoint");
		else if (data === "2") this.toggleMode("worker");
		else if (matchesKey(data, Key.enter)) this.finishLoad();
		else if (data === "p" && this.mode === "checkpoint") this.finishPreview();
		this.invalidate();
		this.tui.requestRender();
	}

	private finishLoad(): void {
		if (this.mode === "checkpoint") {
			const summary = this.checkpoints[this.checkpointIndex];
			if (summary) this.done({ kind: "checkpoint", action: "load", summary });
			return;
		}
		const worker = this.workers[this.workerIndex];
		if (worker) this.done({ kind: "worker", action: "load", worker });
	}

	private finishPreview(): void {
		const summary = this.checkpoints[this.checkpointIndex];
		if (summary) this.done({ kind: "checkpoint", action: "preview", summary });
	}

	invalidate(): void {
		this.container.invalidate();
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.container = new Box(2, 1, trailCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const outerBorder = (s: string) => this.theme.fg("borderAccent", s);
		const dividerBorder = (s: string) => this.theme.fg("borderMuted", s);

		const headerLeft = ` ${accent(this.theme.bold("trail · load"))} ${dim("pick a source")} `;
		this.container.addChild(new Text(fitBorder(headerLeft, "", innerWidth, outerBorder, TOP_CORNERS), 0, 0));

		const tabCk = `[1] checkpoints (${this.checkpoints.length})`;
		const tabWk = `[2] workers (${this.workers.length})`;
		const tabLine = `${this.mode === "checkpoint" ? accent(this.theme.bold(tabCk)) : muted(tabCk)}    ${this.mode === "worker" ? accent(this.theme.bold(tabWk)) : muted(tabWk)}`;
		this.container.addChild(new Text(tabLine, 1, 0));
		this.container.addChild(new DynamicBorder(dividerBorder));

		const listWidth = Math.max(30, innerWidth);
		if (this.mode === "checkpoint") this.renderCheckpoints(listWidth, accent, dim, muted);
		else this.renderWorkers(listWidth, accent, dim, muted);

		this.container.addChild(new DynamicBorder(dividerBorder));
		const help = this.mode === "checkpoint"
			? "j/k move · tab/1/2 switch · enter load · p preview · q close"
			: "j/k move · tab/1/2 switch · enter load · q close";
		this.container.addChild(new Text(dim(help), 1, 0));
		this.container.addChild(new Text(fitBorder("", "", innerWidth, outerBorder, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = this.container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	private renderCheckpoints(listWidth: number, accent: (s: string) => string, dim: (s: string) => string, muted: (s: string) => string): void {
		if (this.checkpoints.length === 0) {
			this.container.addChild(new Text(muted("no checkpoints — press 2 for workers"), 2, 0));
			return;
		}
		const start = Math.max(0, Math.min(this.checkpointIndex - 5, this.checkpoints.length - 11));
		const visible = this.checkpoints.slice(start, start + 11);
		for (let i = 0; i < visible.length; i++) {
			const summary = visible[i];
			if (!summary) continue;
			const absolute = start + i;
			const entry = summary.entry;
			const selected = absolute === this.checkpointIndex;
			const marker = selected ? accent("▸") : dim(" ");
			const id = selected ? accent(this.theme.bold(entry.id.slice(0, 18).padEnd(18))) : muted(entry.id.slice(0, 18).padEnd(18));
			const mode = entry.consumedAt ? `${entry.mode}:consumed` : entry.consumeOnUse ? `${entry.mode}:once` : entry.mode;
			const stats = `${compactTokens(summary.estimatedTokens)} tok · ${summary.files} files`;
			const line = `${marker} ${id} ${accent(mode.padEnd(14))} ${dim(relativeTime(Date.parse(entry.createdAt)).padEnd(9))} ${stats} ${muted(entry.note ?? "")}`;
			this.container.addChild(new Text(truncateToWidth(line, listWidth - 2), 1, 0));
		}
	}

	private renderWorkers(listWidth: number, accent: (s: string) => string, dim: (s: string) => string, muted: (s: string) => string): void {
		if (this.workers.length === 0) {
			this.container.addChild(new Text(muted("no workers — /trail spawn <task>, then 2"), 2, 0));
			return;
		}
		const start = Math.max(0, Math.min(this.workerIndex - 5, this.workers.length - 11));
		const visible = this.workers.slice(start, start + 11);
		for (let i = 0; i < visible.length; i++) {
			const worker = visible[i];
			if (!worker) continue;
			const absolute = start + i;
			const selected = absolute === this.workerIndex;
			const marker = selected ? accent("▸") : dim(" ");
			const label = workerShortLabel(worker.index).padEnd(4);
			const id = selected ? accent(this.theme.bold(label)) : muted(label);
			const stateColor = worker.state === "active" ? "success" : worker.state === "error" ? "error" : "muted";
			const state = this.theme.fg(stateColor, (worker.state ?? "?").padEnd(8));
			const artifacts = `${worker.artifactCount ?? "?"} art`.padEnd(8);
			const age = workerAge(worker.updatedAt).padEnd(8);
			const summary = workerSummaryName(worker, 48);
			const line = `${marker} ${id} ${state} ${dim(artifacts)} ${dim(age)} ${selected ? this.theme.bold(this.theme.fg("text", summary)) : muted(summary)}`;
			this.container.addChild(new Text(truncateToWidth(line, listWidth - 2), 1, 0));
		}
	}
}

async function showLoadPicker(ctx: ExtensionCommandContext, checkpoints: CheckpointSummary[], workers: WorkerStatus[], initialMode: LoadPickerMode): Promise<LoadPickerSelection> {
	return ctx.ui.custom<LoadPickerSelection>((tui, theme, _kb, done) => new TrailLoadPicker(tui, theme, checkpoints, workers, initialMode, done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "88%", minWidth: 84, maxHeight: "90%", margin: 1 },
	});
}

function renderArtifactList(artifacts: Artifact[]): string {
	if (artifacts.length === 0) return "No Trail artifacts";
	return artifacts.map((a) => `${a.displayId}\t${a.ref}\t${a.kind}\t${a.title}\t${a.subtitle}`).join("\n");
}

const TRAIL_CHECKPOINT_CONTEXT_TYPE = "trail:checkpoint-context";
const TRAIL_CHECKPOINT_WIDGET_ID = "trail-loaded-checkpoint";

type LoadedCheckpoint = {
	id: string;
	mode: CheckpointIndexEntry["mode"];
	note?: string;
	consumeOnUse?: boolean;
};

function checkpointContextContent(checkpoint: CheckpointIndexEntry, content: string): string {
	return [`<<trail-checkpoint ${checkpoint.id}>>`, content.trim(), `<</trail-checkpoint>>`].join("\n");
}

function loadedCheckpointMeta(checkpoint: CheckpointIndexEntry): LoadedCheckpoint {
	return { id: checkpoint.id, mode: checkpoint.mode, note: checkpoint.note, consumeOnUse: checkpoint.consumeOnUse };
}

function loadedCheckpointFromSession(ctx: ExtensionContext): LoadedCheckpoint | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as any;
		if (entry?.type !== "custom_message" || entry.customType !== TRAIL_CHECKPOINT_CONTEXT_TYPE) continue;
		const details = entry.details as Partial<LoadedCheckpoint> | undefined;
		if (typeof details?.id === "string" && typeof details.mode === "string") return details as LoadedCheckpoint;
	}
	return undefined;
}

function setLoadedCheckpointWidget(ctx: ExtensionContext, checkpoint: LoadedCheckpoint | undefined): void {
	if (!ctx.hasUI) return;
	if (!checkpoint) {
		ctx.ui.setWidget(TRAIL_CHECKPOINT_WIDGET_ID, undefined);
		return;
	}
	ctx.ui.setWidget(
		TRAIL_CHECKPOINT_WIDGET_ID,
		(_tui, theme) => {
			const accent = (s: string) => theme.fg("accent", s);
			const dim = (s: string) => theme.fg("dim", s);
			const muted = (s: string) => theme.fg("muted", s);
			const once = checkpoint.consumeOnUse ? muted("/once") : "";
			const note = checkpoint.note ? dim(` · ${truncateToWidth(checkpoint.note, 48)}`) : "";
			const container = new Container();
			container.addChild(new Text(`${accent(theme.bold("trail"))} ${dim("·")} ${accent(`@ckpt:${checkpoint.id}`)}${muted(`/${checkpoint.mode}`)}${once} ${dim("loaded in context")}${note}`, 0, 0));
			return container;
		},
		{ placement: "aboveEditor" },
	);
}

async function startCheckpointSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	checkpoint: CheckpointIndexEntry,
	content: string,
	queueConsume: (checkpoint: CheckpointIndexEntry) => void,
): Promise<void> {
	const parentSession = ctx.sessionManager.getSessionFile();
	const checkpointMeta = loadedCheckpointMeta(checkpoint);
	const result = await ctx.newSession({
		parentSession,
		setup: async (sessionManager) => {
			sessionManager.appendCustomMessageEntry(TRAIL_CHECKPOINT_CONTEXT_TYPE, checkpointContextContent(checkpoint, content), false, checkpointMeta);
		},
		withSession: async (replacementCtx) => {
			setLoadedCheckpointWidget(replacementCtx, checkpointMeta);
			if (checkpoint.consumeOnUse) {
				queueConsume(checkpoint);
				replacementCtx.ui.notify(`Trail loaded checkpoint ${checkpoint.id} (consume on session end)`, "info");
			} else {
				replacementCtx.ui.notify(`Trail loaded checkpoint ${checkpoint.id}`, "info");
			}
		},
	});
	if (result.cancelled) notifyTrail(pi, ctx, "Trail continue cancelled", "info");
}

async function confirmDeleteCheckpoint(ctx: ExtensionCommandContext, checkpoint: CheckpointIndexEntry): Promise<boolean> {
	if (!ctx.hasUI) return true;
	return ctx.ui.confirm("Delete Trail checkpoint?", `Delete checkpoint ${checkpoint.id}? This cannot be undone.`);
}

type QueueConsume = (checkpoint: CheckpointIndexEntry) => void;

type CompletionCandidate = { value: string; label: string };

async function checkpointAndWorkerCandidates(subcommand: string): Promise<CompletionCandidate[]> {
	const wantWorkers = subcommand === "load" || subcommand === "unload" || subcommand === "delete";
	const wantCheckpoints = subcommand !== "unload"; // unload also accepts checkpoints, but keep both for everyone
	const out: CompletionCandidate[] = [];

	if (wantCheckpoints) {
		try {
			const store = createCheckpointStore();
			const list = await store.list({ includeConsumed: true });
			const recent = list.slice(-10).reverse();
			if (recent.length > 0) out.push({ value: "last", label: `last → ${recent[0]!.id}` });
			for (const entry of recent) {
				const tag = entry.consumedAt ? ":consumed" : entry.consumeOnUse ? ":once" : "";
				out.push({ value: entry.id, label: `${entry.id}  ${entry.mode}${tag}  ${entry.note ?? ""}`.trim() });
			}
		} catch { /* ignore */ }
	}

	if (wantWorkers) out.push(...await workerCompletionCandidates(createWorkerStore()));

	if (subcommand === "unload") out.unshift({ value: "all", label: "all  drop every loaded slot" });

	return out;
}

type TrailMessageKind = "help" | "list" | "notice" | "action" | "success" | "warning" | "error" | "usage";

type TrailMessageDetails = { kind: TrailMessageKind; heading?: string; subject?: string };

const KIND_GLYPH: Record<TrailMessageKind, string> = {
	help: "?",
	list: "≡",
	notice: "·",
	action: "▸",
	success: "✓",
	warning: "!",
	error: "✗",
	usage: "?",
};

const KIND_COLOR: Record<TrailMessageKind, ThemeColor> = {
	help: "accent",
	list: "customMessageLabel",
	notice: "muted",
	action: "accent",
	success: "success",
	warning: "warning",
	usage: "warning",
	error: "error",
};

function emitText(pi: ExtensionAPI, _ctx: ExtensionCommandContext, text: string, kind: TrailMessageKind = "notice", heading?: string, subject?: string): void {
	pi.sendMessage(
		{ customType: "trail", content: text, display: true, details: { kind, heading, subject } satisfies TrailMessageDetails },
		{ triggerTurn: false },
	);
}

function notifyTrail(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else pi.sendMessage({ customType: "trail", content: text, display: true, details: { kind: level === "error" ? "error" : "notice" } satisfies TrailMessageDetails }, { triggerTurn: false });
}

function announceAction(pi: ExtensionAPI, _ctx: ExtensionCommandContext, subject: string, detail?: string, kind: TrailMessageKind = "action"): void {
	pi.sendMessage(
		{
			customType: "trail",
			content: detail ?? "",
			display: true,
			details: { kind, subject, heading: `trail · ${kind}` } satisfies TrailMessageDetails,
		},
		{ triggerTurn: false },
	);
}

function trailMessageRenderer(): MessageRenderer<TrailMessageDetails> {
	return (message, _options, theme) => {
		const details = (message.details ?? { kind: "notice" }) as TrailMessageDetails;
		const kind = details.kind ?? "notice";
		const labelColor: ThemeColor = KIND_COLOR[kind] ?? "muted";
		const glyph = KIND_GLYPH[kind] ?? "·";
		const headingText = details.heading ?? `trail · ${kind}`;
		const subject = details.subject;
		const content = typeof message.content === "string" ? message.content : "";
		const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));

		const accent = (s: string) => theme.fg(labelColor, s);
		const dim = (s: string) => theme.fg("dim", s);
		const muted = (s: string) => theme.fg("muted", s);

		const headerLine = `${accent(theme.bold(`${glyph} ${headingText}`))}`;
		box.addChild(new Text(headerLine, 0, 0));

		if (subject) {
			box.addChild(new Text(theme.bold(theme.fg("text", subject)), 0, 0));
		}

		if (content) {
			if (subject) box.addChild(new Text("", 0, 0));
			for (const rawLine of content.split("\n")) {
				let line: string;
				if (kind === "error") line = theme.fg("error", rawLine);
				else if (kind === "warning") line = theme.fg("warning", rawLine);
				else if (kind === "action" || kind === "success") line = muted(rawLine);
				else if (kind === "list") line = rawLine;
				else line = dim(rawLine);
				box.addChild(new Text(line, 0, 0));
			}
		}
		return box;
	};
}

export default function trailExtension(pi: ExtensionAPI) {
	let loadedCheckpoint: LoadedCheckpoint | undefined;
	let activeCtx: ExtensionContext | undefined;
	let sweptOnce = false;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	let workerDockTimer: NodeJS.Timeout | undefined;
	let pinnedRefs = new Set<string>();
	let completedRefs = new Set<string>();
	const loadedArtifacts = createLoadedArtifactContext({
		readCheckpointArtifacts: async (checkpoint) => createCheckpointStore().readArtifacts(checkpoint),
		readWorkerArtifacts: readWorkerArtifactsForReview,
	});

	const queueShutdownConsume: QueueConsume = (checkpoint) => loadedArtifacts.queueCheckpointConsume(checkpoint);

	const drainShutdownConsume = async (): Promise<void> => {
		const store = createCheckpointStore();
		await loadedArtifacts.drainCheckpointConsumes((checkpoint) => store.markConsumed(checkpoint));
	};

	const maybeSweep = async (cwd: string): Promise<void> => {
		if (sweptOnce) return;
		sweptOnce = true;
		try {
			const config = await loadConfig(cwd);
			await createCheckpointStore().sweepConsumed(config.consumedRetentionDays);
		} catch { /* best-effort */ }
	};

	const refreshChipWidget = (): void => {
		const ctx = activeCtx;
		if (!ctx?.hasUI) return;
		const snapshot = loadedArtifacts.chips();
		if (snapshot.length === 0) {
			ctx.ui.setWidget("trail-chips", undefined);
			return;
		}
		ctx.ui.setWidget(
			"trail-chips",
			(_tui, theme) => {
				const accent = (s: string) => theme.fg("accent", s);
				const dim = (s: string) => theme.fg("dim", s);
				const muted = (s: string) => theme.fg("muted", s);
				const tags = snapshot
					.map((c) => `${accent(`@${c.displayId}${c.mode === "full" ? "*" : ""}`)}${muted(`/${kindLabel(c.kind)}`)}`)
					.join(" ");
				const label = accent(theme.bold("trail"));
				const summary = dim(`${snapshot.length === 1 ? "attached" : `${snapshot.length} attached`} · expands on send · /trail clear`);
				const container = new Container();
				container.addChild(new Text(`${label} ${dim("·")} ${tags}  ${summary}`, 0, 0));
				return container;
			},
			{ placement: "aboveEditor" },
		);
	};


	const announceChipChange = (ctx: ExtensionCommandContext, chip: Chip, result: ChipToggleResult): void => {
		const name = `@${chip.displayId}${chip.mode === "full" ? "*" : ""}`;
		const message =
			result === "added" ? `Trail attached ${name} · expands on send` :
			result === "removed" ? `Trail detached ${name}` :
			result === "upgraded" ? `Trail attached ${name} as full text` :
			`Trail attached ${name} as reference`;
		notifyTrail(pi, ctx, message, "info");
	};

	pi.registerMessageRenderer("trail", trailMessageRenderer());

	const workerId = process.env[TRAIL_WORKER_ENV];

	const refreshWorkerDockWidget = async (): Promise<void> => {
		const ctx = activeCtx;
		if (!ctx?.hasUI || workerId) return;
		try {
			const store = createWorkerStore();
			const workers = await store.list();
			if (workers.length === 0) {
				ctx.ui.setWidget("trail-workers", undefined);
				return;
			}
			const sorted = [...workers].sort((a, b) => workerStateRank(a) - workerStateRank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 4);
			ctx.ui.setWidget(
				"trail-workers",
				(_tui, theme) => {
					const container = new Container();
					const accent = (s: string) => theme.fg("accent", s);
					const dim = (s: string) => theme.fg("dim", s);
					const muted = (s: string) => theme.fg("muted", s);
					const parts = sorted.map((worker) => {
						const state = workerDerivedState(worker);
						return workerStateColor(theme, state, workerAttentionLabel(worker));
					});
					const more = workers.length > sorted.length ? dim(` +${workers.length - sorted.length}`) : "";
					container.addChild(new Text(`${accent(theme.bold("trail"))} ${dim("·")} ${parts.join(muted(" · "))}${more}  ${dim("/trail")}`, 0, 0));
					return container;
				},
				{ placement: "aboveEditor" },
			);
		} catch {
			// best-effort dock; never disturb the session
		}
	};

	const emitWorkerStateArtifact = (ctx: ExtensionCommandContext, state: "needs_input" | "ready" | "failed", text?: string): void => {
		const subject = state === "needs_input" ? "needs input" : state === "ready" ? "ready" : "failed";
		const title = state === "needs_input"
			? `Needs input: ${text ?? "clarification requested"}`
			: state === "ready"
				? `Worker ready${text ? `: ${text}` : ""}`
				: `Worker failed: ${text ?? "unknown reason"}`;
		pi.sendMessage({
			customType: "trail",
			content: text ?? subject,
			display: true,
			details: {
				kind: state === "failed" ? "error" : "action",
				heading: "trail · worker",
				subject,
				trail: { kind: state === "failed" ? "error" : "response", title, subtitle: `worker ${subject}` },
			} as TrailMessageDetails & { trail: { kind: ArtifactKind; title: string; subtitle: string } },
		}, { triggerTurn: false });
	};

	const refreshWorkerCarryoverForReview = async (): Promise<void> => {
		if (workerId) return;
		try {
			const workers = await createWorkerStore().list();
			await Promise.all(workers.map(async (worker) => {
				loadedArtifacts.unloadSource("worker", worker.id);
				await loadedArtifacts.loadWorker(worker);
			}));
		} catch {
			// best-effort; the review inbox should still open for current-session artifacts
		}
	};

	const writeWorkerHeartbeat = async (ctx: ExtensionContext): Promise<void> => {
		if (!workerId) return;
		try {
			const config = await loadConfig(ctx.cwd);
			const catalog = createArtifactCatalog(ctx, config, []);
			const artifacts = catalog.list();
			const workerStore = createWorkerStore();
			await workerStore.writeArtifacts(workerId, artifacts);
			const current = await workerStore.find(workerId);
			const stickyState = current?.state === "needs_input" || current?.state === "ready" || current?.state === "failed";
			await workerStore.patchStatus(workerId, {
				state: stickyState ? current.state : "active",
				pid: process.pid,
				sessionFile: ctx.sessionManager.getSessionFile?.(),
				artifactCount: artifacts.length,
			});
		} catch {
			// best-effort heartbeat; never crash the worker
		}
	};

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		pinnedRefs = new Set();
		completedRefs = new Set();
		loadedArtifacts.reset();
		loadedCheckpoint = loadedCheckpointFromSession(ctx);
		if (ctx.hasUI) ctx.ui.setWidget("trail-chips", undefined);
		setLoadedCheckpointWidget(ctx, loadedCheckpoint);
		void maybeSweep(ctx.cwd);
		if (workerId) {
			void writeWorkerHeartbeat(ctx);
			heartbeatTimer = setInterval(() => void writeWorkerHeartbeat(ctx), 15000);
			heartbeatTimer.unref?.();
		} else if (ctx.hasUI) {
			void refreshWorkerDockWidget();
			workerDockTimer = setInterval(() => void refreshWorkerDockWidget(), 15000);
			workerDockTimer.unref?.();
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		if (workerDockTimer) {
			clearInterval(workerDockTimer);
			workerDockTimer = undefined;
		}
		if (workerId) {
			try { await createWorkerStore().patchStatus(workerId, { state: "ended" }); } catch { /* best-effort */ }
		}
		await drainShutdownConsume();
		activeCtx = undefined;
		pinnedRefs = new Set();
		completedRefs = new Set();
		loadedArtifacts.reset();
		loadedCheckpoint = undefined;
		if (ctx.hasUI) {
			ctx.ui.setWidget(TRAIL_CHECKPOINT_WIDGET_ID, undefined);
			ctx.ui.setWidget("trail-workers", undefined);
		}
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (loadedCheckpoint) {
			loadedCheckpoint = undefined;
			setLoadedCheckpointWidget(ctx, undefined);
		}
		if (loadedArtifacts.chips().length === 0) return { action: "continue" };
		const result = await loadedArtifacts.expandChipsForSubmit(ctx, event.text);
		if (result.expanded === 0 && result.missing.length === 0) return { action: "continue" };
		if (result.missing.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Trail dropped stale chip(s): ${result.missing.join(", ")}`, "warning");
		}
		loadedArtifacts.clearChips();
		refreshChipWidget();
		if (result.expanded === 0) return { action: "continue" };
		return { action: "transform", text: result.text };
	});

	pi.registerCommand("trail", {
		description: "Review unresolved agent work and create fresh-session checkpoints",
		getArgumentCompletions: async (prefix: string) => {
			const trimmed = prefix.replace(/^\s+/, "");
			const firstSpace = trimmed.indexOf(" ");
			if (firstSpace === -1) {
				const items = TRAIL_COMMANDS.filter((c) => c.startsWith(trimmed)).map((c) => ({ value: c, label: c }));
				return items.length ? items : null;
			}
			const subcommand = trimmed.slice(0, firstSpace);
			const rest = trimmed.slice(firstSpace + 1);
			if (subcommand === "load" || subcommand === "unload" || subcommand === "delete" || subcommand === "continue" || subcommand === "resume" || subcommand === "ask") {
				const lastSpace = rest.lastIndexOf(" ");
				const partial = lastSpace === -1 ? rest : rest.slice(lastSpace + 1);
				const completed = lastSpace === -1 ? "" : `${rest.slice(0, lastSpace + 1)}`;
				const candidates = await checkpointAndWorkerCandidates(subcommand);
				const matches = candidates.filter((c) => c.value.toLowerCase().startsWith(partial.toLowerCase()));
				const items = matches.map((c) => ({ value: `${subcommand} ${completed}${c.value}`, label: c.label }));
				return items.length ? items : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const parsed = parseTrailCommand(args);
			if (!parsed.ok) {
				emitText(pi, ctx, `${parsed.message}\n\n${parsed.usage}`, "usage", "trail · usage");
				return;
			}

			const intent = parsed.intent;
			const workerCommands = createWorkerCommands({
				store: createWorkerStore(),
				loadedArtifacts,
				cwd: ctx.cwd,
				parentSession: ctx.sessionManager.getSessionFile?.(),
				notify: (text, level) => notifyTrail(pi, ctx, text, level),
				announce: (subject, detail, kind) => announceAction(pi, ctx, subject, detail, kind),
				emitText: (text, kind, heading) => emitText(pi, ctx, text, kind, heading),
			});
			const checkpointCommands = createCheckpointCommands({
				store: createCheckpointStore(),
				hasUI: ctx.hasUI,
				notify: (text, level) => notifyTrail(pi, ctx, text, level),
				emitText: (text, kind, heading) => emitText(pi, ctx, text, kind, heading),
				confirmDelete: (checkpoint) => confirmDeleteCheckpoint(ctx, checkpoint),
				selectCheckpoint: (summaries, selected, mode) => showCheckpointResumeSelector(ctx, summaries, selected, mode),
				showText: (title, text) => showTextViewer(ctx, title, text),
				editText: (title, text) => ctx.hasUI ? ctx.ui.editor(title, text) : Promise.resolve(undefined),
				startSession: (checkpoint, content) => startCheckpointSession(pi, ctx, checkpoint, content, queueShutdownConsume),
			});
			if (intent.kind === "help") {
				emitText(pi, ctx, trailUsage(), "help", "trail · help");
				return;
			}

			if (intent.kind === "clear") {
				const had = loadedArtifacts.clearChips();
				refreshChipWidget();
				notifyTrail(pi, ctx, had ? "Trail chips cleared" : "Trail had no chips", "info");
				return;
			}

			if (intent.kind === "ask") {
				await workerCommands.ask(intent.worker, intent.text);
				await refreshWorkerDockWidget();
				return;
			}

			if (intent.kind === "worker-state") {
				if (!workerId) {
					notifyTrail(pi, ctx, "Worker state commands only run inside a Trail worker", "warning");
					return;
				}
				await createWorkerStore().patchStatus(workerId, {
					state: intent.state,
					question: intent.state === "needs_input" ? intent.text : undefined,
					summary: intent.state === "ready" ? intent.text : undefined,
					lastError: intent.state === "failed" ? intent.text : undefined,
				});
				emitWorkerStateArtifact(ctx, intent.state, intent.text);
				await writeWorkerHeartbeat(ctx);
				return;
			}

			if (intent.kind === "checkpoint") {
				const checkpointLifecycle = await createCheckpointLifecycle(pi, ctx);
				await checkpointLifecycle.create(intent.options);
				return;
			}

			if (intent.kind === "continue") {
				await checkpointCommands.continue(intent.idOrLast);
				return;
			}

			if (intent.kind === "delete") {
				if (intent.targetKind === "worker") {
					await workerCommands.delete(intent.target);
					await refreshWorkerDockWidget();
				} else await checkpointCommands.delete(intent.target);
				return;
			}

			if (intent.kind === "list") {
				if (intent.workers === true) await workerCommands.list();
				else await checkpointCommands.list(intent.includeConsumed === true);
				return;
			}

			if (intent.kind === "spawn") {
				await workerCommands.spawn(intent.task);
				await refreshWorkerDockWidget();
				return;
			}

			if (intent.kind === "workers") {
				const store = createWorkerStore();
				const { workers, artifactsByWorker } = await readWorkersWithArtifacts(store);
				if (!ctx.hasUI) {
					emitText(pi, ctx, renderParallelWorkList(workers, artifactsByWorker), "list", "trail · parallel work");
					return;
				}
				while (true) {
					const result = await showParallelWorkDashboard(ctx, workers, artifactsByWorker);
					if (!result) return;
					if (result.action === "peek") {
						await showTextViewer(ctx, `${workerSourceLabel(result.entry.worker)} · ${parallelKindLabel(result.entry.artifact.kind)}`, formatArtifact(result.entry.artifact));
						continue;
					}
					if (result.action === "load") {
						const slot = await loadedArtifacts.loadWorker(result.worker);
						announceAction(pi, ctx, `loaded ${slot.slot} · ${slot.artifacts.length} artifact${slot.artifacts.length === 1 ? "" : "s"}`, `${workerDisplayName(result.worker)}\nrefs: @${slot.slot}.<id>`, "success");
						await refreshWorkerDockWidget();
						return;
					}
					if (result.action === "attach") {
						const command = `tmux attach -t ${result.worker.tmuxSession}`;
						const copied = await copyToClipboard(command);
						notifyTrail(pi, ctx, copied ? `Copied: ${command}` : command, copied ? "info" : "warning");
						return;
					}
					if (result.action === "recall") {
						const slot = await loadedArtifacts.loadWorker(result.worker);
						await refreshWorkerDockWidget();
						const answers = slot.artifacts.filter((artifact) => artifact.kind === "response");
						if (answers.length === 0) {
							notifyTrail(pi, ctx, `No answers yet for ${workerSourceLabel(result.worker)}`, "info");
							return;
						}
						const config = await loadConfig(ctx.cwd);
						const catalog = createArtifactCatalog(ctx, config, loadedArtifacts.carryoverArtifacts());
						await showTrailBrowser(ctx, catalog, answers, pinnedRefs, completedRefs, "recall");
						return;
					}
				}
			}

			if (intent.kind === "load") {
				if (intent.refKind === "worker") {
					await workerCommands.load(intent.ref);
					await refreshWorkerDockWidget();
					return;
				}

				const store = createCheckpointStore();
				const opts = { includeConsumed: intent.includeConsumed === true };
				let checkpoint: CheckpointIndexEntry | undefined;
				if (intent.ref) {
					checkpoint = await store.find(intent.ref, opts);
					if (!checkpoint) {
						notifyTrail(pi, ctx, "Trail checkpoint not found", "error");
						return;
					}
				} else {
					const [summaries, workers] = await Promise.all([
						store.listSummaries(opts),
						createWorkerStore().list(),
					]);
					if (summaries.length === 0 && workers.length === 0) {
						notifyTrail(pi, ctx, "Trail has nothing to load — try /trail checkpoint or /trail spawn", "error");
						return;
					}
					if (!ctx.hasUI) {
						if (summaries.length > 0) checkpoint = summaries[summaries.length - 1]!.entry;
						else {
							const worker = workers[workers.length - 1]!;
							const slot = await loadedArtifacts.loadWorker(worker);
							announceAction(pi, ctx, `loaded ${slot.slot} · ${slot.artifacts.length} artifact${slot.artifacts.length === 1 ? "" : "s"}`, `${workerSummaryName(worker)}\nrefs: @${slot.slot}.<id>`, "success");
							await refreshWorkerDockWidget();
							return;
						}
					} else {
						const initial: LoadPickerMode = summaries.length > 0 ? "checkpoint" : "worker";
						while (true) {
							const selected = await showLoadPicker(ctx, summaries, workers, initial);
							if (!selected) {
								notifyTrail(pi, ctx, "Trail load cancelled", "info");
								return;
							}
							if (selected.kind === "worker") {
								try {
									const slot = await loadedArtifacts.loadWorker(selected.worker);
									announceAction(pi, ctx, `loaded ${slot.slot} · ${slot.artifacts.length} artifact${slot.artifacts.length === 1 ? "" : "s"}`, `${workerSummaryName(selected.worker)}\nrefs: @${slot.slot}.<id>`, "success");
									await refreshWorkerDockWidget();
								} catch (err) {
									notifyTrail(pi, ctx, `Trail load failed: ${String(err)}`, "error");
								}
								return;
							}
							if (selected.action === "preview") {
								const md = await store.readMarkdown(selected.summary.entry);
								await showTextViewer(ctx, `Trail checkpoint ${selected.summary.entry.id}`, md);
								continue;
							}
							checkpoint = selected.summary.entry;
							break;
						}
					}
				}
				try {
					if (!checkpoint) return;
					const slot = await loadedArtifacts.loadCheckpoint(checkpoint);
					if (checkpoint.consumeOnUse) queueShutdownConsume(checkpoint);
					const tag = checkpoint.consumeOnUse ? "consume on session end" : `${checkpoint.mode} checkpoint`;
					announceAction(
						pi,
						ctx,
						`loaded ${slot.slot} · ${slot.artifacts.length} artifact${slot.artifacts.length === 1 ? "" : "s"}`,
						`${checkpoint.id}\n${tag}\nrefs: @${slot.slot}.<id>`,
						"success",
					);
				} catch (err) {
					notifyTrail(pi, ctx, `Trail load failed: ${String(err)}`, "error");
				}
				return;
			}

			if (intent.kind === "unload") {
				if (intent.targetKind === "all") {
					const slots = loadedArtifacts.slots().map((entry) => entry.slot);
					for (const slot of slots) loadedArtifacts.unloadSlot(slot);
					if (slots.length) announceAction(pi, ctx, `unloaded ${slots.length} slot${slots.length === 1 ? "" : "s"}`, slots.join(", "));
					else notifyTrail(pi, ctx, "Trail had no loaded slots", "info");
					return;
				}
				if (intent.targetKind === "worker") {
					await workerCommands.unload(intent.target);
					await refreshWorkerDockWidget();
					return;
				}
				const store = createCheckpointStore();
				const checkpoint = await store.find(intent.target, { includeConsumed: true });
				const targetId = checkpoint?.id ?? intent.target;
				const removed = loadedArtifacts.unloadSource("checkpoint", targetId);
				if (removed) announceAction(pi, ctx, `unloaded ${removed.slot}`, removed.sourceId);
				else notifyTrail(pi, ctx, "Trail checkpoint not loaded", "warning");
				return;
			}

			const config = await loadConfig(ctx.cwd);
			if (intent.kind === "browse" || intent.kind === "recall" || intent.kind === "search") await refreshWorkerCarryoverForReview();
			const catalog = createArtifactCatalog(ctx, config, loadedArtifacts.carryoverArtifacts());
			let artifacts = catalog.list();
			let initialMode: NavigatorMode = intent.kind === "browse" && intent.mode ? intent.mode : "work";

			if (intent.kind === "recall") {
				initialMode = "recall";
				if (intent.query) artifacts = (await catalog.search(intent.query)).filter((artifact) => artifact.kind === "response");
				else artifacts = artifacts.filter((artifact) => artifact.kind === "response");
				if (artifacts.length === 0) {
					notifyTrail(pi, ctx, intent.query ? `Trail memory found no answers for: ${intent.query}` : "Trail memory has no answers yet", "info");
					return;
				}
				if (!ctx.hasUI) {
					emitText(pi, ctx, renderArtifactList(artifacts), "list", intent.query ? `trail · memory "${intent.query}"` : "trail · memory");
					return;
				}
			}

			if (intent.kind === "search") {
				initialMode = "all";
				artifacts = await catalog.search(intent.query);
				if (artifacts.length === 0) {
					notifyTrail(pi, ctx, `Trail search found no artifacts for: ${intent.query}`, "info");
					return;
				}
				if (!ctx.hasUI) {
					emitText(pi, ctx, renderArtifactList(artifacts), "list", `trail · search "${intent.query}"`);
					return;
				}
			}

			if (intent.kind === "artifact") {
				const artifact = catalog.find(intent.idOrRef);
				if (!artifact) {
					notifyTrail(pi, ctx, "Trail artifact not found", "error");
					return;
				}
				completedRefs.add(artifact.ref);
				if (intent.action === "ref" || intent.action === "inject") {
					const r = loadedArtifacts.toggleChip(artifact, "ref");
					refreshChipWidget();
					announceChipChange(ctx, { displayId: artifact.displayId, ref: artifact.ref, mode: "ref", kind: artifact.kind, title: artifact.title }, r);
				} else if (intent.action === "inject-full") {
					const r = loadedArtifacts.toggleChip(artifact, "full");
					refreshChipWidget();
					announceChipChange(ctx, { displayId: artifact.displayId, ref: artifact.ref, mode: "full", kind: artifact.kind, title: artifact.title }, r);
				} else {
					const ok = await copyToClipboard(catalog.fullText(artifact));
					notifyTrail(pi, ctx, ok ? `Trail copied ${artifact.id}` : "No clipboard command found", ok ? "info" : "warning");
				}
				return;
			}

			if (!ctx.hasUI) {
				emitText(pi, ctx, renderArtifactList(artifacts), "list", `trail · ${navigatorModeLabel(initialMode)}`);
				return;
			}

			while (true) {
				const result = await showTrailBrowser(ctx, catalog, artifacts, pinnedRefs, completedRefs, initialMode);
				if (!result) return;
				if (result.action === "checkpoint") {
					const checkpointLifecycle = await createCheckpointLifecycle(pi, ctx);
					await checkpointLifecycle.create({ mode: "handoff", note: "", consumeOnUse: false, raw: false });
					return;
				}
				if (result.action === "search") {
					const query = (await ctx.ui.input("Search Trail", "commands, errors, files, answers..."))?.trim();
					if (!query) continue;
					const matches = await catalog.search(query);
					if (matches.length === 0) {
						notifyTrail(pi, ctx, `Trail search found no artifacts for: ${query}`, "info");
						continue;
					}
					artifacts = matches;
					initialMode = "all";
					continue;
				}
				if (result.action === "replyWorker" && result.artifact) {
					const workerRef = artifactWorkerRef(result.artifact);
					if (!workerRef) {
						notifyTrail(pi, ctx, "Trail worker not found for this item", "error");
						continue;
					}
					const question = trailMetaString(result.artifact, "question") ?? result.artifact.title;
					const reply = (await ctx.ui.input(`Reply to ${workerRef}`, question))?.trim();
					if (!reply) continue;
					await workerCommands.ask(workerRef, reply);
					await refreshWorkerDockWidget();
					return;
				}
				if (!result.artifact) return;
				completedRefs.add(result.artifact.ref);
				if (result.action === "inspect") {
					await showArtifactViewer(ctx, catalog, result.artifact);
					continue;
				}
				if (result.action === "openFile") {
					const filePath = artifactFilePath(result.artifact, ctx.cwd);
					if (filePath) await showFileViewer(ctx, filePath);
					else await showArtifactViewer(ctx, catalog, result.artifact);
					continue;
				}
				const artifact = result.artifact;
				if (result.action === "reference") {
					const r = loadedArtifacts.toggleChip(artifact, "ref");
					refreshChipWidget();
					announceChipChange(ctx, { displayId: artifact.displayId, ref: artifact.ref, mode: "ref", kind: artifact.kind, title: artifact.title }, r);
				} else if (result.action === "injectFull") {
					const r = loadedArtifacts.toggleChip(artifact, "full");
					refreshChipWidget();
					announceChipChange(ctx, { displayId: artifact.displayId, ref: artifact.ref, mode: "full", kind: artifact.kind, title: artifact.title }, r);
				} else if (result.action === "copy") {
					const ok = await copyToClipboard(catalog.fullText(artifact));
					notifyTrail(pi, ctx, ok ? `Trail copied ${artifact.id}` : "No clipboard command found", ok ? "info" : "warning");
				}
				return;
			}
		},
	});
}
