/**
 * Trail — session artifacts as first-class objects.
 *
 * Commands:
 *   /trail                         open inbox
 *   /trail answers [query]          browse assistant/worker answers
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
import { StringEnum, Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, MessageRenderer } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getLanguageFromPath, highlightCode, isToolCallEventType } from "@mariozechner/pi-coding-agent";
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
import { deriveWorkerState, isPromptDockWorker, namespaceWorkerArtifacts, workerActivityChip, workerDisplayName, workerHeartbeatPatch, workerLaunchDetail, workerLaunchSubject, workerMascotLines, workerProtocolMessage, workerProtocolPatch, workerProtocolResultText, workerShortLabel, workerSourceLabel, workerStatusArtifact, workerSummaryName, workerTodoProgress, workerTodosPatch, type WorkerDerivedState, type WorkerProtocolState, type WorkerStatus, type WorkerTodoInput } from "./background-work.js";
import { artifactFilePath, createArtifactCatalog, formatArtifact, type ArtifactCatalog } from "./artifact-catalog.js";
import { createCheckpointCommands, type ResumeAction, type ResumeMode, type ResumeSelection } from "./checkpoint-commands.js";
import { createCheckpointLifecycle } from "./checkpoint-lifecycle.js";
import { createCheckpointStore, type CheckpointSummary } from "./checkpoint-store.js";
import { gitSnapshotLabel, readGitSnapshot } from "./git-context.js";
import { createLoadedArtifactContext, type Chip, type ChipToggleResult } from "./loaded-artifact-context.js";
import { loadConfig } from "./trail-config.js";
import { parseTrailCommand, parseTrailWorkerShellCommand, trailUsage, TRAIL_COMMANDS } from "./trail-command-grammar.js";
import { createTrailCommandRouter, type LoadPickerMode, type LoadPickerSelection, type ParallelWorkAction, type ParallelWorkEntry, type TrailBrowserAction } from "./trail-command-router.js";
import { availableSources, handleNavigatorIntent, initialNavigatorState, navigatorSourceLabel, navigatorViewModel, sameNavigatorSource, type NavigatorAction, type NavigatorIntent, type NavigatorMode, type NavigatorSource, type NavigatorState, type ReviewActionId, type ReviewBucket, type ReviewItem, type ReviewQueueState, type ReviewReasonId } from "./trail-navigator.js";
import type { Artifact, ArtifactKind, CheckpointIndexEntry } from "./types.js";
import { createWorkerCommands, workerAge, workerCompletionCandidates } from "./worker-commands.js";
import { workerActivityPreviewLines, workerActivityRows, workerActivityTotals, type WorkerActivityRow } from "./worker-activity.js";
import { workerResultHeadline, workerResultText } from "./worker-result.js";
import { createWorkerStore, readWorkerStatusSync, TRAIL_WORKER_ENV } from "./worker-store.js";

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

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
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

function wrapPlainText(text: string, width: number, maxLines = Infinity): string[] {
	const limit = Math.max(12, width);
	const out: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		let line = raw.trim();
		if (!line) {
			out.push("");
			continue;
		}
		while (visibleWidth(line) > limit && out.length < maxLines) {
			let slice = truncateToWidth(line, limit, "");
			const breakAt = slice.lastIndexOf(" ");
			if (breakAt > limit * 0.45) slice = slice.slice(0, breakAt);
			out.push(slice.trimEnd());
			line = line.slice(slice.length).trimStart();
		}
		if (out.length < maxLines) out.push(line);
	}
	if (out.length > maxLines) return out.slice(0, maxLines);
	return out;
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

function sourceBar(theme: any, sources: NavigatorSource[], active: NavigatorSource): string {
	if (sources.length <= 1) return "";
	return sources
		.map((source) => sameNavigatorSource(source, active) ? activePill(theme, navigatorSourceLabel(source)) : inactivePill(theme, navigatorSourceLabel(source)))
		.join(" ");
}

function modeBar(theme: any, active: NavigatorMode): string {
	const modes: Array<{ value: NavigatorMode; label: string }> = [
		{ value: "review", label: "inbox" },
		{ value: "answers", label: "answers" },
		{ value: "all", label: "all" },
	];
	return modes.map((mode) => mode.value === active ? activePill(theme, mode.label) : inactivePill(theme, mode.label)).join(" ");
}

function artifactMeta(artifact: Artifact): Record<string, unknown> {
	return artifact.meta ?? {};
}

function artifactHasDiff(artifact: Artifact): boolean {
	const diff = artifactMeta(artifact).diff;
	return typeof diff === "string" && diff.length > 0;
}

function bucketName(bucket: ReviewBucket | undefined, mode: NavigatorMode): string {
	if (bucket === "needs") return "next";
	if (bucket === "pinned") return "pinned";
	if (bucket === "recent") return "recent";
	return mode === "answers" ? "answer" : "item";
}

function bucketGlyph(bucket: ReviewBucket | undefined, mode: NavigatorMode): string {
	if (bucket === "needs") return "◆";
	if (bucket === "pinned") return "●";
	if (bucket === "recent") return "✓";
	return mode === "answers" ? "✦" : "·";
}

function colorBucket(theme: any, bucket: ReviewBucket | undefined, mode: NavigatorMode, text: string): string {
	if (bucket === "needs") return theme.fg("warning", text);
	if (bucket === "pinned") return theme.fg("accent", text);
	if (bucket === "recent") return theme.fg("success", text);
	return mode === "answers" ? theme.fg("accent", text) : theme.fg("muted", text);
}

function reviewReasonLabel(reasonId: ReviewReasonId | undefined): string | undefined {
	if (reasonId === "pinned") return "pinned";
	if (reasonId === "done") return "recently reviewed";
	if (reasonId === "workerNeedsInput") return "worker waiting";
	if (reasonId === "workerFailed") return "worker failed";
	if (reasonId === "workerReady") return "worker ready";
	if (reasonId === "error") return "needs attention";
	if (reasonId === "changedFile") return "changed file";
	if (reasonId === "createdFile") return "created file";
	if (reasonId === "failedCommand") return "failed command";
	if (reasonId === "workerAnswer") return "worker answer";
	if (reasonId === "workerOutput") return "worker output";
	if (reasonId === "assistantAnswer") return "assistant answer";
	return undefined;
}

function reviewActionLabel(action: ReviewActionId, item: ReviewItem): string {
	const artifact = item.artifact;
	if (action === "tellWorker") return "Tell worker";
	if (action === "openFile") return "Open file";
	if (action === "attachReference") return "Attach";
	if (action === "injectFull") return "Full";
	if (action === "copyArtifact") return "Copy";
	if (action === "pin") return "Pin";
	if (action === "markDone") return "Done";
	if (item.reasonId === "workerFailed" || item.reasonId === "error" || item.reasonId === "failedCommand") return "Inspect failure";
	if (item.reasonId === "workerReady") return "View answer";
	if (artifact.kind === "file" && artifactHasDiff(artifact)) return "Review diff";
	if (artifact.kind === "command") return "Inspect output";
	if (artifact.kind === "response") return "View answer";
	if (artifact.kind === "code") return "View code";
	if (artifact.kind === "checkpoint") return "Open checkpoint";
	return "Open";
}

function selectedActionHints(item: ReviewItem, pinned: boolean, done: boolean): string[] {
	const artifact = item.artifact;
	const hints = [`enter ${reviewActionLabel(item.primaryAction, item).toLowerCase()}`];
	if (item.actions.includes("tellWorker")) hints.push("t tell");
	if (item.actions.includes("openFile")) hints.push("o open");
	hints.push("a attach", "I full", "y copy", pinned ? "p unpin" : "p pin", done ? "x restore" : "x done", "v preview");
	return artifact ? hints : [];
}

function bucketCounts(items: ReviewItem[]): Record<ReviewBucket, number> {
	const counts: Record<ReviewBucket, number> = { needs: 0, pinned: 0, recent: 0 };
	for (const item of items) {
		if (item.bucket) counts[item.bucket]++;
	}
	return counts;
}

function navigatorModeLabel(mode: NavigatorMode): string {
	if (mode === "review") return "inbox";
	if (mode === "answers") return "answers";
	return "all";
}

function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function trailStatusLine(mode: NavigatorMode, items: ReviewItem[], artifacts: Artifact[]): string {
	if (artifacts.length === 0) return "quiet until something needs attention";
	if (mode === "answers") return plural(items.length, "answer");
	if (mode === "all") return plural(items.length, "artifact");
	const counts = bucketCounts(items);
	const parts: string[] = [];
	if (counts.needs > 0) parts.push(`${counts.needs} needs attention`);
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
	if (state.mode === "review") {
		return {
			title: "All clear",
			body: "Trail will surface changed files, failures, pinned items, and worker output when they need attention.",
			actions: ["press tab for answers", "press / to search", "pin useful items with p"],
		};
	}
	if (state.mode === "answers") {
		return {
			title: "No answers yet",
			body: "Answers stay quiet until assistant or worker conclusions exist for this source/filter.",
			actions: ["press tab for all", "press / to search", "cycle filters with f"],
		};
	}
	const filter = state.filter === "all" ? "" : `${kindLabel(state.filter)} `;
	return {
		title: `No ${filter}artifacts here`,
		body: "This view is filtered. Your activity may still exist in another source, kind, or mode.",
		actions: ["press f to change filter", "press s to switch source", "press 1 for inbox"],
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
		const source = sources.find((candidate) => candidate.kind === "all") ?? sources.find((candidate) => candidate.kind === "current") ?? sources[0] ?? initialNavigatorState().source;
		this.state = { ...initialNavigatorState(), source, mode: initialMode };
	}

	private queueState(): ReviewQueueState {
		return { pinnedRefs: this.pinnedRefs, doneRefs: this.completedRefs };
	}

	handleInput(data: string): void {
		if (data === "?") {
			this.showHelp = !this.showHelp;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		const intent = this.intentForInput(data);
		if (!intent) return;
		const transition = handleNavigatorIntent(this.state, this.artifacts, this.queueState(), intent);
		this.state = transition.state;
		if (transition.action) this.finish(transition.action);
		this.invalidate();
		this.tui.requestRender();
	}

	private intentForInput(data: string): NavigatorIntent | undefined {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") return { kind: "close" };
		if (data === "j" || matchesKey(data, Key.down)) return { kind: "move", by: 1 };
		if (data === "k" || matchesKey(data, Key.up)) return { kind: "move", by: -1 };
		if (data === "g") return { kind: "top" };
		if (data === "G") return { kind: "bottom" };
		if (data === "v") return { kind: "toggleDetail" };
		if (data === "/") return { kind: "search" };
		if (data === "1") return { kind: "setMode", mode: "review" };
		if (data === "2") return { kind: "setMode", mode: "answers" };
		if (data === "3") return { kind: "setMode", mode: "all" };
		if (data === "\t" || matchesKey(data, Key.tab)) return { kind: "cycleMode" };
		if (data === "f") return { kind: "cycleFilter" };
		if (data === "s") return { kind: "cycleSource" };
		if (matchesKey(data, Key.enter)) return { kind: "activatePrimary" };
		if (data === "o") return { kind: "runAction", action: "openFile" };
		if (data === "t") return { kind: "runAction", action: "tellWorker" };
		if (data === "a" || data === "r" || data === "i") return { kind: "runAction", action: "attachReference" };
		if (data === "I") return { kind: "runAction", action: "injectFull" };
		if (data === "y") return { kind: "runAction", action: "copyArtifact" };
		if (data === "p") return { kind: "runAction", action: "pin" };
		if (data === "x") return { kind: "runAction", action: "markDone" };
		if (data === "c") return { kind: "createCheckpoint" };
		return undefined;
	}

	private finish(action: NavigatorAction): void {
		if (action.action === "close") {
			this.done(null);
			return;
		}
		if (action.action === "search") {
			this.done({ action: "search" });
			return;
		}
		if (action.action === "createCheckpoint") {
			this.done({ action: "checkpoint" });
			return;
		}
		const artifact = action.item.artifact;
		if (action.id === "pin") {
			if (this.pinnedRefs.has(artifact.ref)) this.pinnedRefs.delete(artifact.ref);
			else this.pinnedRefs.add(artifact.ref);
			return;
		}
		if (action.id === "markDone") {
			if (this.completedRefs.has(artifact.ref)) this.completedRefs.delete(artifact.ref);
			else {
				this.pinnedRefs.delete(artifact.ref);
				this.completedRefs.add(artifact.ref);
			}
			return;
		}
		if (action.id === "inspect") this.done({ action: "inspect", artifact });
		else if (action.id === "openFile") this.done({ action: "openFile", artifact });
		else if (action.id === "tellWorker") this.done({ action: "tellWorker", artifact });
		else if (action.id === "attachReference") this.done({ action: "reference", artifact });
		else if (action.id === "injectFull") this.done({ action: "injectFull", artifact });
		else if (action.id === "copyArtifact") this.done({ action: "copy", artifact });
	}

	invalidate(): void {
		this.container.invalidate();
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const artifacts = this.artifacts;
		this.container = new Box(2, 1, trailCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		const view = navigatorViewModel(this.state, artifacts, this.queueState(), this.state.showDetail ? 7 : 12);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const outerBorder = (s: string) => this.theme.fg("border", s);
		const dividerBorder = (s: string) => this.theme.fg("borderMuted", s);

		const sel = view.selectedItem;
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
		const defaultSource = sources.find((source) => source.kind === "all") ?? sources[0];
		const sourceNarrowed = sources.length > 1 && !!defaultSource && !sameNavigatorSource(sourceLabel, defaultSource);
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
				const item = view.visible[i];
				if (!item) continue;
				const artifact = item.artifact;
				const absolute = view.visibleStart + i;
				const selected = absolute === view.selected;
				const bucket = item.bucket;
				if (this.state.mode === "review") {
					const previousBucket = absolute > 0 ? view.items[absolute - 1]?.bucket : undefined;
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
			const artifact = sel.artifact;
			const primary = reviewActionLabel(sel.primaryAction, sel);
			const focusMeta = [kindLabel(artifact.kind), reviewReasonLabel(sel.reasonId), artifact.source ? `from ${artifact.source}` : "current", relativeTime(artifact.timestamp), `@${artifact.id}`].filter(Boolean).join(" · ");
			this.container.addChild(new DynamicBorder(dividerBorder));
			this.container.addChild(new Text(truncateToWidth(`${accent(primary)} ${dim("·")} ${muted(artifact.title)}`, listWidth - 2), 1, 0));
			if (focusMeta) this.container.addChild(new Text(truncateToWidth(dim(focusMeta), listWidth - 2), 1, 0));
			const hints = selectedActionHints(sel, this.pinnedRefs.has(artifact.ref), this.completedRefs.has(artifact.ref));
			this.container.addChild(new Text(truncateToWidth(hints.map((hint, index) => index === 0 ? accent(`[${hint}]`) : dim(hint)).join(" · "), listWidth - 2), 1, 0));
		}

		if (this.state.showDetail && view.selectedItem) {
			const artifact = view.selectedItem.artifact;
			this.container.addChild(new DynamicBorder(dividerBorder));
			this.container.addChild(new Text(`${accent("preview")} ${muted(artifact.ref)}`, 1, 0));
			const detail = this.fullText(artifact).split("\n").slice(0, 14);
			for (const line of detail) this.container.addChild(new Text(truncateToWidth(dim(line), listWidth - 2), 1, 0));
		}

		this.container.addChild(new DynamicBorder(dividerBorder));
		const nextMode = this.state.mode === "review" ? "answers" : this.state.mode === "answers" ? "all" : "review";
		this.container.addChild(new Text(dim(`↑↓ · enter · tab ${navigatorModeLabel(nextMode)} · / search · ? help · esc`), 1, 0));
		if (this.showHelp) {
			this.container.addChild(new Text(`${muted("Modes")} ${modeBar(this.theme, this.state.mode)} ${dim("· 1 inbox · 2 answers · 3 all")}`, 1, 0));
			this.container.addChild(new Text(`${muted("Filters")} ${dim("f kind · s source")}`, 1, 0));
			this.container.addChild(new Text(`${muted("Actions")} ${dim("o open file · i attach alias · I full · y copy · p pin · x done · c checkpoint · v preview")}`, 1, 0));
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
	initialMode: NavigatorMode = "review",
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
			const git = gitSnapshotLabel(entry.git);
			const meta = [stats, git].filter(Boolean).join(" · ");
			const line = `${marker} ${id} ${accent(mode.padEnd(12))} ${dim(relativeTime(Date.parse(entry.createdAt)).padEnd(9))} ${meta} ${muted(entry.note ?? "")}`;
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

type ParallelKindFilter = ArtifactKind | "all";
type ParallelSource = "all" | string;

const PARALLEL_KIND_FILTERS: ParallelKindFilter[] = ["all", "error", "response", "file", "command", "checkpoint", "code", "prompt"];

function workerStateColor(theme: any, state: WorkerDerivedState, text: string): string {
	if (state === "needs_input" || state === "ready_open_todos") return theme.fg("warning", text);
	if (state === "ready") return theme.fg("success", text);
	if (state === "failed") return theme.fg("error", text);
	if (state === "starting" || state === "thinking") return theme.fg("accent", text);
	return theme.fg("muted", text);
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

function workerProgressLabel(row: WorkerActivityRow): string {
	return row.progress.total ? `${row.progress.completed}/${row.progress.total}` : "—";
}

function fitColumn(text: string, width: number): string {
	return padAnsi(truncateToWidth(text, width, ""), width);
}

function workerActivityRowText(row: WorkerActivityRow, width: number, selected = false): string {
	const marker = selected ? "▸" : "●";
	const progress = workerProgressLabel(row);
	if (width < 92) return truncateToWidth(`${marker} ${row.label} ${row.stateLabel} ${progress} ${row.taskLabel} · ${row.outputLabel} · ${row.actionHint}`, width, "");
	const actionWidth = 16;
	const outputWidth = 26;
	const progressWidth = 8;
	const statusWidth = 16;
	const labelWidth = 4;
	const fixed = 2 + labelWidth + 2 + statusWidth + 2 + progressWidth + 2 + outputWidth + 2 + actionWidth;
	const taskWidth = Math.max(14, width - fixed);
	return truncateToWidth([
		marker,
		fitColumn(row.label, labelWidth),
		fitColumn(row.stateLabel, statusWidth),
		fitColumn(row.taskLabel, taskWidth),
		fitColumn(progress, progressWidth),
		fitColumn(row.outputLabel, outputWidth),
		fitColumn(row.actionHint, actionWidth),
	].join("  "), width, "");
}

function renderWorkerActivityRows(theme: any, rows: WorkerActivityRow[], width: number, selectedIndex?: number): string[] {
	return rows.map((row, index) => {
		const plain = workerActivityRowText(row, width, selectedIndex === index);
		if (selectedIndex === index) return theme.bg("selectedBg", theme.fg("text", padAnsi(plain, width)));
		return workerStateColor(theme, row.state, plain);
	});
}

function addWorkerActivityPreview(container: Container | Box, theme: any, row: WorkerActivityRow | undefined, width: number): void {
	if (!row) return;
	const dim = (s: string) => theme.fg("dim", s);
	const muted = (s: string) => theme.fg("muted", s);
	const accent = (s: string) => theme.fg("accent", s);
	container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));
	const lines = workerActivityPreviewLines(row);
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		const color = i === 0 ? accent : raw.startsWith("Actions:") ? muted : dim;
		const maxLines = i === 1 ? 3 : 1;
		for (const line of wrapPlainText(raw, width, maxLines)) container.addChild(new Text(truncateToWidth(color(line), width), 1, 0));
	}
}

async function readWorkerArtifactsForReview(worker: WorkerStatus): Promise<Artifact[]> {
	const artifacts = await createWorkerStore().readArtifacts(worker.id);
	const status = workerStatusArtifact(worker);
	return status ? [status, ...artifacts.filter((artifact) => artifact.ref !== status.ref)] : artifacts;
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
	private showHelp = false;
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
		return parallelEntries(this.workers, this.artifactsByWorker, "all", "all", new Set());
	}

	private activityRows(): WorkerActivityRow[] {
		return workerActivityRows(this.workers, this.artifactsByWorker);
	}

	private selectedWorker(): WorkerStatus | undefined {
		return this.activityRows()[this.selected]?.worker;
	}

	private selectNext(): void {
		const max = Math.max(0, this.activityRows().length - 1);
		this.selected = Math.min(max, this.selected + 1);
	}

	handleInput(data: string): void {
		const rows = this.activityRows();
		const max = Math.max(0, rows.length - 1);
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
			this.done(null);
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) this.selected = Math.min(max, this.selected + 1);
		else if (data === "k" || matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (data === "g") this.selected = 0;
		else if (data === "G") this.selected = max;
		else if (matchesKey(data, Key.tab)) this.selectNext();
		else if (data === "?") this.showHelp = !this.showHelp;
		else if (matchesKey(data, Key.enter)) {
			const worker = this.selectedWorker();
			if (worker) this.done({ action: "details", worker });
			return;
		}
		else if (data === "l") {
			const worker = this.selectedWorker();
			if (worker) this.done({ action: "load", worker });
			return;
		}
		else if (data === "c" || data === "t") {
			const worker = this.selectedWorker();
			if (worker) this.done({ action: "tell", worker });
			return;
		}
		else if (data === "a") {
			const worker = this.selectedWorker();
			if (worker) this.done({ action: "copyAttach", worker });
			return;
		}
		else if (data === "x") {
			const worker = this.selectedWorker();
			if (worker) this.done({ action: "stop", worker });
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
		const activityRows = this.activityRows();
		this.selected = Math.min(this.selected, Math.max(0, activityRows.length - 1));
		const selectedRow = activityRows[this.selected];
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const border = (s: string) => this.theme.fg("border", s);
		const divider = (s: string) => this.theme.fg("borderMuted", s);
		const workerCounts = workerActivityTotals(activityRows);
		const status = [
			workerCounts.waiting ? `${workerCounts.waiting} waiting` : undefined,
			workerCounts.failed ? `${workerCounts.failed} failed` : undefined,
			workerCounts.readyOpenTodos ? `${workerCounts.readyOpenTodos} ready/open todos` : undefined,
			workerCounts.ready ? `${workerCounts.ready} ready` : undefined,
			workerCounts.active ? `${workerCounts.active} active` : undefined,
		].filter(Boolean).join(" · ") || plural(this.workers.length, "worker");

		this.container.addChild(new Text(fitBorder(` ${accent(this.theme.bold("trail"))} ${dim("·")} ${accent("workers")} `, ` ${dim("Esc close")} `, innerWidth, border, TOP_CORNERS), 0, 0));
		const todoStatus = workerCounts.todos ? ` · todos ${workerCounts.completedTodos}/${workerCounts.todos}` : "";
		const artifactStatus = entries.length ? ` · ${entries.length} items` : "";
		this.container.addChild(new Text(truncateToWidth(` ${muted(status)}${dim(todoStatus)}${dim(artifactStatus)}`, innerWidth - 2), 1, 0));
		this.container.addChild(new DynamicBorder(divider));

		if (activityRows.length === 0) {
			const mascotWorker = this.workers[0];
			this.container.addChild(new Spacer(1));
			for (const line of workerMascotLines(mascotWorker)) this.container.addChild(new Text(` ${accent(line)}`, 1, 0));
			this.container.addChild(new Text(fitBorder(` ${accent(this.theme.bold("No parallel work yet"))} `, "", listWidth - 2, divider, TOP_CORNERS), 1, 0));
			this.container.addChild(new Text(truncateToWidth(` ${muted("Spawn a side investigation when you want evidence without interrupting current flow.")}`, listWidth - 2), 1, 0));
			this.container.addChild(new Text(truncateToWidth(` ${dim("Try: /trail spawn <task>")}`, listWidth - 2), 1, 0));
			this.container.addChild(new Text(fitBorder("", "", listWidth - 2, divider, BOTTOM_CORNERS), 1, 0));
			this.container.addChild(new Spacer(1));
		} else {
			if (listWidth >= 92) this.container.addChild(new Text(dim(`  ${fitColumn("worker", 4)}  ${fitColumn("status", 16)}  ${fitColumn("task", Math.max(14, listWidth - 78))}  ${fitColumn("progress", 8)}  ${fitColumn("output", 26)}  action`), 1, 0));
			for (const line of renderWorkerActivityRows(this.theme, activityRows, listWidth - 2, this.selected)) this.container.addChild(new Text(line, 1, 0));
			addWorkerActivityPreview(this.container, this.theme, selectedRow, listWidth - 2);
		}

		this.container.addChild(new DynamicBorder(divider));
		this.container.addChild(new Text(dim("↑↓ move · Tab switch · Enter details · l load · c continue · a attach tmux · x stop · ? help · Esc close"), 1, 0));
		if (this.showHelp) {
			this.container.addChild(new Text(`${muted("Flow")} ${dim("rows stay collapsed; selected preview is informational; nothing enters context until loaded")}`, 1, 0));
			this.container.addChild(new Text(`${muted("Safety")} ${dim("l mounts refs, c sends follow-up, a copies tmux attach command, x deletes worker")}`, 1, 0));
		}
		this.container.addChild(new Text(fitBorder("", "", innerWidth, border, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = this.container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

}

async function showParallelWorkDashboard(ctx: ExtensionCommandContext, workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]>): Promise<ParallelWorkAction> {
	return ctx.ui.custom((tui, theme, _kb, done) => new TrailParallelWorkView(tui, theme, workers, artifactsByWorker, done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "88%", minWidth: 84, maxHeight: "90%", margin: 1 },
	});
}

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
			const git = gitSnapshotLabel(entry.git);
			const meta = [stats, git].filter(Boolean).join(" · ");
			const line = `${marker} ${id} ${accent(mode.padEnd(14))} ${dim(relativeTime(Date.parse(entry.createdAt)).padEnd(9))} ${meta} ${muted(entry.note ?? "")}`;
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
			const git = gitSnapshotLabel(worker.git);
			const summary = workerSummaryName(worker, 48);
			const line = `${marker} ${id} ${state} ${dim(artifacts)} ${dim(age)} ${git ? dim(`${git} `) : ""}${selected ? this.theme.bold(this.theme.fg("text", summary)) : muted(summary)}`;
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
	const workerOnly = subcommand === "tell" || subcommand === "ask" || subcommand === "result" || subcommand === "use";
	const wantWorkers = subcommand === "load" || subcommand === "unload" || subcommand === "delete" || workerOnly;
	const wantCheckpoints = subcommand !== "unload" && !workerOnly;
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

type TrailMessageDetails = { kind: TrailMessageKind; heading?: string; subject?: string; workerId?: string; trail?: { kind: ArtifactKind; title: string; subtitle?: string } };

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

function announceAction(pi: ExtensionAPI, _ctx: ExtensionCommandContext, subject: string, detail?: string, kind: TrailMessageKind = "action", trail?: TrailMessageDetails["trail"], meta: Pick<TrailMessageDetails, "workerId"> = {}): void {
	pi.sendMessage(
		{
			customType: "trail",
			content: detail ?? "",
			display: true,
			details: { kind, subject, heading: `trail · ${kind}`, ...(trail ? { trail } : {}), ...meta } satisfies TrailMessageDetails,
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
		let subject = details.subject;
		let content = typeof message.content === "string" ? message.content : "";
		const liveWorker = details.workerId ? readWorkerStatusSync(details.workerId) : undefined;
		if (liveWorker) {
			subject = workerLaunchSubject(liveWorker);
			content = workerLaunchDetail(liveWorker);
		}
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
	let workerResult: { worker: WorkerStatus; artifacts: Artifact[]; expanded: boolean } | undefined;
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

	const refreshWorkerResultWidget = (): void => {
		const ctx = activeCtx;
		if (!ctx?.hasUI) return;
		if (!workerResult) {
			ctx.ui.setWidget("trail-worker-result", undefined);
			return;
		}
		const snapshot = workerResult;
		ctx.ui.setWidget(
			"trail-worker-result",
			(_tui, theme) => {
				const accent = (s: string) => theme.fg("accent", s);
				const dim = (s: string) => theme.fg("dim", s);
				const muted = (s: string) => theme.fg("muted", s);
				const success = (s: string) => theme.fg("success", s);
				const label = workerSourceLabel(snapshot.worker);
				const chip = workerActivityChip(snapshot.worker);
				const headline = workerResultHeadline(snapshot.worker, snapshot.artifacts, 78);
				const container = new Container();
				container.addChild(new Text(`${accent(theme.bold("trail"))} ${dim("·")} ${success(chip)} ${muted(headline)}  ${dim(`/trail use ${label} · /trail ask ${label}`)}`, 0, 0));
				if (snapshot.expanded) {
					const text = workerResultText(snapshot.worker, snapshot.artifacts, 20).split("\n").slice(1);
					for (const rawLine of text) {
						for (const line of wrapPlainText(rawLine, 110)) container.addChild(new Text(dim(line), 2, 0));
					}
					if (deriveWorkerState(snapshot.worker) === "needs_input") container.addChild(new Text(dim(`reply: /trail tell ${label} <answer>`), 2, 0));
				}
				return container;
			},
			{ placement: "aboveEditor" },
		);
	};

	const showWorkerResultWidget = (worker: WorkerStatus, artifacts: Artifact[], expanded: boolean): void => {
		workerResult = { worker, artifacts, expanded };
		refreshWorkerResultWidget();
	};

	const clearWorkerResultWidget = (): boolean => {
		const had = workerResult !== undefined;
		workerResult = undefined;
		refreshWorkerResultWidget();
		return had;
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
			const { workers: allWorkers, artifactsByWorker } = await readWorkersWithArtifacts(store);
			const workers = allWorkers.filter(isPromptDockWorker);
			if (workers.length === 0) {
				ctx.ui.setWidget("trail-workers", undefined);
				return;
			}
			const rows = workerActivityRows(workers, artifactsByWorker);
			const counts = workerActivityTotals(rows);
			const git = gitSnapshotLabel(readGitSnapshot(ctx.cwd));
			ctx.ui.setWidget(
				"trail-workers",
				(_tui, theme) => ({
					render(width: number): string[] {
						const accent = (s: string) => theme.fg("accent", s);
						const dim = (s: string) => theme.fg("dim", s);
						const muted = (s: string) => theme.fg("muted", s);
						const status = [
							counts.waiting ? `${counts.waiting} waiting` : undefined,
							counts.failed ? `${counts.failed} failed` : undefined,
							counts.readyOpenTodos ? `${counts.readyOpenTodos} ready/open todos` : undefined,
							counts.ready ? `${counts.ready} ready` : undefined,
							counts.active ? `${counts.active} active` : undefined,
						].filter(Boolean).join(" · ") || plural(counts.workers, "worker");
						const todoStatus = counts.todos ? ` ${muted(`todos ${counts.completedTodos}/${counts.todos}`)}` : "";
						const heading = git ? `${accent(theme.bold("trail"))} ${dim("·")} ${dim(git)} ${dim("·")} ${muted(status)}${todoStatus}` : `${accent(theme.bold("trail"))} ${dim("·")} ${muted(status)}${todoStatus}`;
						return [
							truncateToWidth(`${heading}  ${dim("/trail workers · /trail w<N>")}`, width, ""),
							...renderWorkerActivityRows(theme, rows, width),
						];
					},
					invalidate() {},
				}),
				{ placement: "aboveEditor" },
			);
		} catch {
			// best-effort dock; never disturb the session
		}
	};

	const emitWorkerStateArtifact = (_ctx: ExtensionContext, state: WorkerProtocolState, text?: string): void => {
		const message = workerProtocolMessage(state, text);
		pi.sendMessage({
			customType: "trail",
			content: message.content,
			display: true,
			details: {
				kind: message.messageKind,
				heading: "trail · worker",
				subject: message.subject,
				trail: { kind: message.artifactKind, title: message.title, subtitle: message.subtitle },
			} as TrailMessageDetails & { trail: { kind: ArtifactKind; title: string; subtitle: string } },
		}, { triggerTurn: false });
	};

	const refreshWorkerCarryoverForReview = async (): Promise<void> => {
		if (workerId) return;
		try {
			const workers = await createWorkerStore().list();
			await Promise.all(workers.map(async (worker) => {
				loadedArtifacts.unloadSource("worker", worker.id);
				await loadedArtifacts.loadSource({ kind: "worker", worker });
			}));
		} catch {
			// best-effort; the inbox should still open for current-session artifacts
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
			await workerStore.patchStatus(workerId, workerHeartbeatPatch(current, {
				pid: process.pid,
				sessionFile: ctx.sessionManager.getSessionFile?.(),
				artifactCount: artifacts.length,
			}));
		} catch {
			// best-effort heartbeat; never crash the worker
		}
	};

	const applyWorkerState = async (ctx: ExtensionContext, state: WorkerProtocolState, text?: string): Promise<WorkerStatus | undefined> => {
		if (!workerId) return undefined;
		const store = createWorkerStore();
		const current = await store.find(workerId);
		if (!current) return undefined;
		const patch = workerProtocolPatch(current, state, text, {
			id: `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`,
			text: text ?? "",
			createdAt: new Date().toISOString(),
		});
		const updated = patch ? await store.patchStatus(workerId, patch) : current;
		emitWorkerStateArtifact(ctx, state, text);
		await writeWorkerHeartbeat(ctx);
		return updated;
	};

	const applyWorkerTodos = async (ctx: ExtensionContext, items: WorkerTodoInput[]): Promise<WorkerStatus | undefined> => {
		if (!workerId) return undefined;
		const store = createWorkerStore();
		const current = await store.find(workerId);
		if (!current) return undefined;
		const updated = await store.patchStatus(workerId, workerTodosPatch(items));
		await writeWorkerHeartbeat(ctx);
		return updated;
	};

	if (workerId) {
		pi.registerTool({
			name: "trail_todos",
			label: "Trail Todos",
			description: "Trail worker only: publish a small ordered progress checklist visible to the parent session. This replaces the worker progress board; it is intentionally lighter than a dedicated todo extension.",
			promptSnippet: "Publish a small worker progress checklist for the parent dock/dashboard.",
			promptGuidelines: ["Use trail_todos for multi-step worker progress that helps the parent understand status at a glance. Keep it short (3-8 items), ordered, and replace the full list on each update. Use pending, in_progress, or completed."],
			parameters: Type.Object({
				items: Type.Array(Type.Object({
					id: Type.Optional(Type.String({ description: "Stable short id for this item, if useful" })),
					text: Type.String({ description: "Short todo text" }),
					state: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const, { description: "Todo state" })),
					note: Type.Optional(Type.String({ description: "Optional short note, e.g. current blocker or substep" })),
				})),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const updated = await applyWorkerTodos(ctx, params.items as WorkerTodoInput[]);
				const progress = updated ? workerTodoProgress(updated) : { completed: 0, total: 0 };
				return { content: [{ type: "text", text: `Trail todos recorded (${progress.completed}/${progress.total}). Parent can see progress in the worker dock and /trail workers.` }], details: { todoCount: progress.total, completed: progress.completed } };
			},
		});

		pi.registerTool({
			name: "trail_wait",
			label: "Trail Wait",
			description: "Trail worker only: ask the parent session for input and mark this worker waiting.",
			promptSnippet: "Ask parent for input when a Trail worker is blocked.",
			promptGuidelines: ["Use trail_wait when you are a Trail worker and need parent clarification or a decision; do not run /trail wait via bash."],
			parameters: Type.Object({ question: Type.String({ description: "Concise question for the parent session" }) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				await applyWorkerState(ctx, "needs_input", params.question);
				return { content: [{ type: "text", text: workerProtocolResultText("needs_input") }], details: { state: "needs_input", question: params.question } };
			},
		});

		pi.registerTool({
			name: "trail_done",
			label: "Trail Done",
			description: "Trail worker only: mark this worker's useful output ready for parent review.",
			promptSnippet: "Mark Trail worker output ready for parent review.",
			promptGuidelines: ["Use trail_done when you are a Trail worker and have useful output ready; do not run /trail done via bash."],
			parameters: Type.Object({ summary: Type.Optional(Type.String({ description: "Concise summary of completed worker output" })) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const updated = await applyWorkerState(ctx, "ready", params.summary);
				const progress = updated ? workerTodoProgress(updated) : { completed: 0, total: 0 };
				const open = Math.max(0, progress.total - progress.completed);
				const warning = open > 0 ? ` Trail marked ready/open-todos (${progress.completed}/${progress.total}); call trail_todos again if those items are actually complete.` : "";
				return { content: [{ type: "text", text: `${workerProtocolResultText("ready")}${warning}` }], details: { state: open > 0 ? "ready_open_todos" : "ready", summary: params.summary, todoCount: progress.total, todoOpenCount: open } };
			},
		});

		pi.registerTool({
			name: "trail_fail",
			label: "Trail Fail",
			description: "Trail worker only: mark this worker failed with a reason.",
			promptSnippet: "Mark a Trail worker failed when it cannot continue.",
			promptGuidelines: ["Use trail_fail when you are a Trail worker and cannot continue; do not run /trail fail via bash."],
			parameters: Type.Object({ reason: Type.String({ description: "Reason this worker cannot continue" }) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				await applyWorkerState(ctx, "failed", params.reason);
				return { content: [{ type: "text", text: workerProtocolResultText("failed") }], details: { state: "failed", reason: params.reason } };
			},
		});

		pi.on("tool_call", async (event, ctx) => {
			if (!isToolCallEventType("bash", event)) return;
			const intent = parseTrailWorkerShellCommand(event.input.command);
			if (!intent) return;
			await applyWorkerState(ctx, intent.state, intent.text);
			event.input.command = `printf '%s\n' ${shellSingleQuote(workerProtocolResultText(intent.state))}`;
		});
	}

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		pinnedRefs = new Set();
		completedRefs = new Set();
		loadedArtifacts.reset();
		workerResult = undefined;
		loadedCheckpoint = loadedCheckpointFromSession(ctx);
		if (ctx.hasUI) {
			ctx.ui.setWidget("trail-chips", undefined);
			ctx.ui.setWidget("trail-worker-result", undefined);
		}
		setLoadedCheckpointWidget(ctx, loadedCheckpoint);
		void maybeSweep(ctx.cwd);
		if (workerId) {
			void writeWorkerHeartbeat(ctx);
			heartbeatTimer = setInterval(() => void writeWorkerHeartbeat(ctx), 15000);
			heartbeatTimer.unref?.();
		} else if (ctx.hasUI) {
			void refreshWorkerDockWidget();
			workerDockTimer = setInterval(() => void refreshWorkerDockWidget(), 500);
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
		workerResult = undefined;
		loadedCheckpoint = undefined;
		if (ctx.hasUI) {
			ctx.ui.setWidget(TRAIL_CHECKPOINT_WIDGET_ID, undefined);
			ctx.ui.setWidget("trail-worker-result", undefined);
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
		workerResult = undefined;
		refreshChipWidget();
		refreshWorkerResultWidget();
		if (result.expanded === 0) return { action: "continue" };
		return { action: "transform", text: result.text };
	});

	pi.registerCommand("trail", {
		description: "Inspect unresolved agent work and create fresh-session checkpoints",
		getArgumentCompletions: async (prefix: string) => {
			const trimmed = prefix.replace(/^\s+/, "");
			const firstSpace = trimmed.indexOf(" ");
			if (firstSpace === -1) {
				const items = TRAIL_COMMANDS.filter((c) => c.startsWith(trimmed)).map((c) => ({ value: c, label: c }));
				return items.length ? items : null;
			}
			const subcommand = trimmed.slice(0, firstSpace);
			const rest = trimmed.slice(firstSpace + 1);
			if (subcommand === "load" || subcommand === "unload" || subcommand === "delete" || subcommand === "continue" || subcommand === "resume" || subcommand === "tell" || subcommand === "ask" || subcommand === "result" || subcommand === "use") {
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
			const workerStore = createWorkerStore();
			const checkpointStore = createCheckpointStore();
			const workerCommands = createWorkerCommands({
				store: workerStore,
				loadedArtifacts,
				cwd: ctx.cwd,
				parentSession: ctx.sessionManager.getSessionFile?.(),
				notify: (text, level) => notifyTrail(pi, ctx, text, level),
				announce: (subject, detail, kind, trail, meta) => announceAction(pi, ctx, subject, detail, kind, trail, meta),
				emitText: (text, kind, heading) => emitText(pi, ctx, text, kind, heading),
			});
			const checkpointCommands = createCheckpointCommands({
				store: checkpointStore,
				hasUI: ctx.hasUI,
				notify: (text, level) => notifyTrail(pi, ctx, text, level),
				emitText: (text, kind, heading) => emitText(pi, ctx, text, kind, heading),
				confirmDelete: (checkpoint) => confirmDeleteCheckpoint(ctx, checkpoint),
				selectCheckpoint: (summaries, selected, mode) => showCheckpointResumeSelector(ctx, summaries, selected, mode),
				showText: (title, text) => showTextViewer(ctx, title, text),
				editText: (title, text) => ctx.hasUI ? ctx.ui.editor(title, text) : Promise.resolve(undefined),
				startSession: (checkpoint, content) => startCheckpointSession(pi, ctx, checkpoint, content, queueShutdownConsume),
			});
			await createTrailCommandRouter({
				hasUI: ctx.hasUI,
				workerId,
				workerCommands,
				checkpointCommands,
				loadedArtifacts,
				workerStore,
				checkpointStore,
				notify: (text, level) => notifyTrail(pi, ctx, text, level),
				emitText: (text, kind, heading) => emitText(pi, ctx, text, kind, heading),
				announce: (subject, detail, kind) => announceAction(pi, ctx, subject, detail, kind),
				trailUsage,
				renderArtifactList,
				renderParallelWorkList,
				formatArtifact,
				refreshChipWidget,
				refreshWorkerDockWidget,
				refreshWorkerCarryoverForReview,
				showWorkerResult: showWorkerResultWidget,
				clearWorkerResult: clearWorkerResultWidget,
				markArtifactDone: (artifact) => completedRefs.add(artifact.ref),
				applyWorkerState: async (state, text) => { await applyWorkerState(ctx, state, text); },
				createCheckpoint: async (options) => {
					const checkpointLifecycle = await createCheckpointLifecycle(pi, ctx);
					await checkpointLifecycle.create(options);
				},
				createHandoffCheckpoint: async () => {
					const checkpointLifecycle = await createCheckpointLifecycle(pi, ctx);
					await checkpointLifecycle.create({ mode: "handoff", note: "", consumeOnUse: false, raw: false });
				},
				catalog: async () => {
					const config = await loadConfig(ctx.cwd);
					return createArtifactCatalog(ctx, config, loadedArtifacts.carryoverArtifacts());
				},
				readWorkersWithArtifacts: () => readWorkersWithArtifacts(workerStore),
				showParallelWorkDashboard: (workers, artifactsByWorker) => showParallelWorkDashboard(ctx, workers, artifactsByWorker),
				showLoadPicker: (summaries, workers, initialMode) => showLoadPicker(ctx, summaries, workers, initialMode),
				showText: (title, text) => showTextViewer(ctx, title, text),
				showTrailBrowser: (catalog, artifacts, initialMode) => showTrailBrowser(ctx, catalog, artifacts, pinnedRefs, completedRefs, initialMode),
				showArtifact: (catalog, artifact) => showArtifactViewer(ctx, catalog, artifact),
				openFileOrArtifact: async (catalog, artifact) => {
					const filePath = artifactFilePath(artifact, ctx.cwd);
					if (filePath) await showFileViewer(ctx, filePath);
					else await showArtifactViewer(ctx, catalog, artifact);
				},
				input: (title, placeholder) => ctx.hasUI ? ctx.ui.input(title, placeholder) : Promise.resolve(undefined),
				copyText: copyToClipboard,
				announceChipChange: (artifact, mode, result) => announceChipChange(ctx, { displayId: artifact.displayId, ref: artifact.ref, mode, kind: artifact.kind, title: artifact.title }, result),
				parallelKindLabel,
			}).handle(intent);
		},
	});
}
