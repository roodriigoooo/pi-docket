/**
 * Docket — session artifacts as first-class objects.
 *
 * Commands:
 *   /docket                         open inbox
 *   /docket answers [query]          browse assistant/worker answers
 *   /docket log                      audit timeline grouped by episode
 *   /docket search <query>           ranked artifact search
 *   /docket save [flags] [note]
 *   /docket load [id|last|w<N>]
 *   /docket list
 *   /docket delete [id|last|w<N>]
 *   /docket ref <artifact-id>
 *   /docket inject-full <artifact-id>
 *   /docket copy <artifact-id>
 *
 * Save flags:
 *   --once, --summarize, --model, --max-output
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { deriveWorkerState, DOCK_PULSE_INTERVAL_MS, heartbeatArtifactSignature, HEARTBEAT_ARTIFACT_CAP, isPaneHarvestCandidate, isPromptDockWorker, namespaceWorkerArtifacts, workerActivityChip, workerPulseGlyph, workerDisplayName, workerDoneClarificationQuestion, workerHeartbeatPatch, workerLaunchDetail, workerLaunchSubject, workerMascotLines, workerPaneTailArtifact, workerProtocolMessage, workerProtocolPatch, workerProtocolResultText, workerQuestions, workerShortLabel, workerSourceLabel, workerStatusArtifact, workerSummaryName, workerTodoProgress, workerTodosPatch, type WorkerDerivedState, type WorkerDoneInput, type WorkerProtocolState, type WorkerStatus, type WorkerTodoInput } from "./background-work.js";
import { artifactFilePath, createArtifactCatalog, formatArtifact, type ArtifactCatalog } from "./artifact-catalog.js";
import { createCheckpointCommands, type ResumeAction, type ResumeMode, type ResumeSelection } from "./checkpoint-commands.js";
import { createCheckpointLifecycle } from "./checkpoint-lifecycle.js";
import { createCheckpointStore, type CheckpointSummary } from "./checkpoint-store.js";
import { gitSnapshotLabel, readGitSnapshot } from "./git-context.js";
import { createLoadedArtifactContext, type Chip, type ChipToggleResult } from "./loaded-artifact-context.js";
import { loadConfig } from "./docket-config.js";
import { parseDocketCommand, parseDocketWorkerShellCommand, docketUsage, DOCKET_COMMANDS } from "./docket-command-grammar.js";
import { createDocketCommandRouter, type LoadPickerMode, type LoadPickerSelection, type ParallelWorkAction, type ParallelWorkEntry, type DocketBrowserAction, type DocketVerdictAction } from "./docket-command-router.js";
import { availableSources, episodesFromItems, handleNavigatorIntent, initialNavigatorState, navigatorSourceLabel, navigatorViewModel, reviewCategoryLabel, sameNavigatorSource, type EpisodeSummary, type NavigatorAction, type NavigatorIntent, type NavigatorMode, type NavigatorSource, type NavigatorState, type ReviewActionId, type ReviewBucket, type ReviewCategory, type ReviewItem, type ReviewQueueState, type ReviewReasonId } from "./docket-navigator.js";
import type { Artifact, ArtifactKind, CheckpointIndexEntry } from "./types.js";
import { createWorkerCommands, workerAge, workerCompletionCandidates } from "./worker-commands.js";
import { dockRowsForRender, workerActivityPreviewLines, workerActivityRows, workerActivityTotals, type DockRow, type WorkerActivityRow } from "./worker-activity.js";
import { workerChangeSetArtifact, promoteWorkerChangeSet } from "./worker-changes.js";
import { coloredAdditions, coloredDeletions, coloredFileStat, renderGitDiffLine } from "./diff-render.js";
import { conflictSummary, workerConflictMap } from "./worker-conflicts.js";
import { workerResultHeadline, workerResultReport, workerResultText } from "./worker-result.js";
import { captureWorkerPane, createWorkerStore, explicitExtensionArgs, isSharedSessionTarget, projectKey, readWorkerStatusSync, sharedSessionExists, DOCKET_WORKER_ENV, workerInProject, workerProjectKey } from "./worker-store.js";
import { WorkerSnapshotCache, watchWorkersRoot, type Unwatcher } from "./worker-dock-cache.js";
import { appendWorkerEventSync, type WorkerEvent } from "./worker-events.js";
import { formatReadyEmbedMessage } from "./worker-summary-embed.js";
import { dockIdleHideMs, isDockIdleEvictable, pruneAfterMs, selectPrunableWorkers } from "./worker-eviction.js";
import { formatHunkCommentLocation, reviewWorkerChangeSetInHunk, type HunkReviewAction, type HunkReviewComment, type HunkReviewResult } from "./worker-diff-review.js";
import { createDecisionLog, reviewedWorkerIds } from "./decision-log.js";
import { createWorkerKindRegistry, workerKindGuardrailsAppendix, DEFAULT_KIND_NAME, type WorkerKind } from "./worker-kinds.js";
import { workerKindLaunchArgs } from "./worker-spawn-policy.js";
import { installDocketExtensionSurface, type DocketExtensionSurfaceInternals } from "./docket-extension-surface.js";

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

function toolEventTarget(event: { toolName?: string; input?: Record<string, unknown> }): string | undefined {
	const input = event.input;
	if (!input || typeof input !== "object") return undefined;
	const candidates = ["file_path", "path", "filePath", "file", "target", "url", "pattern"] as const;
	for (const key of candidates) {
		const value = (input as Record<string, unknown>)[key];
		if (typeof value === "string" && value.length > 0) {
			const trimmed = value.replace(/^\/Users\/[^/]+\//, "~/").trim();
			return trimmed.length > 48 ? `…${trimmed.slice(-47)}` : trimmed;
		}
	}
	const command = (input as Record<string, unknown>).command;
	if (typeof command === "string" && command.length > 0) {
		const first = command.split(/\s+/)[0] ?? "";
		return first || undefined;
	}
	return undefined;
}

class DocketTextViewer implements Component {
	private offset = 0;
	private column = 0;
	private lines: string[];
	private rendered: string[];
	private cachedWidth?: number;
	private cachedLines?: string[];
	private viewportHeight = 34;

	constructor(private tui: TUI, private theme: any, private title: string, text: string, private done: () => void, private mode?: "diff") {
		const rawLines = text.split("\n");
		this.lines = rawLines;
		this.rendered = this.mode === "diff" ? rawLines.map((line) => renderGitDiffLine(line, this.theme)) : rawLines;
	}

	handleInput(data: string): void {
		const maxOffset = Math.max(0, this.lines.length - this.viewportHeight);
		const half = Math.max(1, Math.floor(this.viewportHeight / 2));
		const page = Math.max(1, this.viewportHeight - 2);
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
			this.done();
			return;
		}
		const before = this.offset;
		const beforeColumn = this.column;
		if (data === "j" || matchesKey(data, Key.down)) this.offset = Math.min(maxOffset, this.offset + 1);
		else if (data === "k" || matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
		else if (data === "J") this.offset = Math.min(maxOffset, this.offset + 5);
		else if (data === "K") this.offset = Math.max(0, this.offset - 5);
		else if (data === "d" || matchesKey(data, Key.ctrl("d"))) this.offset = Math.min(maxOffset, this.offset + half);
		else if (data === "u" || matchesKey(data, Key.ctrl("u"))) this.offset = Math.max(0, this.offset - half);
		else if (data === " " || matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) this.offset = Math.min(maxOffset, this.offset + page);
		else if (data === "b" || matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) this.offset = Math.max(0, this.offset - page);
		else if (data === "g") this.offset = 0;
		else if (data === "G") this.offset = maxOffset;
		else if (data === "h" || matchesKey(data, Key.left)) this.column = Math.max(0, this.column - 8);
		else if (data === "l" || matchesKey(data, Key.right)) this.column += 8;
		else if (data === "0") this.column = 0;
		if (this.offset === before && this.column === beforeColumn) return;
		this.invalidate();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const container = new Box(2, 1, docketCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const outerBorder = (s: string) => this.theme.fg("borderAccent", s);
		const headerLeft = ` ${accent(this.theme.bold("docket · inspect"))} ${dim(this.title)} `;
		const headerRight = ` ${dim(`${Math.min(this.offset + 1, this.lines.length)}-${Math.min(this.offset + 34, this.lines.length)}/${this.lines.length} · col ${this.column}`)} `;
		container.addChild(new Text(fitBorder(headerLeft, headerRight, innerWidth, outerBorder, TOP_CORNERS), 0, 0));
		for (const line of this.rendered.slice(this.offset, this.offset + 34)) {
			const visible = this.column > 0 ? [...line].slice(this.column).join("") : line;
			container.addChild(new Text(truncateToWidth(visible, innerWidth - 2), 1, 0));
		}
		container.addChild(new Text(dim("j/k line · h/l horizontal · 0 left · Space/b page · g/G top/bottom · q close"), 1, 0));
		container.addChild(new Text(fitBorder("", "", innerWidth, outerBorder, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

class DocketFileViewer implements Component {
	private offset = 0;
	private column = 0;
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
		const half = Math.max(1, Math.floor(this.viewportHeight / 2));
		const page = Math.max(1, this.viewportHeight - 2);
		const before = this.offset;
		const beforeColumn = this.column;
		if (data === "j" || matchesKey(data, Key.down)) this.offset = Math.min(maxOffset, this.offset + 1);
		else if (data === "k" || matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
		else if (data === "J") this.offset = Math.min(maxOffset, this.offset + 5);
		else if (data === "K") this.offset = Math.max(0, this.offset - 5);
		else if (data === "d" || matchesKey(data, Key.ctrl("d"))) this.offset = Math.min(maxOffset, this.offset + half);
		else if (data === "u" || matchesKey(data, Key.ctrl("u"))) this.offset = Math.max(0, this.offset - half);
		else if (data === " " || matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) this.offset = Math.min(maxOffset, this.offset + page);
		else if (data === "b" || matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) this.offset = Math.max(0, this.offset - page);
		else if (data === "g") this.offset = 0;
		else if (data === "G") this.offset = maxOffset;
		else if (data === "h" || matchesKey(data, Key.left)) this.column = Math.max(0, this.column - 8);
		else if (data === "l" || matchesKey(data, Key.right)) this.column += 8;
		else if (data === "0") this.column = 0;
		if (this.offset === before && this.column === beforeColumn) return;
		this.invalidate();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const container = new Box(2, 1, docketCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const outerBorder = (s: string) => this.theme.fg("borderAccent", s);

		const lineNumWidth = Math.max(3, String(this.lines.length).length);
		const last = Math.min(this.offset + this.viewportHeight, this.lines.length);
		const visible = this.lines.slice(this.offset, this.offset + this.viewportHeight).map((line) => this.column > 0 ? [...line].slice(this.column).join("") : line);
		const highlighted = highlightCode(visible.join("\n"), this.language);
		const langTag = this.language ?? "text";
		const headerLeft = ` ${accent(this.theme.bold(this.filePath))} ${dim(langTag)} `;
		const headerRight = ` ${dim(`${Math.min(this.offset + 1, this.lines.length)}-${last}/${this.lines.length} · col ${this.column}`)} `;
		container.addChild(new Text(fitBorder(headerLeft, headerRight, innerWidth, outerBorder, TOP_CORNERS), 0, 0));

		for (let i = 0; i < visible.length; i++) {
			const lineNo = this.offset + i + 1;
			const numStr = muted(String(lineNo).padStart(lineNumWidth));
			const code = highlighted[i] ?? "";
			container.addChild(new Text(truncateToWidth(`${numStr}  ${code}`, innerWidth - 2), 1, 0));
		}
		for (let i = visible.length; i < this.viewportHeight; i++) {
			container.addChild(new Text("", 1, 0));
		}

		container.addChild(new Text(dim("j/k line · h/l horizontal · 0 left · Space/b page · g/G top/bottom · q close"), 1, 0));
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
			await showTextViewer(ctx, filePath, `[Docket: ${filePath} is not a file]`);
			return;
		}
		content = await fs.readFile(filePath, "utf8");
	} catch (err) {
		await showTextViewer(ctx, filePath, `[Docket could not read ${filePath}: ${String(err)}]`);
		return;
	}
	const language = getLanguageFromPath(filePath);
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => new DocketFileViewer(tui, theme, filePath, language, content.split("\n"), done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "92%", minWidth: 84, maxHeight: "95%", margin: 1 } },
	);
}

async function showTextViewer(ctx: ExtensionCommandContext, title: string, text: string, mode?: "diff"): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => new DocketTextViewer(tui, theme, title, text, done, mode), {
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
	await showTextViewer(ctx, inspected.title, inspected.text, artifactIsDiffLike(artifact) ? "diff" : undefined);
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

function docketCardBg(theme: any): (s: string) => string {
	return (s: string) => theme.bg("customMessageBg", s);
}

function activePill(theme: any, label: string): string {
	return theme.fg("accent", theme.bold(` ${label} `));
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
		{ value: "log", label: "log" },
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

function artifactIsWorkerChangeSet(artifact: Artifact): boolean {
	return artifactMeta(artifact).workerChangeSet === true;
}

function artifactIsDiffLike(artifact: Artifact): boolean {
	return artifactHasDiff(artifact) || artifactIsWorkerChangeSet(artifact);
}

function colorInlineDiffStats(theme: any, line: string, base: (s: string) => string): string {
	const stat = /\+(\d+)(\s*\/\s*)-(\d+)/g;
	let out = "";
	let last = 0;
	let matched = false;
	let match: RegExpExecArray | null;
	while ((match = stat.exec(line)) !== null) {
		matched = true;
		const prefix = line.slice(last, match.index);
		if (prefix) out += base(prefix);
		out += coloredAdditions(theme, Number(match[1]));
		out += base(match[2] ?? "/");
		out += coloredDeletions(theme, Number(match[3]));
		last = match.index + match[0].length;
	}
	if (!matched) return base(line);
	if (last < line.length) out += base(line.slice(last));
	return out;
}

export function renderArtifactPreviewLines(theme: any, artifact: Artifact, lines: string[]): string[] {
	const isDiffLike = artifactIsDiffLike(artifact);
	const dim = (s: string) => theme.fg("dim", s);
	const muted = (s: string) => theme.fg("muted", s);
	let inDiff = false;
	return lines.map((line) => {
		if (!isDiffLike) return dim(line);
		if (line === "--- diff ---" || (artifactIsWorkerChangeSet(artifact) && line === "Patch:")) {
			inDiff = true;
			return muted(line);
		}
		if (inDiff) return renderGitDiffLine(line, theme);
		return colorInlineDiffStats(theme, line, dim);
	});
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
	if (reasonId === "workerChangeSet") return "worker changes";
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
	if (action === "openVerdict") return "Verdict";
	if (action === "tellWorker") return "Tell worker";
	if (action === "promoteWorker") return "Promote";
	if (action === "openFile") return "Open file";
	if (action === "attachReference") return "Attach";
	if (action === "injectFull") return "Full";
	if (action === "copyArtifact") return "Copy";
	if (action === "pin") return "Pin";
	if (action === "markDone") return "Done";
	if (item.reasonId === "workerFailed" || item.reasonId === "error" || item.reasonId === "failedCommand") return "Inspect failure";
	if (item.reasonId === "workerChangeSet") return "Review diff";
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
	if (item.primaryAction !== "openVerdict" && item.actions.includes("openVerdict")) hints.push("Enter verdict");
	if (item.actions.includes("promoteWorker")) hints.push("P promote");
	if (item.actions.includes("tellWorker")) hints.push("r reply");
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

function categoryCounts(items: ReviewItem[]): Map<ReviewCategory, number> {
	const counts = new Map<ReviewCategory, number>();
	for (const item of items) {
		if (item.category) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
	}
	return counts;
}

function categoryColor(theme: any, category: ReviewCategory | undefined, text: string): string {
	if (category === "needs-decision") return theme.fg("warning", text);
	if (category === "failed-blocked") return theme.fg("error", text);
	if (category === "ready-for-review") return theme.fg("success", text);
	if (category === "patch-proposed") return theme.fg("warning", text);
	if (category === "checkpoint-available") return theme.fg("accent", text);
	if (category === "pinned") return theme.fg("accent", text);
	if (category === "recent") return theme.fg("success", text);
	return theme.fg("muted", text);
}

function chipColor(theme: any, chip: string | undefined, text: string): string {
	if (!chip) return theme.fg("muted", text);
	if (chip === "needs reply") return theme.fg("warning", text);
	if (chip === "failed" || chip === "error") return theme.fg("error", text);
	if (chip === "ready" || chip === "ready · progress") return theme.fg("success", text);
	if (chip === "answer" || chip === "code") return theme.fg("accent", text);
	if (chip === "changed" || chip === "new file") return theme.fg("toolDiffAdded", text);
	if (chip === "stale") return theme.fg("dim", text);
	return theme.fg("muted", text);
}

type InboxButton = { key: string; label: string };

function workerChangeSetLines(artifact: Artifact): string[] {
	if (artifact.meta?.workerChangeSet !== true || !Array.isArray(artifact.meta.changedFiles)) return [];
	return artifact.meta.changedFiles.slice(0, 5).map((entry) => {
		if (!entry || typeof entry !== "object") return undefined;
		const file = entry as { path?: unknown; additions?: unknown; deletions?: unknown };
		if (typeof file.path !== "string") return undefined;
		const adds = typeof file.additions === "number" ? file.additions : 0;
		const dels = typeof file.deletions === "number" ? file.deletions : 0;
		return `${file.path} +${adds}/-${dels}`;
	}).filter((line): line is string => line !== undefined);
}

function inboxButtons(item: ReviewItem, done: boolean): InboxButton[] {
	const primaryLabel = reviewActionLabel(item.primaryAction, item);
	const buttons: InboxButton[] = [{ key: "Enter", label: primaryLabel }];
	const seen = new Set<ReviewActionId>([item.primaryAction]);
	const order: Array<{ id: ReviewActionId; key: string; label: string }> = [
		{ id: "openVerdict", key: "Enter", label: "Verdict" },
		{ id: "promoteWorker", key: "P", label: "Promote" },
		{ id: "inspect", key: "d", label: "Diff" },
		{ id: "tellWorker", key: "r", label: "Reply" },
		{ id: "attachReference", key: "a", label: "Attach" },
		{ id: "copyArtifact", key: "y", label: "Copy" },
		{ id: "markDone", key: "Space", label: done ? "Restore" : "Done" },
	];
	for (const entry of order) {
		if (seen.has(entry.id)) continue;
		if (!item.actions.includes(entry.id)) continue;
		buttons.push({ key: entry.key, label: entry.label });
		seen.add(entry.id);
	}
	return buttons;
}

function navigatorModeLabel(mode: NavigatorMode): string {
	if (mode === "review") return "inbox";
	if (mode === "answers") return "answers";
	return "log";
}

function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function docketStatusLine(mode: NavigatorMode, items: ReviewItem[], artifacts: Artifact[]): string {
	if (artifacts.length === 0) return "quiet until something needs attention";
	if (mode === "answers") return plural(items.length, "answer");
	if (mode === "log") return plural(items.length, "artifact");
	const counts = bucketCounts(items);
	const parts: string[] = [];
	if (counts.needs > 0) parts.push(`${counts.needs} needs attention`);
	if (counts.pinned > 0) parts.push(plural(counts.pinned, "pinned", "pinned"));
	if (parts.length > 0) return parts.join(" · ");
	if (counts.recent > 0) return `✓ all clear · ${plural(counts.recent, "recent item")}`;
	return "✓ all clear";
}

type EmptyDocketMessage = {
	title: string;
	body: string;
	actions: string[];
};

function emptyDocketMessage(state: NavigatorState, hasArtifacts: boolean): EmptyDocketMessage {
	if (!hasArtifacts) {
		return {
			title: "No session activity yet",
			body: "Docket fills as you work: commands, file changes, errors, answers, and checkpoints become browsable here.",
			actions: ["ask agent to inspect a file", "run a command", "load a checkpoint or worker"],
		};
	}
	if (state.mode === "review") {
		return {
			title: "All clear",
			body: "Docket will surface changed files, failures, pinned items, and worker output when they need attention.",
			actions: ["press tab for answers", "press / to search", "pin useful items with p"],
		};
	}
	if (state.mode === "answers") {
		return {
			title: "No answers yet",
			body: "Answers stay quiet until assistant or worker conclusions exist for this source/filter.",
			actions: ["press tab for log", "press / to search", "cycle filters with f"],
		};
	}
	const filter = state.filter === "all" ? "" : `${kindLabel(state.filter)} `;
	return {
		title: `No ${filter}artifacts here`,
		body: "This view is filtered. Your activity may still exist in another source, kind, or mode.",
		actions: ["press f to change filter", "press s to switch source", "press 1 for inbox"],
	};
}

/**
 * Pure key → navigator intent map for the docket overlay. Extracted from the view so the
 * binding table is testable without a TUI. `runAction` intents that the selected item does
 * not support are no-ops downstream (handleNavigatorIntent guards them), so this needs no
 * knowledge of the current selection.
 *
 * Key grammar after the 1c cleanup: reply and save are split off the old overloaded `c`
 * (`r` reply / `b` save), and the duplicate `c`/`t`/`i` aliases are gone. `a` is the one
 * attach key.
 */
export function navigatorKeyIntent(data: string): NavigatorIntent | undefined {
	if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") return { kind: "close" };
	if (data === "j" || matchesKey(data, Key.down)) return { kind: "move", by: 1 };
	if (data === "k" || matchesKey(data, Key.up)) return { kind: "move", by: -1 };
	if (data === "g") return { kind: "top" };
	if (data === "G") return { kind: "bottom" };
	if (data === "/") return { kind: "search" };
	if (data === "1") return { kind: "setMode", mode: "review" };
	if (data === "2") return { kind: "setMode", mode: "answers" };
	if (data === "3") return { kind: "setMode", mode: "log" };
	if (data === "\t" || matchesKey(data, Key.tab)) return { kind: "cycleMode" };
	if (data === "s") return { kind: "cycleSource" };
	if (matchesKey(data, Key.enter)) return { kind: "activatePrimary" };
	if (data === " " || data === "x") return { kind: "runAction", action: "markDone" };
	if (data === "r") return { kind: "runAction", action: "tellWorker" };
	if (data === "b") return { kind: "createCheckpoint" };
	if (data === "P") return { kind: "runAction", action: "promoteWorker" };
	if (data === "d") return { kind: "runAction", action: "inspect" };
	if (data === "a") return { kind: "runAction", action: "attachReference" };
	if (data === "y") return { kind: "runAction", action: "copyArtifact" };
	// Advanced (revealed in ? help): pin, preview, full inject, open file, filter
	if (data === "v") return { kind: "toggleDetail" };
	if (data === "p") return { kind: "runAction", action: "pin" };
	if (data === "I") return { kind: "runAction", action: "injectFull" };
	if (data === "o") return { kind: "runAction", action: "openFile" };
	if (data === "f") return { kind: "cycleFilter" };
	return undefined;
}

export class DocketView implements Component {
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
		private done: (result: DocketBrowserAction | null) => void,
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
		return navigatorKeyIntent(data);
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
			this.done({ action: "save" });
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
		else if (action.id === "openVerdict") this.done({ action: "verdict", artifact });
		else if (action.id === "openFile") this.done({ action: "openFile", artifact });
		else if (action.id === "promoteWorker") this.done({ action: "promoteWorker", artifact });
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

	private inboxCardLines(item: ReviewItem, width: number, accent: (s: string) => string, dim: (s: string) => string, muted: (s: string) => string): string[] {
		const lines: string[] = [];
		const artifact = item.artifact;
		const chip = item.statusChip ? ` ${chipColor(this.theme, item.statusChip, `[${item.statusChip}]`)}` : "";
		lines.push(truncateToWidth(`${this.theme.fg("text", this.theme.bold(item.headline))}${chip}`, width));
		const changeLines = workerChangeSetLines(artifact);
		if (changeLines.length > 0) {
			for (const line of changeLines) lines.push(truncateToWidth(`  ${colorInlineDiffStats(this.theme, line, dim)}`, width));
		} else {
			const bullets = item.recommendations.slice(0, 3);
			for (const bullet of bullets) {
				for (const wrapped of wrapPlainText(`• ${bullet}`, width - 2, 2)) {
					lines.push(truncateToWidth(`  ${dim(wrapped)}`, width));
				}
			}
		}
		const done = this.completedRefs.has(artifact.ref);
		const buttons = inboxButtons(item, done);
		const buttonLine = buttons.map((button, index) => index === 0 ? accent(`[${button.key} ${button.label}]`) : muted(`[${button.key} ${button.label}]`)).join(" ");
		lines.push(truncateToWidth(buttonLine, width));
		const time = relativeTime(artifact.timestamp);
		const footer = [item.provenance, time, `@${artifact.id}`].filter(Boolean).join(" · ");
		lines.push(truncateToWidth(dim(footer), width));
		return lines;
	}

	private renderInboxCard(item: ReviewItem, width: number, accent: (s: string) => string, dim: (s: string) => string, muted: (s: string) => string): void {
		for (const line of this.inboxCardLines(item, width, accent, dim, muted)) this.container.addChild(new Text(line, 1, 0));
	}

	/** Right pane in the two-pane layout: the selection's card plus an evidence preview. */
	private selectionPaneLines(item: ReviewItem, width: number, maxRows: number, accent: (s: string) => string, dim: (s: string) => string, muted: (s: string) => string): string[] {
		const lines = this.inboxCardLines(item, width, accent, dim, muted);
		const preview = this.fullText(item.artifact).split("\n");
		const renderedPreview = renderArtifactPreviewLines(this.theme, item.artifact, preview);
		const room = Math.max(0, maxRows - lines.length - 1);
		if (preview.length > 0 && room > 2) {
			lines.push(dim("·".repeat(Math.max(4, Math.min(width, 40)))));
			for (const line of renderedPreview.slice(0, room - 1)) lines.push(truncateToWidth(line, width));
			if (preview.length > room - 1) lines.push(muted(`… ${preview.length - (room - 1)} more lines · Enter to inspect`));
		}
		return lines.slice(0, maxRows);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const artifacts = this.artifacts;
		this.container = new Box(2, 1, docketCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		// fzf-style persistent preview: list left, selection evidence right. Only the
		// review surface splits; log/answers stay single-column browsing lists.
		const twoPane = this.state.mode === "review" && innerWidth >= 104;
		const view = navigatorViewModel(this.state, artifacts, this.queueState(), twoPane ? 14 : this.state.showDetail ? 7 : 12);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const outerBorder = (s: string) => this.theme.fg("border", s);
		const dividerBorder = (s: string) => this.theme.fg("borderMuted", s);

		const sel = view.selectedItem;
		const sources = availableSources(artifacts);
		const sourceLabel = this.state.source;
		const counts = bucketCounts(view.items);
		const headerLeft = ` ${accent(this.theme.bold("docket"))} ${dim("·")} ${accent(navigatorModeLabel(this.state.mode))} `;
		const headerRight = ` ${dim("Esc close")} `;
		this.container.addChild(new Text(fitBorder(headerLeft, headerRight, innerWidth, outerBorder, TOP_CORNERS), 0, 0));
		const position = view.items.length ? `${view.selected + 1}/${view.items.length}` : "";
		const status = [docketStatusLine(this.state.mode, view.items, artifacts), position].filter(Boolean).join(" · ");
		this.container.addChild(new Text(truncateToWidth(` ${muted(status)}`, innerWidth - 2), 1, 0));
		if (this.state.filter !== "all") this.container.addChild(new Text(`${muted("filter")} ${filterBar(this.theme, this.state.filter)}`, 1, 0));
		const sourceLine = sourceBar(this.theme, sources, sourceLabel);
		if (sources.length > 1 && sourceLine) this.container.addChild(new Text(sourceLine, 1, 0));
		this.container.addChild(new DynamicBorder(dividerBorder));

		const listWidth = Math.max(30, innerWidth);
		if (view.visible.length === 0) {
			const empty = emptyDocketMessage(this.state, artifacts.length > 0);
			const emptyWidth = Math.max(20, listWidth - 2);
			this.container.addChild(new Spacer(1));
			this.container.addChild(new Text(truncateToWidth(` ${accent(this.theme.bold(empty.title))}`, emptyWidth), 1, 0));
			this.container.addChild(new Text(truncateToWidth(` ${muted(empty.body)}`, emptyWidth), 1, 0));
			this.container.addChild(new Text(truncateToWidth(` ${dim(`Try: ${empty.actions.join(" · ")}`)}`, emptyWidth), 1, 0));
			this.container.addChild(new Spacer(1));
		} else if (this.state.mode === "review") {
			const catCounts = categoryCounts(view.items);
			const rowWidth = twoPane ? Math.max(36, Math.floor(innerWidth * 0.46)) : listWidth - 2;
			const listLines: string[] = [];
			for (let i = 0; i < view.visible.length; i++) {
				const item = view.visible[i];
				if (!item) continue;
				const absolute = view.visibleStart + i;
				const selected = absolute === view.selected;
				const previousCategory = absolute > 0 ? view.items[absolute - 1]?.category : undefined;
				if (item.category && item.category !== previousCategory) {
					const count = catCounts.get(item.category) ?? 0;
					const label = `${reviewCategoryLabel(item.category)} · ${count}`;
					listLines.push(truncateToWidth(` ${categoryColor(this.theme, item.category, this.theme.bold(label))}`, rowWidth));
				}
				const marker = selected ? accent("▸") : " ";
				const chip = item.statusChip ? `  ${chipColor(this.theme, item.statusChip, `[${item.statusChip}]`)}` : "";
				const headline = selected ? this.theme.bold(this.theme.fg("text", item.headline)) : this.theme.fg("text", item.headline);
				listLines.push(padAnsi(truncateToWidth(`${marker}  ${headline}${chip}`, rowWidth), rowWidth));
			}
			if (twoPane) {
				const rightWidth = Math.max(24, innerWidth - rowWidth - 3);
				const rightLines = sel ? this.selectionPaneLines(sel, rightWidth, Math.max(listLines.length, 16), accent, dim, muted) : [];
				const vbar = dividerBorder("│");
				for (let i = 0; i < Math.max(listLines.length, rightLines.length); i++) {
					const left = padAnsi(listLines[i] ?? "", rowWidth);
					this.container.addChild(new Text(`${left} ${vbar} ${rightLines[i] ?? ""}`, 1, 0));
				}
			} else {
				for (const line of listLines) this.container.addChild(new Text(line, 1, 0));
			}
		} else if (this.state.mode === "log") {
			const episodes = episodesFromItems(view.items);
			const episodeIndex = new Map<string, EpisodeSummary>();
			for (const ep of episodes) episodeIndex.set(ep.id, ep);
			for (let i = 0; i < view.visible.length; i++) {
				const item = view.visible[i];
				if (!item) continue;
				const artifact = item.artifact;
				const absolute = view.visibleStart + i;
				const selected = absolute === view.selected;
				const episodeId = artifact.source ?? "current";
				const previousEpisodeId = absolute > 0 ? (view.items[absolute - 1]?.artifact.source ?? "current") : undefined;
				if (episodeId !== previousEpisodeId) {
					const ep = episodeIndex.get(episodeId);
					if (ep) {
						const task = ep.taskLabel ? ` · ${ep.taskLabel}` : "";
						const head = ` ${accent(this.theme.bold(ep.label))}${dim(`${task} · ${ep.artifactCount} items`)}`;
						this.container.addChild(new Text(truncateToWidth(head, listWidth - 2), 1, 0));
					}
				}
				const marker = selected ? accent("▸") : " ";
				const glyphText = bucketGlyph(item.bucket, this.state.mode);
				const time = relativeTime(artifact.timestamp);
				const meta = [kindLabel(artifact.kind), time, `@${artifact.id}`].filter(Boolean).join(" · ");
				const indent = "   ";
				const glyph = colorKind(this.theme, artifact.kind, glyphText);
				const title = selected ? this.theme.bold(this.theme.fg("text", artifact.title)) : muted(artifact.title);
				const line = `${marker}${indent}${glyph} ${title}  ${dim(meta)}`;
				const row = padAnsi(truncateToWidth(line, listWidth - 2), listWidth - 2);
				this.container.addChild(new Text(row, 1, 0));
			}
		} else {
			for (let i = 0; i < view.visible.length; i++) {
				const item = view.visible[i];
				if (!item) continue;
				const artifact = item.artifact;
				const absolute = view.visibleStart + i;
				const selected = absolute === view.selected;
				const bucket = item.bucket;
				const marker = selected ? accent("▸") : " ";
				const glyphText = bucketGlyph(bucket, this.state.mode);
				const provenance = artifact.source ? `from ${artifact.source}` : "current";
				const meta = [kindLabel(artifact.kind), provenance, relativeTime(artifact.timestamp), `@${artifact.id}`].filter(Boolean).join(" · ");
				const glyph = colorBucket(this.theme, bucket, this.state.mode, glyphText);
				const title = selected ? this.theme.bold(this.theme.fg("text", artifact.title)) : muted(artifact.title);
				const line = `${marker} ${glyph} ${title} ${dim(meta)}`;
				const row = padAnsi(truncateToWidth(line, listWidth - 2), listWidth - 2);
				this.container.addChild(new Text(row, 1, 0));
			}
		}

		if (sel && !twoPane) {
			const artifact = sel.artifact;
			this.container.addChild(new DynamicBorder(dividerBorder));
			if (this.state.mode === "review") {
				this.renderInboxCard(sel, listWidth - 2, accent, dim, muted);
			} else {
				const primary = reviewActionLabel(sel.primaryAction, sel);
				const focusMeta = [kindLabel(artifact.kind), reviewReasonLabel(sel.reasonId), artifact.source ? `from ${artifact.source}` : "current", relativeTime(artifact.timestamp), `@${artifact.id}`].filter(Boolean).join(" · ");
				this.container.addChild(new Text(truncateToWidth(`${accent(primary)} ${dim("·")} ${muted(artifact.title)}`, listWidth - 2), 1, 0));
				if (focusMeta) this.container.addChild(new Text(truncateToWidth(dim(focusMeta), listWidth - 2), 1, 0));
				const hints = selectedActionHints(sel, this.pinnedRefs.has(artifact.ref), this.completedRefs.has(artifact.ref));
				this.container.addChild(new Text(truncateToWidth(hints.map((hint, index) => index === 0 ? accent(`[${hint}]`) : dim(hint)).join(" · "), listWidth - 2), 1, 0));
			}
		}

		if (this.state.showDetail && view.selectedItem && !twoPane) {
			const artifact = view.selectedItem.artifact;
			this.container.addChild(new DynamicBorder(dividerBorder));
			this.container.addChild(new Text(`${accent("preview")} ${muted(artifact.ref)}`, 1, 0));
			const detail = renderArtifactPreviewLines(this.theme, artifact, this.fullText(artifact).split("\n").slice(0, 14));
			for (const line of detail) this.container.addChild(new Text(truncateToWidth(line, listWidth - 2), 1, 0));
		}

		this.container.addChild(new DynamicBorder(dividerBorder));
		this.container.addChild(new Text(dim(`↑↓ move · / search · b save · ? more · Esc close`), 1, 0));
		if (this.showHelp) {
			this.container.addChild(new Text(`${muted("Card")} ${dim("Enter primary · r reply · b save · Space done · a attach · y copy · d diff · P promote · I inject full · o open file")}`, 1, 0));
			this.container.addChild(new Text(`${muted("Modes")} ${modeBar(this.theme, this.state.mode)} ${dim("· 1 inbox · 2 answers · 3 log · tab cycle")}`, 1, 0));
			this.container.addChild(new Text(`${muted("Source")} ${dim("s switch source · pills above show available scopes")}`, 1, 0));
			this.container.addChild(new Text(`${muted("Filters")} ${dim("f cycle artifact kind")}`, 1, 0));
			this.container.addChild(new Text(`${muted("Advanced")} ${dim("p pin · v preview · x done")}`, 1, 0));
		}
		this.container.addChild(new Text(fitBorder("", "", innerWidth, outerBorder, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = this.container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

async function showDocketBrowser(
	ctx: ExtensionCommandContext,
	catalog: ArtifactCatalog,
	artifacts: Artifact[],
	pinnedRefs: Set<string>,
	completedRefs: Set<string>,
	initialMode: NavigatorMode = "review",
): Promise<DocketBrowserAction | null> {
	return ctx.ui.custom((tui, theme, _kb, done) => new DocketView(tui, theme, artifacts, pinnedRefs, completedRefs, initialMode, (artifact) => catalog.fullText(artifact), done), {
		overlay: true,
		// 92% so the review surface crosses the two-pane breakpoint on ~120-col terminals.
		overlayOptions: { anchor: "center", width: "92%", minWidth: 84, maxHeight: "90%", margin: 1 },
	});
}

type VerdictVerbId = "accept" | "reject" | "rejectStop" | "chat" | "send";
export type VerdictVerb = { id: VerdictVerbId; label: string; description: string; send?: string };

type VerdictPayload = { lines: string[]; additions: number; deletions: number; hunkCount?: number; hasChangeSet: boolean; intent?: string; risk?: string; fileEntries?: Array<{ path: string; additions?: number; deletions?: number }> };

function artifactChangedFiles(artifact: Artifact | undefined): Array<{ path?: unknown; additions?: unknown; deletions?: unknown }> {
	return Array.isArray(artifact?.meta?.changedFiles) ? artifact.meta.changedFiles as Array<{ path?: unknown; additions?: unknown; deletions?: unknown }> : [];
}

function artifactHunkCount(artifact: Artifact | undefined): number | undefined {
	const hunkCount = artifact?.meta?.hunkCount;
	return typeof hunkCount === "number" && Number.isFinite(hunkCount) ? hunkCount : undefined;
}

export function diffBar(additions: number, deletions: number, width: number): string {
	const slots = Math.max(1, Math.floor(width));
	const adds = Math.max(0, additions);
	const dels = Math.max(0, deletions);
	const total = adds + dels;
	if (total <= 0) return "░".repeat(slots);
	if (slots === 1) return adds >= dels ? "█" : "░";
	let addSlots = Math.round((adds / total) * slots);
	if (adds > 0 && addSlots === 0) addSlots = 1;
	if (dels > 0 && addSlots === slots) addSlots = slots - 1;
	return `${"█".repeat(addSlots)}${"░".repeat(slots - addSlots)}`;
}

function coloredDiffBar(theme: any, additions: number, deletions: number, width: number): string {
	const bar = diffBar(additions, deletions, width);
	return `[${[...bar].map((char) => char === "█" ? theme.fg("success", char) : theme.fg("error", char)).join("")}]`;
}

export function verdictVerbs(state: WorkerDerivedState, hasChangeSet: boolean, options: string[] = []): VerdictVerb[] {
	if (state === "needs_input") {
		if (options.length > 0) return [
			...options.map((option): VerdictVerb => ({ id: "send", label: option, description: "send to worker", send: option })),
			{ id: "reject", label: "Steer", description: "something else · stays alive" },
			{ id: "rejectStop", label: "Reject & stop", description: "kill worker + remove workspace" },
			{ id: "chat", label: "Chat", description: "type a reply" },
		];
		return [
			{ id: "accept", label: "Accept", description: "approve · worker continues" },
			{ id: "reject", label: "Reject", description: "redirect · stays alive" },
			{ id: "rejectStop", label: "Reject & stop", description: "kill worker + remove workspace" },
			{ id: "chat", label: "Chat", description: "type a reply" },
		];
	}
	if (state === "failed") return [
		{ id: "accept", label: "Retry", description: "relaunch worker" },
		{ id: "reject", label: "Dismiss", description: "drop from inbox" },
		{ id: "rejectStop", label: "Reject & stop", description: "kill worker + remove workspace" },
		{ id: "chat", label: "Chat", description: "send follow-up" },
	];
	return [
		{ id: "accept", label: hasChangeSet ? "Promote" : "Acknowledge", description: hasChangeSet ? "apply diff into your worktree" : "mark reviewed" },
		{ id: "reject", label: hasChangeSet ? "Discard" : "Dismiss", description: hasChangeSet ? "drop changes · keep worktree" : "drop from inbox" },
		{ id: "rejectStop", label: "Reject & stop", description: "kill worker + remove workspace" },
		{ id: "chat", label: "Chat", description: hasChangeSet ? "send back for revision" : "send follow-up" },
	];
}

/**
 * Maps a digit keypress to a wait-option on the verdict card. Only `send` verbs (the
 * worker's offered options) are reachable by number — number keys never fire a destructive
 * verb like reject & stop. Pure so the binding is testable without a TUI.
 */
export function verdictOptionForDigit(verbs: VerdictVerb[], data: string): VerdictVerb | undefined {
	if (!/^[1-9]$/.test(data)) return undefined;
	const verb = verbs[Number(data) - 1];
	return verb && verb.send !== undefined ? verb : undefined;
}

function workerIntentLine(worker: WorkerStatus): string | undefined {
	const summary = typeof worker.summary === "string" ? worker.summary : "";
	const line = summary.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0);
	return line && line.length > 0 ? line : undefined;
}

function primaryWorkerQuestion(worker: WorkerStatus) {
	const questions = workerQuestions(worker);
	return questions.length ? questions[questions.length - 1] : undefined;
}

export function workerVerdictPayload(worker: WorkerStatus, changeSet?: Artifact): VerdictPayload {
	const state = deriveWorkerState(worker);
	if (state === "needs_input") {
		const lines = workerQuestions(worker).map((question) => question.text);
		const risk = primaryWorkerQuestion(worker)?.risk;
		return { lines: lines.length ? lines : [worker.question ?? "Worker needs input."], additions: 0, deletions: 0, hasChangeSet: false, ...(risk ? { risk } : {}) };
	}
	if (state === "failed") return { lines: [worker.lastError ?? "Worker failed."], additions: 0, deletions: 0, hasChangeSet: false };
	const changedFiles = artifactChangedFiles(changeSet);
	if (changedFiles.length > 0) {
		const totals = changedFiles.reduce<{ additions: number; deletions: number }>((acc, file) => {
			const additions = typeof file.additions === "number" ? file.additions : 0;
			const deletions = typeof file.deletions === "number" ? file.deletions : 0;
			return { additions: acc.additions + additions, deletions: acc.deletions + deletions };
		}, { additions: 0, deletions: 0 });
		const hunkCount = artifactHunkCount(changeSet);
		const fileLines = changedFiles.slice(0, 5).map((file) => {
			const filePath = typeof file.path === "string" ? file.path : "unknown";
			const additions = typeof file.additions === "number" ? file.additions : 0;
			const deletions = typeof file.deletions === "number" ? file.deletions : 0;
			return `${filePath}   +${additions}/-${deletions}`;
		});
		const fileEntries = changedFiles.slice(0, 5).map((file) => ({
			path: typeof file.path === "string" ? file.path : "unknown",
			...(typeof file.additions === "number" ? { additions: file.additions } : {}),
			...(typeof file.deletions === "number" ? { deletions: file.deletions } : {}),
		}));
		const intent = workerIntentLine(worker);
		return { lines: fileLines, additions: totals.additions, deletions: totals.deletions, hunkCount, hasChangeSet: true, fileEntries, ...(intent ? { intent } : {}) };
	}
	const lines = [worker.summary, ...(worker.recommended ?? [])].filter((line): line is string => typeof line === "string" && line.trim().length > 0);
	return { lines: lines.length ? lines : ["Worker ready."], additions: 0, deletions: 0, hasChangeSet: false };
}

export class DocketVerdictView implements Component {
	private container: Container | Box = new Container();
	private selected = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly changeSet?: Artifact;
	private readonly options: string[];
	private readonly recommend?: string;
	private readonly timer?: NodeJS.Timeout;

	constructor(
		private tui: TUI,
		private theme: any,
		private worker: WorkerStatus,
		changeSet: Artifact | undefined,
		private done: (result: DocketVerdictAction | null) => void,
		private remaining = 0,
		private paneTail?: string,
	) {
		this.changeSet = changeSet;
		const question = primaryWorkerQuestion(worker);
		this.options = deriveWorkerState(worker) === "needs_input" && question?.options ? question.options : [];
		this.recommend = question?.recommend;
		const recommendIndex = this.recommend ? this.options.indexOf(this.recommend) : -1;
		if (recommendIndex >= 0) this.selected = recommendIndex;
		const state = deriveWorkerState(worker);
		if (state === "starting" || state === "thinking") {
			this.timer = setInterval(() => this.tui.requestRender(), DOCK_PULSE_INTERVAL_MS);
			this.timer.unref?.();
		}
	}

	private finish(result: DocketVerdictAction | null): void {
		if (this.timer) clearInterval(this.timer);
		this.done(result);
	}

	handleInput(data: string): void {
		const state = deriveWorkerState(this.worker);
		const verbs = verdictVerbs(state, this.changeSet !== undefined, this.options);
		const max = Math.max(0, verbs.length - 1);
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
			this.finish(null);
			return;
		}
		const digitOption = verdictOptionForDigit(verbs, data);
		if (digitOption) {
			this.finish({ verb: digitOption.id, worker: this.worker, ...(this.changeSet ? { changeSet: this.changeSet } : {}), text: digitOption.send });
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) this.selected = Math.min(max, this.selected + 1);
		else if (data === "k" || matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (data === "g") this.selected = 0;
		else if (data === "G") this.selected = max;
		else if (data === "d" && this.changeSet) {
			this.finish({ verb: "diff", worker: this.worker, changeSet: this.changeSet });
			return;
		}
		else if (data === "h" && this.changeSet) {
			this.finish({ verb: "hunk", worker: this.worker, changeSet: this.changeSet });
			return;
		}
		else if (matchesKey(data, Key.enter)) {
			const verb = verbs[this.selected];
			if (verb) this.finish({ verb: verb.id, worker: this.worker, ...(this.changeSet ? { changeSet: this.changeSet } : {}), ...(verb.send !== undefined ? { text: verb.send } : {}) });
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
		this.container = new Box(2, 1, docketCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		const listWidth = Math.max(30, innerWidth);
		const state = deriveWorkerState(this.worker);
		const payload = workerVerdictPayload(this.worker, this.changeSet);
		const verbs = verdictVerbs(state, payload.hasChangeSet, this.options);
		this.selected = Math.min(this.selected, Math.max(0, verbs.length - 1));
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const text = (s: string) => this.theme.fg("text", s);
		const border = (s: string) => this.theme.fg("border", s);
		const divider = (s: string) => this.theme.fg("borderMuted", s);
		const warning = (s: string) => this.theme.fg("warning", s);
		const stateLabel = state === "ready_open_todos" ? "ready · progress" : state.replace(/_/g, " ");
		const active = state === "starting" || state === "thinking";
		const glyph = active ? workerPulseGlyph() : "●";
		const label = workerSourceLabel(this.worker);
		const task = workerSummaryName(this.worker, 28);
		const headerLeft = ` ${accent(this.theme.bold("docket"))} ${dim("·")} ${accent("verdict")} `;
		const headerRight = ` ${dim("Esc close")} `;
		this.container.addChild(new Text(fitBorder(headerLeft, headerRight, innerWidth, border, TOP_CORNERS), 0, 0));
		const head = `${workerStateColor(this.theme, state, glyph)}  ${text(`${label} · ${task}`)}  ${muted(`${stateLabel} · ${relativeTime(Date.parse(this.worker.updatedAt))}`)}`;
		this.container.addChild(new Text(truncateToWidth(` ${head}`, listWidth - 2), 1, 0));
		this.container.addChild(new Spacer(1));
		if (payload.hasChangeSet) {
			if (payload.intent) {
				for (const wrapped of wrapPlainText(payload.intent, listWidth - 4, 2)) this.container.addChild(new Text(truncateToWidth(`  ${text(wrapped)}`, listWidth - 2), 1, 0));
				this.container.addChild(new Spacer(1));
			}
			const hunk = payload.hunkCount === undefined ? "" : `   ${muted(`${payload.hunkCount} hunk${payload.hunkCount === 1 ? "" : "s"}`)}`;
			const files = artifactChangedFiles(this.changeSet).length;
			const stat = `${muted(`${files} file${files === 1 ? "" : "s"}`)}   ${coloredAdditions(this.theme, payload.additions)} ${dim("/")} ${coloredDeletions(this.theme, payload.deletions)}   ${coloredDiffBar(this.theme, payload.additions, payload.deletions, 14)}${hunk}`;
			this.container.addChild(new Text(truncateToWidth(` ${stat}`, listWidth - 2), 1, 0));
			const entries = payload.fileEntries ?? [];
			for (let i = 0; i < payload.lines.length; i++) {
				const entry = entries[i];
				const rendered = entry
					? `${dim(entry.path)}   ${coloredFileStat(this.theme, entry.additions, entry.deletions)}`
					: dim(payload.lines[i]!);
				this.container.addChild(new Text(truncateToWidth(`   ${rendered}`, listWidth - 2), 1, 0));
			}
		} else {
			if (payload.risk) {
				for (const wrapped of wrapPlainText(payload.risk, listWidth - 6, 2)) this.container.addChild(new Text(truncateToWidth(`  ${warning(`⚠ ${wrapped}`)}`, listWidth - 2), 1, 0));
				this.container.addChild(new Spacer(1));
			}
			for (const line of payload.lines.slice(0, 5)) {
				for (const wrapped of wrapPlainText(line, listWidth - 4, 3)) this.container.addChild(new Text(truncateToWidth(`  ${text(wrapped)}`, listWidth - 2), 1, 0));
			}
			if (state === "failed" && this.paneTail) {
				const tailLines = this.paneTail.replace(/\s+$/, "").split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-6);
				if (tailLines.length > 0) {
					this.container.addChild(new Spacer(1));
					this.container.addChild(new Text(truncateToWidth(`  ${muted("terminal tail")}`, listWidth - 2), 1, 0));
					for (const line of tailLines) this.container.addChild(new Text(truncateToWidth(`  ${dim(line)}`, listWidth - 2), 1, 0));
				}
			}
		}
		this.container.addChild(new DynamicBorder(divider));
		const optionCount = this.options.length;
		for (let i = 0; i < verbs.length; i++) {
			const verb = verbs[i]!;
			const selected = i === this.selected;
			const marker = selected ? accent("▸") : " ";
			// Reject & stop kills the worker and removes its workspace. Set it apart with a
			// blank line and warning color so it never reads as the next routine step.
			const destructive = verb.id === "rejectStop";
			if (destructive) this.container.addChild(new Spacer(1));
			if (verb.send !== undefined) {
				// Number the offered options so they can be picked directly with 1..9.
				const number = dim(`${i + 1} `);
				const badge = this.recommend && verb.send === this.recommend ? muted(" · recommended") : "";
				const optionLabel = selected ? accent(this.theme.bold(verb.label)) : text(verb.label);
				this.container.addChild(new Text(truncateToWidth(` ${marker} ${number}${optionLabel}${badge}`, listWidth - 2), 1, 0));
			} else {
				const padded = verb.label.padEnd(14);
				const labelText = destructive
					? warning(selected ? this.theme.bold(padded) : padded)
					: selected ? accent(this.theme.bold(padded)) : text(padded);
				const descText = destructive ? warning(verb.description) : dim(verb.description);
				this.container.addChild(new Text(truncateToWidth(` ${marker} ${labelText} ${descText}`, listWidth - 2), 1, 0));
			}
		}
		this.container.addChild(new DynamicBorder(divider));
		const diffHint = this.changeSet ? "d full diff · h Hunk review · " : "";
		const pickHint = optionCount > 0 ? `1-${optionCount} pick · ` : "";
		const exitHint = this.remaining > 0 ? `Esc stop · ${this.remaining} more` : "Esc close";
		this.container.addChild(new Text(dim(`${diffHint}${pickHint}↑↓ move · Enter select · ${exitHint}`), 1, 0));
		this.container.addChild(new Text(fitBorder("", "", innerWidth, border, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = this.container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

async function showWorkerVerdict(ctx: ExtensionCommandContext, worker: WorkerStatus, remaining = 0): Promise<DocketVerdictAction | null> {
	const state = deriveWorkerState(worker);
	const changeSet = state === "ready" || state === "ready_open_todos" ? workerChangeSetArtifact(worker) : undefined;
	const paneTail = state === "failed" && worker.paneCapturedAt ? await createWorkerStore().readPaneTail(worker.id) : undefined;
	return ctx.ui.custom<DocketVerdictAction | null>((tui, theme, _kb, done) => new DocketVerdictView(tui, theme, worker, changeSet, done, remaining, paneTail), {
		overlay: true,
		overlayOptions: { anchor: "bottom-center", width: "72%", minWidth: 64, maxHeight: "70%", margin: 1, offsetY: -1 },
	});
}

class HunkExternalReviewView implements Component {
	private launched = false;

	constructor(
		private tui: TUI,
		private theme: any,
		private label: string,
		private run: () => Promise<HunkReviewResult>,
		private done: (result: HunkReviewResult) => void,
	) {
		setTimeout(() => { void this.launch(); }, 0);
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	private async launch(): Promise<void> {
		if (this.launched) return;
		this.launched = true;
		let result: HunkReviewResult;
		let stopped = false;
		try {
			this.tui.requestRender(true);
			await new Promise((resolve) => setTimeout(resolve, 25));
			// Hunk is a full-screen TUI; Pi must release stdin/raw mode while it runs.
			this.tui.stop();
			stopped = true;
			result = await this.run();
		} catch (err) {
			result = { available: true, comments: [], message: `Hunk review failed: ${String(err)}` };
		} finally {
			if (stopped) {
				this.tui.start();
				this.tui.requestRender(true);
			}
		}
		this.done(result);
	}

	render(width: number): string[] {
		const dim = (s: string) => this.theme.fg("dim", s);
		return [
			dim(truncateToWidth(`Opening Hunk for ${this.label}…`, width)),
			dim(truncateToWidth("Pi TUI paused while Hunk owns terminal. Exit Hunk to return.", width)),
		];
	}
}

async function reviewWorkerChangeSetInHunkFromTui(ctx: ExtensionCommandContext, worker: WorkerStatus, changeSet: Artifact): Promise<HunkReviewResult> {
	if (!ctx.hasUI) return { available: true, comments: [], message: "Hunk review requires Pi TUI." };
	const label = workerSourceLabel(worker);
	return ctx.ui.custom<HunkReviewResult>(
		(tui, theme, _kb, done) => new HunkExternalReviewView(tui, theme, label, () => reviewWorkerChangeSetInHunk(worker, changeSet), done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 64, maxHeight: 4, margin: 1 } },
	);
}

async function chooseHunkReviewAction(ctx: ExtensionCommandContext, worker: WorkerStatus, comments: HunkReviewComment[]): Promise<HunkReviewAction> {
	if (!ctx.hasUI) return "ignore";
	const preview = comments.slice(0, 3).map((comment, index) => `${index + 1}. ${formatHunkCommentLocation(comment)} — ${comment.summary}`).join("\n");
	const overflow = comments.length > 3 ? `\n… ${comments.length - 3} more` : "";
	if (preview) ctx.ui.notify(`${preview}${overflow}`, "info");
	const choice = await ctx.ui.select(
		`Hunk comments for ${workerSourceLabel(worker)}`,
		[
			`Send to ${workerSourceLabel(worker)} for revision`,
			"Copy comments to clipboard",
			"Ignore for now",
		],
	).catch(() => undefined);
	if (choice?.startsWith("Send")) return "send";
	if (choice?.startsWith("Copy")) return "copy";
	return "ignore";
}

function compactTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

class DocketResumeView implements Component {
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
		this.container = new Box(2, 1, docketCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const outerBorder = (s: string) => this.theme.fg("borderAccent", s);
		const dividerBorder = (s: string) => this.theme.fg("borderMuted", s);
		const listWidth = Math.max(30, innerWidth);
		const start = Math.max(0, Math.min(this.selected - 5, this.summaries.length - 11));
		const visible = this.summaries.slice(start, start + 11);

		const headerLeft = ` ${accent(this.theme.bold(`docket · ${this.mode}`))} ${dim(`${this.summaries.length} checkpoint${this.summaries.length === 1 ? "" : "s"}`)} `;
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
	return ctx.ui.custom((tui, theme, _kb, done) => new DocketResumeView(tui, theme, summaries, selected, done, mode), {
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
	if (state === "reviewed") return theme.fg("dim", text);
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

function fitColumn(text: string, width: number): string {
	return padAnsi(truncateToWidth(text, width, ""), width);
}

type WorkerTableColumns = { label: number; status: number; task: number; result: number };

function workerRowNeedsAction(row: WorkerActivityRow): boolean {
	if (row.loaded && (row.state === "ready" || row.state === "ready_open_todos")) return false;
	return row.state === "needs_input" || row.state === "failed" || row.state === "ready" || row.state === "ready_open_todos";
}

function workerStatusBadgeLabel(row: WorkerActivityRow): string {
	if (row.loaded && (row.state === "ready" || row.state === "ready_open_todos")) return "loaded";
	if (row.state === "needs_input") return "needs input";
	if (row.state === "ready_open_todos") return "ready";
	if (row.state === "thinking" || row.state === "starting") return "active";
	if (row.state === "empty") return "done";
	return row.state.replace(/_/g, " ");
}

function workerStatusText(row: WorkerActivityRow): string {
	return `[${workerStatusBadgeLabel(row)}]`;
}

function workerStatusBadge(theme: any, row: WorkerActivityRow, selected: boolean): string {
	const badge = workerStatusText(row);
	const styled = row.state === "failed"
		? theme.fg("error", badge)
		: workerRowNeedsAction(row)
			? theme.fg("warning", badge)
			: row.state === "ready" || row.state === "ready_open_todos"
				? theme.fg("success", badge)
				: selected ? theme.fg("text", badge) : theme.fg("muted", badge);
	return selected ? theme.bold(styled) : styled;
}

function workerResultLabel(row: WorkerActivityRow): string {
	return row.outputLabel.replace(/(\d+\/\d+) progress/g, "$1 todos");
}

function workerTableColumns(width: number): WorkerTableColumns {
	const label = 5;
	const status = 15;
	const result = Math.max(22, Math.min(34, Math.floor(width * 0.26)));
	const fixed = 1 + 4 + label + status + result;
	return { label, status, result, task: Math.max(18, width - fixed) };
}

function workerActivityHeaderText(width: number): string {
	if (width < 92) return truncateToWidth("  worker  status         task — result", width, "");
	const cols = workerTableColumns(width);
	return truncateToWidth(`  ${fitColumn("work", cols.label)} ${fitColumn("status", cols.status)} ${fitColumn("task", cols.task)} ${fitColumn("result", cols.result)}`, width, "");
}

function workerActivityRowText(row: WorkerActivityRow, width: number, selected = false): string {
	const rail = selected ? "▌" : " ";
	if (width < 92) {
		return truncateToWidth(`${rail} ${row.label} ${workerStatusText(row)} ${row.taskLabel} — ${workerResultLabel(row)}`, width, "");
	}
	const cols = workerTableColumns(width);
	const cells = [
		rail,
		fitColumn(row.label, cols.label),
		fitColumn(workerStatusText(row), cols.status),
		fitColumn(row.taskLabel, cols.task),
		fitColumn(workerResultLabel(row), cols.result),
	];
	return truncateToWidth(cells.join(" "), width, "");
}

function renderWorkerActivityRows(theme: any, rows: WorkerActivityRow[], width: number, selectedIndex?: number): string[] {
	return rows.map((row, index) => {
		const selected = selectedIndex === index;
		const raw = workerActivityRowText(row, width, selected);
		const badge = workerStatusText(row);
		const colored = raw.replace(badge, workerStatusBadge(theme, row, selected));
		const line = selected ? theme.fg("text", theme.bold(colored)) : workerStateColor(theme, row.state, colored);
		return selected ? theme.bg("selectedBg", padAnsi(line, width)) : line;
	});
}

function dockRowText(row: DockRow, width: number, now: number): string {
	// Active workers breathe; everyone else (attention, idle) holds a steady dot.
	const marker = row.state === "thinking" || row.state === "starting" ? workerPulseGlyph(now) : "●";
	const kindCell = row.kindLabel ? `·${row.kindLabel}` : "";
	const modelCell = row.modelBadge ? `[${row.modelBadge}]` : "";
	const labelCell = `${row.label}${kindCell}${modelCell}`;
	const stateCell = row.state === "thinking" || row.state === "starting" ? "" : row.state === "ready_open_todos" ? "ready/progress" : row.state.replace(/_/g, " ");
	const docketing = [row.progressLabel, row.ageLabel].filter(Boolean).join(" · ");
	const left = `${marker} ${labelCell}${stateCell ? ` ${stateCell}` : ""} ${row.taskLabel}`.trim();
	const right = [docketing, row.chip].filter(Boolean).join(" ");
	const sep = "  ";
	const rightLen = visibleWidth(right);
	if (!right) return truncateToWidth(left, width, "");
	const leftWidth = Math.max(0, width - rightLen - sep.length);
	const leftFit = truncateToWidth(left, leftWidth, "");
	const leftPad = padAnsi(leftFit, leftWidth);
	return `${leftPad}${sep}${right}`;
}

function renderDockRows(theme: any, rows: DockRow[], width: number, now: number): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const muted = (s: string) => theme.fg("muted", s);
	const out: string[] = [];
	for (const row of rows) {
		const plain = dockRowText(row, width, now);
		out.push(row.attention ? workerStateColor(theme, row.state, plain) : dim(plain));
		if (row.eventLine) {
			const sub = truncateToWidth(`    ${row.eventLine}`, width, "");
			out.push(muted(sub));
		}
	}
	return out;
}

const WORKER_PREVIEW_HEADINGS = new Set(["Task", "Kind", "Progress", "Outcome", "Evidence", "Next actions"]);

function addWorkerActivityPreview(container: Container | Box, theme: any, row: WorkerActivityRow | undefined, width: number, showProgressDetail = false): void {
	if (!row) return;
	const dim = (s: string) => theme.fg("dim", s);
	const muted = (s: string) => theme.fg("muted", s);
	const warning = (s: string) => theme.fg("warning", s);
	container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));
	const lines = workerActivityPreviewLines(row, { showProgressDetail });
	let activeHeading = "";
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		if (WORKER_PREVIEW_HEADINGS.has(raw)) {
			activeHeading = raw;
			const heading = raw === "Next actions" && workerRowNeedsAction(row) ? warning(theme.bold(raw)) : muted(theme.bold(raw));
			container.addChild(new Text(truncateToWidth(heading, width), 1, 0));
			continue;
		}
		const isActionRow = activeHeading === "Next actions";
		const maxLines = isActionRow ? 1 : activeHeading === "Progress" ? (showProgressDetail ? 14 : 5) : 4;
		for (const line of wrapPlainText(raw, width, maxLines)) {
			const colored = isActionRow && workerRowNeedsAction(row) ? warning(line) : dim(line);
			container.addChild(new Text(truncateToWidth(`  ${colored}`, width), 1, 0));
		}
	}
}

async function readWorkerArtifactsForReview(worker: WorkerStatus): Promise<Artifact[]> {
	const store = createWorkerStore();
	const artifacts = await store.readArtifacts(worker.id);
	const status = workerStatusArtifact(worker);
	const changes = worker.state === "ready" || worker.state === "failed" || worker.state === "ended" || worker.state === "needs_input" ? workerChangeSetArtifact(worker) : undefined;
	const paneTail = worker.paneCapturedAt ? await store.readPaneTail(worker.id) : undefined;
	const tail = paneTail ? workerPaneTailArtifact(worker, paneTail) : undefined;
	return [status, changes, ...artifacts.filter((artifact) => artifact.ref !== status?.ref && artifact.ref !== changes?.ref), tail].filter((artifact): artifact is Artifact => artifact !== undefined);
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

async function readWorkersWithArtifacts(store = createWorkerStore(), projectRoot?: string): Promise<{ workers: WorkerStatus[]; artifactsByWorker: Map<string, Artifact[]> }> {
	const workers = await store.list({ ...(projectRoot ? { projectRoot } : {}) });
	const artifactsByWorker = new Map<string, Artifact[]>();
	await Promise.all(workers.map(async (worker) => {
		artifactsByWorker.set(worker.id, await readWorkerArtifactsForReview(worker));
	}));
	return { workers, artifactsByWorker };
}

function renderParallelWorkList(workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]>, options: { groupByProject?: boolean } = {}): string {
	const entries = parallelEntries(workers, artifactsByWorker, "all", "all", new Set());
	if (workers.length === 0) return "No Docket workers";
	const header = `${workers.length} workers · ${entries.length} artifacts`;
	if (!options.groupByProject) {
		const lines = entries.slice(0, 20).map((entry) => `${workerSourceLabel(entry.worker)}\t${entry.artifact.kind}\t${entry.artifact.displayId}\t${entry.artifact.title}`);
		return [header, ...lines].join("\n");
	}
	const projects = [...new Set(workers.map(workerProjectKey))].sort();
	const lines: string[] = [header];
	for (const project of projects) {
		lines.push(`project: ${project}`);
		for (const entry of entries.filter((candidate) => workerProjectKey(candidate.worker) === project).slice(0, 20)) {
			lines.push(`${workerSourceLabel(entry.worker)}\t${entry.artifact.kind}\t${entry.artifact.displayId}\t${entry.artifact.title}`);
		}
	}
	return lines.join("\n");
}

const PEEK_VISIBLE_LINES = 24;
const PEEK_REFRESH_MS = 1000;

export class DocketParallelWorkView implements Component {
	private container: Container | Box = new Container();
	private selected = 0;
	private showHelp = false;
	private showProgressDetail = false;
	private peek = false;
	private peekTimer?: NodeJS.Timeout;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private tui: TUI,
		private theme: any,
		private workers: WorkerStatus[],
		private artifactsByWorker: Map<string, Artifact[]>,
		private done: (result: ParallelWorkAction) => void,
		private groupByProject = false,
		private loadedWorkerIds: ReadonlySet<string> = new Set(),
	) {}

	private finish(result: ParallelWorkAction): void {
		this.setPeek(false);
		this.done(result);
	}

	// Peek repaints on a timer only while open; closing it returns the view to
	// event-driven rendering (same idle discipline as the dock pulse).
	private setPeek(on: boolean): void {
		this.peek = on;
		if (on && !this.peekTimer) {
			this.peekTimer = setInterval(() => {
				this.invalidate();
				this.tui.requestRender();
			}, PEEK_REFRESH_MS);
			this.peekTimer.unref?.();
		} else if (!on && this.peekTimer) {
			clearInterval(this.peekTimer);
			this.peekTimer = undefined;
		}
	}

	private entries(): ParallelWorkEntry[] {
		return parallelEntries(this.workers, this.artifactsByWorker, "all", "all", new Set());
	}

	private activityRows(): WorkerActivityRow[] {
		const rows = workerActivityRows(this.workers, this.artifactsByWorker, { loadedWorkerIds: this.loadedWorkerIds });
		if (!this.groupByProject) return rows;
		return [...rows].sort((a, b) => workerProjectKey(a.worker).localeCompare(workerProjectKey(b.worker)));
	}

	private selectedWorker(): WorkerStatus | undefined {
		return this.activityRows()[this.selected]?.worker;
	}

	private selectedRow(): WorkerActivityRow | undefined {
		return this.activityRows()[this.selected];
	}

	private enterAction(row: WorkerActivityRow): ParallelWorkAction {
		if (row.state === "needs_input" || row.state === "ready" || row.state === "ready_open_todos") return { action: "verdict", worker: row.worker };
		return { action: "details", worker: row.worker };
	}

	private selectNext(): void {
		const max = Math.max(0, this.activityRows().length - 1);
		this.selected = Math.min(max, this.selected + 1);
	}

	handleInput(data: string): void {
		const rows = this.activityRows();
		const max = Math.max(0, rows.length - 1);
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
			if (this.peek) {
				this.setPeek(false);
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			this.finish(null);
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) this.selected = Math.min(max, this.selected + 1);
		else if (data === "k" || matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (data === "g") this.selected = 0;
		else if (data === "G") this.selected = max;
		else if (matchesKey(data, Key.tab)) this.selectNext();
		else if (data === "?") this.showHelp = !this.showHelp;
		else if (data === "t") this.showProgressDetail = !this.showProgressDetail;
		else if (data === "p") this.setPeek(!this.peek);
		else if (matchesKey(data, Key.enter)) {
			const row = this.selectedRow();
			if (row) this.finish(this.enterAction(row));
			return;
		}
		else if (data === "l") {
			const worker = this.selectedWorker();
			if (worker) this.finish({ action: "load", worker });
			return;
		}
		else if (data === "c" || data === "t") {
			const worker = this.selectedWorker();
			if (worker) this.finish({ action: "tell", worker });
			return;
		}
		else if (data === "a") {
			const worker = this.selectedWorker();
			if (worker) this.finish({ action: "copyAttach", worker });
			return;
		}
		else if (data === "x") {
			const worker = this.selectedWorker();
			if (worker) this.finish({ action: "stop", worker });
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

	private renderPeek(row: WorkerActivityRow, width: number): void {
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const divider = (s: string) => this.theme.fg("borderMuted", s);
		const label = workerSourceLabel(row.worker);
		this.container.addChild(new DynamicBorder(divider));
		this.container.addChild(new Text(truncateToWidth(` ${accent("peek")} ${muted(`${label} · live terminal · read-only · refreshes ${PEEK_REFRESH_MS / 1000}s`)}`, width), 1, 0));
		const capture = captureWorkerPane(row.worker, PEEK_VISIBLE_LINES + 40);
		if (capture) {
			const lines = capture.split(/\r?\n/).slice(-PEEK_VISIBLE_LINES);
			for (const line of lines) this.container.addChild(new Text(truncateToWidth(`  ${dim(line)}`, width), 1, 0));
		} else {
			const hint = row.worker.paneCapturedAt
				? "window closed · post-mortem saved as terminal-tail artifact (Enter details)"
				: "window closed · nothing to peek";
			this.container.addChild(new Text(truncateToWidth(`  ${muted(hint)}`, width), 1, 0));
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.container = new Box(2, 1, docketCardBg(this.theme));
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
			workerCounts.readyOpenTodos ? `${workerCounts.readyOpenTodos} ready/progress` : undefined,
			workerCounts.ready ? `${workerCounts.ready} ready` : undefined,
			workerCounts.loaded ? `${workerCounts.loaded} loaded` : undefined,
			workerCounts.active ? `${workerCounts.active} active` : undefined,
		].filter(Boolean).join(" · ") || plural(this.workers.length, "worker");

		this.container.addChild(new Text(fitBorder(` ${accent(this.theme.bold("docket"))} ${dim("· workers")} `, ` ${dim("Esc close")} `, innerWidth, border, TOP_CORNERS), 0, 0));
		const todoStatus = workerCounts.todos ? ` · progress ${workerCounts.completedTodos}/${workerCounts.todos}` : "";
		const artifactStatus = entries.length ? ` · ${entries.length} items` : "";
		this.container.addChild(new Text(truncateToWidth(` ${muted(status)}${dim(todoStatus)}${dim(artifactStatus)}`, innerWidth - 2), 1, 0));
		this.container.addChild(new DynamicBorder(divider));

		if (activityRows.length === 0) {
			const mascotWorker = this.workers[0];
			this.container.addChild(new Spacer(1));
			for (const line of workerMascotLines(mascotWorker)) this.container.addChild(new Text(` ${accent(line)}`, 1, 0));
			this.container.addChild(new Text(fitBorder(` ${accent(this.theme.bold("No parallel work yet"))} `, "", listWidth - 2, divider, TOP_CORNERS), 1, 0));
			this.container.addChild(new Text(truncateToWidth(` ${muted("Spawn a side investigation when you want evidence without interrupting current flow.")}`, listWidth - 2), 1, 0));
			this.container.addChild(new Text(truncateToWidth(` ${dim("Try: /docket spawn <task>")}`, listWidth - 2), 1, 0));
			this.container.addChild(new Text(fitBorder("", "", listWidth - 2, divider, BOTTOM_CORNERS), 1, 0));
			this.container.addChild(new Spacer(1));
		} else {
			this.container.addChild(new Text(dim(workerActivityHeaderText(listWidth - 2)), 1, 0));
			const renderedRows = renderWorkerActivityRows(this.theme, activityRows, listWidth - 2, this.selected);
			let previousProject: string | undefined;
			for (let i = 0; i < activityRows.length; i++) {
				const row = activityRows[i]!;
				if (this.groupByProject) {
					const project = workerProjectKey(row.worker);
					if (project !== previousProject) {
						previousProject = project;
						this.container.addChild(new Text(truncateToWidth(` ${muted("project:")} ${dim(project)}`, listWidth - 2), 1, 0));
					}
				}
				this.container.addChild(new Text(renderedRows[i]!, 1, 0));
			}
			if (this.peek && selectedRow) this.renderPeek(selectedRow, listWidth - 2);
			else addWorkerActivityPreview(this.container, this.theme, selectedRow, listWidth - 2, this.showProgressDetail);
		}

		this.container.addChild(new DynamicBorder(divider));
		this.container.addChild(new Text(dim("Enter verdict/details · p peek · l load · c continue · a attach · x dismiss · ? more · Esc"), 1, 0));
		if (this.showHelp) {
			this.container.addChild(new Text(`${muted("Flow")} ${dim("rows stay collapsed; selected preview is informational; nothing enters context until loaded")}`, 1, 0));
			this.container.addChild(new Text(`${muted("Progress")} ${dim("t toggles full todo board; completion comes only from docket_done")}`, 1, 0));
			this.container.addChild(new Text(`${muted("Peek")} ${dim("p live read-only view of the worker's tmux pane · no attach, no context cost")}`, 1, 0));
			this.container.addChild(new Text(`${muted("Advanced")} ${dim("↑↓ move · t todos · Tab switch worker · x stop worker (destructive)")}`, 1, 0));
		}
		this.container.addChild(new Text(fitBorder("", "", innerWidth, border, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = this.container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

}

async function showParallelWorkDashboard(ctx: ExtensionCommandContext, workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]>, groupByProject = false, loadedWorkerIds: ReadonlySet<string> = new Set()): Promise<ParallelWorkAction> {
	return ctx.ui.custom((tui, theme, _kb, done) => new DocketParallelWorkView(tui, theme, workers, artifactsByWorker, done, groupByProject, loadedWorkerIds), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "88%", minWidth: 84, maxHeight: "90%", margin: 1 },
	});
}

class DocketLoadPicker implements Component {
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
		this.container = new Box(2, 1, docketCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const outerBorder = (s: string) => this.theme.fg("borderAccent", s);
		const dividerBorder = (s: string) => this.theme.fg("borderMuted", s);

		const headerLeft = ` ${accent(this.theme.bold("docket · load"))} ${dim("pick a source")} `;
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
			this.container.addChild(new Text(muted("no workers — /docket spawn <task>, then 2"), 2, 0));
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
	return ctx.ui.custom<LoadPickerSelection>((tui, theme, _kb, done) => new DocketLoadPicker(tui, theme, checkpoints, workers, initialMode, done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "88%", minWidth: 84, maxHeight: "90%", margin: 1 },
	});
}

function renderArtifactList(artifacts: Artifact[]): string {
	if (artifacts.length === 0) return "No Docket artifacts";
	return artifacts.map((a) => `${a.displayId}\t${a.ref}\t${a.kind}\t${a.title}\t${a.subtitle}`).join("\n");
}

const DOCKET_CHECKPOINT_CONTEXT_TYPE = "docket:checkpoint-context";
const DOCKET_CHECKPOINT_WIDGET_ID = "docket-loaded-checkpoint";

type LoadedCheckpoint = {
	id: string;
	mode: CheckpointIndexEntry["mode"];
	note?: string;
	consumeOnUse?: boolean;
};

function checkpointContextContent(checkpoint: CheckpointIndexEntry, content: string): string {
	return [`<<docket-checkpoint ${checkpoint.id}>>`, content.trim(), `<</docket-checkpoint>>`].join("\n");
}

function loadedCheckpointMeta(checkpoint: CheckpointIndexEntry): LoadedCheckpoint {
	return { id: checkpoint.id, mode: checkpoint.mode, note: checkpoint.note, consumeOnUse: checkpoint.consumeOnUse };
}

function loadedCheckpointFromSession(ctx: ExtensionContext): LoadedCheckpoint | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as any;
		if (entry?.type !== "custom_message" || entry.customType !== DOCKET_CHECKPOINT_CONTEXT_TYPE) continue;
		const details = entry.details as Partial<LoadedCheckpoint> | undefined;
		if (typeof details?.id === "string" && typeof details.mode === "string") return details as LoadedCheckpoint;
	}
	return undefined;
}

function setLoadedCheckpointWidget(ctx: ExtensionContext, checkpoint: LoadedCheckpoint | undefined): void {
	if (!ctx.hasUI) return;
	if (!checkpoint) {
		ctx.ui.setWidget(DOCKET_CHECKPOINT_WIDGET_ID, undefined);
		return;
	}
	ctx.ui.setWidget(
		DOCKET_CHECKPOINT_WIDGET_ID,
		(_tui, theme) => {
			const accent = (s: string) => theme.fg("accent", s);
			const dim = (s: string) => theme.fg("dim", s);
			const muted = (s: string) => theme.fg("muted", s);
			const once = checkpoint.consumeOnUse ? muted("/once") : "";
			const note = checkpoint.note ? dim(` · ${truncateToWidth(checkpoint.note, 48)}`) : "";
			const container = new Container();
			container.addChild(new Text(`${accent(theme.bold("docket"))} ${dim("·")} ${accent(`@ckpt:${checkpoint.id}`)}${muted(`/${checkpoint.mode}`)}${once} ${dim("loaded in context")}${note}`, 0, 0));
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
			sessionManager.appendCustomMessageEntry(DOCKET_CHECKPOINT_CONTEXT_TYPE, checkpointContextContent(checkpoint, content), false, checkpointMeta);
		},
		withSession: async (replacementCtx) => {
			setLoadedCheckpointWidget(replacementCtx, checkpointMeta);
			if (checkpoint.consumeOnUse) {
				queueConsume(checkpoint);
				replacementCtx.ui.notify(`Docket loaded checkpoint ${checkpoint.id} (consume on session end)`, "info");
			} else {
				replacementCtx.ui.notify(`Docket loaded checkpoint ${checkpoint.id}`, "info");
			}
		},
	});
	if (result.cancelled) notifyDocket(pi, ctx, "Docket continue cancelled", "info");
}

async function confirmDeleteCheckpoint(ctx: ExtensionCommandContext, checkpoint: CheckpointIndexEntry): Promise<boolean> {
	if (!ctx.hasUI) return true;
	return ctx.ui.confirm("Delete Docket checkpoint?", `Delete checkpoint ${checkpoint.id}? This cannot be undone.`);
}

type QueueConsume = (checkpoint: CheckpointIndexEntry) => void;

type CompletionCandidate = { value: string; label: string };

async function checkpointAndWorkerCandidates(subcommand: string, projectRoot?: string): Promise<CompletionCandidate[]> {
	const workerOnly = subcommand === "tell" || subcommand === "verdict";
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

	if (wantWorkers) out.push(...await workerCompletionCandidates(createWorkerStore(), { ...(projectRoot ? { projectRoot } : {}) }));

	if (subcommand === "unload") out.unshift({ value: "all", label: "all  drop every loaded slot" });

	return out;
}

type DocketMessageKind = "help" | "list" | "notice" | "action" | "success" | "warning" | "error" | "usage";

type DocketMessageDetails = { kind: DocketMessageKind; heading?: string; subject?: string; workerId?: string; docket?: { kind: ArtifactKind; title: string; subtitle?: string } };

const KIND_GLYPH: Record<DocketMessageKind, string> = {
	help: "?",
	list: "≡",
	notice: "·",
	action: "▸",
	success: "✓",
	warning: "!",
	error: "✗",
	usage: "?",
};

const KIND_COLOR: Record<DocketMessageKind, ThemeColor> = {
	help: "accent",
	list: "customMessageLabel",
	notice: "muted",
	action: "accent",
	success: "success",
	warning: "warning",
	usage: "warning",
	error: "error",
};

function emitText(pi: ExtensionAPI, _ctx: ExtensionCommandContext, text: string, kind: DocketMessageKind = "notice", heading?: string, subject?: string): void {
	pi.sendMessage(
		{ customType: "docket", content: text, display: true, details: { kind, heading, subject } satisfies DocketMessageDetails },
		{ triggerTurn: false },
	);
}

function notifyDocket(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else pi.sendMessage({ customType: "docket", content: text, display: true, details: { kind: level === "error" ? "error" : "notice" } satisfies DocketMessageDetails }, { triggerTurn: false });
}

function announceAction(pi: ExtensionAPI, _ctx: ExtensionCommandContext, subject: string, detail?: string, kind: DocketMessageKind = "action", docket?: DocketMessageDetails["docket"], meta: Pick<DocketMessageDetails, "workerId"> = {}): void {
	pi.sendMessage(
		{
			customType: "docket",
			content: detail ?? "",
			display: true,
			details: { kind, subject, heading: `docket · ${kind}`, ...(docket ? { docket } : {}), ...meta } satisfies DocketMessageDetails,
		},
		{ triggerTurn: false },
	);
}

function docketMessageRenderer(): MessageRenderer<DocketMessageDetails> {
	return (message, _options, theme) => {
		const details = (message.details ?? { kind: "notice" }) as DocketMessageDetails;
		const kind = details.kind ?? "notice";
		const labelColor: ThemeColor = KIND_COLOR[kind] ?? "muted";
		const glyph = KIND_GLYPH[kind] ?? "·";
		const headingText = details.heading ?? `docket · ${kind}`;
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

export default function docketExtension(pi: ExtensionAPI) {
	let loadedCheckpoint: LoadedCheckpoint | undefined;
	let activeCtx: ExtensionContext | undefined;
	let sweptOnce = false;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	let lastHeartbeatSignature: string | undefined;
	let workerDockUnwatch: Unwatcher | undefined;
	let workerDockCache: WorkerSnapshotCache | undefined;
	let workerDockPending = false;
	let workerDockRunning = false;
	let workerDockIdleHideMs = 0;
	let sessionProjectKey: string | undefined;
	let dockAnimTimer: NodeJS.Timeout | undefined;
	let dockTui: TUI | undefined;
	const stopDockAnimation = (): void => {
		if (dockAnimTimer) {
			clearInterval(dockAnimTimer);
			dockAnimTimer = undefined;
		}
	};
	// Only repaint on a steady cadence while a worker is actually working. With no active
	// workers the timer is cleared, so an idle dock costs nothing (preserves the 0%-idle promise).
	const syncDockAnimation = (hasActive: boolean): void => {
		if (hasActive && !dockAnimTimer) {
			dockAnimTimer = setInterval(() => dockTui?.requestRender(), DOCK_PULSE_INTERVAL_MS);
			dockAnimTimer.unref?.();
		} else if (!hasActive) {
			stopDockAnimation();
		}
	};
	let workerAutoEmbedSummary = true;
	const workerReadyEmbedEmitted = new Set<string>();
	let workerResult: { worker: WorkerStatus; artifacts: Artifact[]; expanded: boolean } | undefined;
	let loadedWorkerIds = new Set<string>();
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

	// Continue composes load: a continued session auto-mounts the checkpoint's bundle at zero token
	// cost, so the orientation header's artifact refs resolve via /docket ref. Survives restarts
	// because it keys off the checkpoint marker left in the session branch. See ADR-0001.
	const mountLoadedCheckpoint = async (id: string): Promise<void> => {
		try {
			const entry = await createCheckpointStore().find(id, { includeConsumed: true });
			if (entry) await loadedArtifacts.loadCheckpoint(entry);
		} catch { /* best-effort: continue still works without the mount */ }
	};

	const maybeSweep = async (cwd: string): Promise<void> => {
		if (sweptOnce) return;
		sweptOnce = true;
		try {
			const config = await loadConfig(cwd);
			await createCheckpointStore().sweepConsumed(config.consumedRetentionDays);
		} catch { /* best-effort */ }
		await maybeSweepWorkers(cwd);
	};

	const maybeSweepWorkers = async (cwd: string): Promise<void> => {
		try {
			const config = await loadConfig(cwd);
			const pruneMs = pruneAfterMs(config.worker);
			if (pruneMs <= 0) return;
			const store = createWorkerStore();
			const workers = await store.list();
			const targets = selectPrunableWorkers(workers, Date.now(), pruneMs);
			if (targets.length === 0) return;
			// Pruning a terminal worker that never got a verdict is decision debt — log it
			// before the record is gone so /docket log decisions can surface the count.
			const decisionLog = createDecisionLog();
			let reviewed: Set<string>;
			try { reviewed = reviewedWorkerIds(await decisionLog.read()); } catch { reviewed = new Set(); }
			for (const worker of targets) {
				try {
					if (!reviewed.has(worker.id)) {
						await decisionLog.recordEviction({ workerId: worker.id, workerLabel: workerShortLabel(worker.index), state: worker.state, ...(worker.task ? { task: worker.task } : {}) });
					}
				} catch { /* best-effort: never block the prune on the ledger */ }
				try { await store.purge(worker.id); } catch { /* best-effort */ }
			}
		} catch { /* best-effort */ }
	};

	const refreshWorkerResultWidget = (): void => {
		const ctx = activeCtx;
		if (!ctx?.hasUI) return;
		if (!workerResult) {
			ctx.ui.setWidget("docket-worker-result", undefined);
			return;
		}
		const snapshot = workerResult;
		ctx.ui.setWidget(
			"docket-worker-result",
			(_tui, theme) => {
				const accent = (s: string) => theme.fg("accent", s);
				const dim = (s: string) => theme.fg("dim", s);
				const muted = (s: string) => theme.fg("muted", s);
				const success = (s: string) => theme.fg("success", s);
				const warning = (s: string) => theme.fg("warning", s);
				const errorColor = (s: string) => theme.fg("error", s);
				const text = (s: string) => theme.fg("text", s);
				const report = workerResultReport(snapshot.worker, snapshot.artifacts);
				const headline = workerResultHeadline(snapshot.worker, snapshot.artifacts, 78);
				const container = new Container();
				const stateColor = report.state === "failed" ? errorColor : report.state === "needs_input" ? warning : success;
				const headerLine = `${accent(theme.bold("docket"))} ${dim("·")} ${accent(report.label)} ${dim("·")} ${stateColor(report.stateLabel)}  ${muted(headline)}`;
				container.addChild(new Text(headerLine, 0, 0));
				if (!snapshot.expanded) return container;
				const width = 110;
				const indent = 2;
				const factLine = (key: string, value: string) => `${muted(`${key}:`)} ${dim(value)}`;
				container.addChild(new Text(factLine("Task", report.taskLabel), indent, 0));
				container.addChild(new Text(factLine("Progress", report.progressLine), indent, 0));
				container.addChild(new Text(factLine("Changes", report.changesLine), indent, 0));
				const renderSection = (title: string, body: string) => {
					container.addChild(new Text("", indent, 0));
					container.addChild(new Text(accent(theme.bold(title)), indent, 0));
					for (const raw of body.split(/\r?\n/)) {
						for (const line of wrapPlainText(raw, width - 4, 4)) container.addChild(new Text(text(line), indent + 2, 0));
					}
				};
				const primaryTitle = report.primarySection === "question" ? "Question" : report.primarySection === "failure" ? "Failure" : "Outcome";
				renderSection(primaryTitle, report.primaryBody);
				if (report.recommendations.length > 0) {
					container.addChild(new Text("", indent, 0));
					container.addChild(new Text(accent(theme.bold("Recommendations")), indent, 0));
					for (let i = 0; i < report.recommendations.length; i++) {
						const bullet = `${i + 1}. ${report.recommendations[i]}`;
						for (const line of wrapPlainText(bullet, width - 4, 3)) container.addChild(new Text(text(line), indent + 2, 0));
					}
				}
				if (report.references.length > 0) {
					container.addChild(new Text("", indent, 0));
					container.addChild(new Text(accent(theme.bold("Useful references")), indent, 0));
					for (const ref of report.references) {
						const id = accent(`@${ref.displayId}`);
						const tag = dim(`/${kindLabel(ref.kind)}`);
						const label = muted(ref.label);
						container.addChild(new Text(truncateToWidth(`${id}${tag}  ${label}`, width - 4), indent + 2, 0));
					}
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
			ctx.ui.setWidget("docket-chips", undefined);
			return;
		}
		ctx.ui.setWidget(
			"docket-chips",
			(_tui, theme) => {
				const accent = (s: string) => theme.fg("accent", s);
				const dim = (s: string) => theme.fg("dim", s);
				const muted = (s: string) => theme.fg("muted", s);
				const tags = snapshot
					.map((c) => `${accent(`@${c.displayId}${c.mode === "full" ? "*" : ""}`)}${muted(`/${kindLabel(c.kind)}`)}`)
					.join(" ");
				const label = accent(theme.bold("docket"));
				const summary = dim(`${snapshot.length === 1 ? "attached" : `${snapshot.length} attached`} · expands on send · /docket clear`);
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
			result === "added" ? `Docket attached ${name} · expands on send` :
			result === "removed" ? `Docket detached ${name}` :
			result === "upgraded" ? `Docket attached ${name} as full text` :
			`Docket attached ${name} as reference`;
		notifyDocket(pi, ctx, message, "info");
	};

	pi.registerMessageRenderer("docket", docketMessageRenderer());

	const workerId = process.env[DOCKET_WORKER_ENV];

	const kindRegistry = createWorkerKindRegistry();
	let kindRegistryReloaded = false;
	const ensureKindRegistryLoaded = async (cwd: string): Promise<void> => {
		if (kindRegistryReloaded) return;
		kindRegistryReloaded = true;
		await kindRegistry.reload(cwd).catch(() => undefined);
	};
	const docketSurface: DocketExtensionSurfaceInternals = installDocketExtensionSurface(kindRegistry);

	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	const packagedGuardrails = path.join(extensionDir, "worker-guardrails.md");
	let guardrailsCache: { path?: string; text?: string } | undefined;
	async function loadWorkerGuardrails(cwd: string): Promise<string | undefined> {
		if (guardrailsCache !== undefined) return guardrailsCache.text;
		const config = await loadConfig(cwd).catch(() => undefined);
		const override = config?.worker?.guardrailsPath;
		const candidates = [override, packagedGuardrails].filter((value): value is string => typeof value === "string" && value.length > 0);
		for (const candidate of candidates) {
			const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
			try {
				const text = await fs.readFile(resolved, "utf8");
				guardrailsCache = { path: resolved, text };
				return text;
			} catch {
				// try next candidate
			}
		}
		guardrailsCache = {};
		return undefined;
	}

	async function loadWorkerKindForCurrent(cwd: string): Promise<WorkerKind | undefined> {
		if (!workerId) return undefined;
		// Sync fallback first so worker can resolve its kind even before the async reload finishes.
		const sync = (kindRegistry as unknown as { _reloadSync?: (cwd: string) => void })._reloadSync;
		if (sync && !kindRegistryReloaded) sync(cwd);
		await ensureKindRegistryLoaded(cwd);
		const status = readWorkerStatusSync(workerId);
		if (!status?.kind) return undefined;
		return kindRegistry.get(status.kind);
	}

	const updateTmuxStatusLine = (workers: WorkerStatus[]): void => {
		const counts = { needs_input: 0, ready: 0, failed: 0, active: 0 };
		const now = Date.now();
		for (const worker of workers) {
			const state = deriveWorkerState(worker, now);
			if (state === "needs_input") counts.needs_input++;
			else if (state === "ready" || state === "ready_open_todos") counts.ready++;
			else if (state === "failed") counts.failed++;
			else if (state === "thinking" || state === "starting") counts.active++;
		}
		const parts: string[] = [];
		if (counts.needs_input > 0) parts.push(`#[fg=yellow,bold]?${counts.needs_input}#[default]`);
		if (counts.failed > 0) parts.push(`#[fg=red,bold]✗${counts.failed}#[default]`);
		if (counts.ready > 0) parts.push(`#[fg=green]✓${counts.ready}#[default]`);
		if (counts.active > 0) parts.push(`#[fg=blue]●${counts.active}#[default]`);
		const line = parts.length > 0 ? `docket ${parts.join(" ")} ` : "docket · idle ";
		spawnSync("tmux", ["set-option", "-t", "docket-workers", "status-right", line], { stdio: "ignore" });
		spawnSync("tmux", ["set-option", "-t", "docket-workers", "status", "on"], { stdio: "ignore" });
	};

	const reconcileOrphanedWorkers = async (workers: WorkerStatus[]): Promise<void> => {
		const ACTIVE_STATES: Array<WorkerStatus["state"]> = ["starting", "active", "idle", "needs_input"];
		const sharedTargets = workers.filter((w) => isSharedSessionTarget(w.tmuxSession) && ACTIVE_STATES.includes(w.state));
		if (sharedTargets.length === 0) return;
		if (sharedSessionExists()) return;
		const store = createWorkerStore();
		for (const worker of sharedTargets) {
			await store.patchStatus(worker.id, { state: "error", lastError: "tmux session ended; worker terminated" });
		}
	};

	// Workers whose pane stayed alive (e.g. protocol-failed but pi still running) get
	// re-probed on later ticks; settled ones are remembered to avoid repeat tmux calls.
	const paneHarvestSettled = new Set<string>();
	const harvestDeadWorkerPanes = async (workers: WorkerStatus[]): Promise<void> => {
		const store = createWorkerStore();
		for (const worker of workers) {
			if (!isPaneHarvestCandidate(worker)) {
				// Respawn clears paneCapturedAt and leaves the terminal state; forget the
				// settled marker so the relaunched worker's next death gets harvested too.
				paneHarvestSettled.delete(worker.id);
				continue;
			}
			if (paneHarvestSettled.has(worker.id)) continue;
			try {
				const result = await store.harvestPaneTail(worker.id);
				if (result !== "alive") paneHarvestSettled.add(worker.id);
			} catch { /* best-effort post-mortem */ }
		}
	};

	const refreshWorkerDockWidget = async (): Promise<void> => {
		const ctx = activeCtx;
		if (!ctx?.hasUI || workerId) return;
		if (workerDockRunning) {
			workerDockPending = true;
			return;
		}
		workerDockRunning = true;
		try {
			if (!workerDockCache) workerDockCache = new WorkerSnapshotCache(createWorkerStore().root());
			const { workers: allWorkers, artifactsByWorker, eventsByWorker, newEventsByWorker } = await workerDockCache.snapshot();
			for (const [id, events] of newEventsByWorker) {
				for (const ev of events) {
					docketSurface.emitWorkerEvent(id, ev);
					if (
						workerAutoEmbedSummary &&
						ev.kind === "state" &&
						(ev.payload?.state === "ready" || ev.payload?.state === "ready_open_todos") &&
						!workerReadyEmbedEmitted.has(id)
					) {
						const worker = allWorkers.find((w) => w.id === id);
						if (worker) {
							const embed = formatReadyEmbedMessage(worker);
							if (embed) {
								workerReadyEmbedEmitted.add(id);
								try {
									pi.sendMessage({
										customType: "docket",
										content: embed.content,
										display: true,
										details: {
											kind: "action",
											heading: embed.heading,
											subject: embed.subject,
											docket: { kind: "response", title: embed.title, subtitle: embed.subtitle },
										} as DocketMessageDetails & { docket: { kind: ArtifactKind; title: string; subtitle: string } },
									}, { triggerTurn: false });
								} catch {
									workerReadyEmbedEmitted.delete(id);
								}
							}
						}
					}
				}
			}
			const tmuxStatusEnabled = await loadConfig(ctx.cwd).then((c) => c.worker?.tmuxStatusLine === true).catch(() => false);
			if (tmuxStatusEnabled && sharedSessionExists()) updateTmuxStatusLine(allWorkers);
			await reconcileOrphanedWorkers(allWorkers);
			await harvestDeadWorkerPanes(allWorkers);
			const now = Date.now();
			const promptWorkers = allWorkers.filter((worker) => isPromptDockWorker(worker, now) && !isDockIdleEvictable(worker, now, workerDockIdleHideMs));
			const key = sessionProjectKey ?? projectKey(ctx.cwd);
			const workers = promptWorkers.filter((worker) => workerInProject(worker, key));
			const otherWorkers = promptWorkers.filter((worker) => !workerInProject(worker, key));
			const otherProjectCount = new Set(otherWorkers.map(workerProjectKey)).size;
			const otherWaiting = otherWorkers.filter((worker) => deriveWorkerState(worker, now) === "needs_input").length;
			const otherFailed = otherWorkers.filter((worker) => deriveWorkerState(worker, now) === "failed").length;
			const otherReady = otherWorkers.filter((worker) => { const derived = deriveWorkerState(worker, now); return derived === "ready" || derived === "ready_open_todos"; }).length;
			const otherAttentionLabel = [otherWaiting ? `${otherWaiting} waiting` : "", otherFailed ? `${otherFailed} failed` : "", otherReady ? `${otherReady} ready` : ""].filter(Boolean).join(" · ");
			if (workers.length === 0 && otherWorkers.length === 0) {
				stopDockAnimation();
				ctx.ui.setWidget("docket-workers", undefined);
				return;
			}
			const rows = workerActivityRows(workers, artifactsByWorker, { loadedWorkerIds });
			const counts = workerActivityTotals(rows);
			const dockRows = dockRowsForRender(rows, { parentModelId: ctx.model?.id, eventsByWorker });
			syncDockAnimation(dockRows.some((row) => row.state === "thinking" || row.state === "starting"));
			const git = gitSnapshotLabel(readGitSnapshot(ctx.cwd));
			ctx.ui.setWidget(
				"docket-workers",
				(_tui, theme) => ({
					render(width: number): string[] {
						dockTui = _tui;
						const renderNow = Date.now();
						const accent = (s: string) => theme.fg("accent", s);
						const dim = (s: string) => theme.fg("dim", s);
						const attentionParts: string[] = [];
						if (counts.waiting) attentionParts.push(`${counts.waiting} waiting`);
						if (counts.failed) attentionParts.push(`${counts.failed} failed`);
						if (counts.readyOpenTodos) attentionParts.push(`${counts.readyOpenTodos} ready/progress`);
						if (counts.ready) attentionParts.push(`${counts.ready} ready`);
						if (counts.loaded) attentionParts.push(`${counts.loaded} loaded`);
						const idle = counts.workers - counts.waiting - counts.failed - counts.ready - counts.readyOpenTodos - counts.loaded - counts.reviewed;
						const idlePart = idle > 0 ? `${idle} ${idle === 1 ? "running" : "running"}` : "";
						const reviewedPart = counts.reviewed > 0 ? dim(`${counts.reviewed} reviewed`) : "";
						const attentionJoined = attentionParts.length ? attentionParts.join(" · ") : "";
						const summary = counts.workers > 0 ? [attentionJoined, reviewedPart, idlePart || (!attentionJoined && !reviewedPart ? plural(counts.workers, "worker") : "")].filter(Boolean).join(" · ") : "no workers in this project";
						const heading = `${accent(theme.bold("docket"))}${git ? ` ${dim("·")} ${dim(git)}` : ""} ${dim("·")} ${dim(summary)}`;
						const rowWidth = Math.min(width, 110);
						const breadcrumb = otherWorkers.length > 0 ? dim(`↗ ${otherAttentionLabel || `${otherWorkers.length} worker${otherWorkers.length === 1 ? "" : "s"}`} in ${otherProjectCount} other project${otherProjectCount === 1 ? "" : "s"} · /docket workers --all`) : undefined;
						return [
							truncateToWidth(heading, width, ""),
							...renderDockRows(theme, dockRows, rowWidth, renderNow),
							...(breadcrumb ? [truncateToWidth(breadcrumb, width, "")] : []),
						];
					},
					invalidate() {},
				}),
				{ placement: "aboveEditor" },
			);
		} catch {
			// best-effort dock; never disturb the session
		} finally {
			workerDockRunning = false;
			if (workerDockPending) {
				workerDockPending = false;
				void refreshWorkerDockWidget();
			}
		}
	};

	const emitWorkerStateArtifact = (_ctx: ExtensionContext, state: WorkerProtocolState, text?: string): void => {
		const message = workerProtocolMessage(state, text);
		pi.sendMessage({
			customType: "docket",
			content: message.content,
			display: true,
			details: {
				kind: message.messageKind,
				heading: "docket · worker",
				subject: message.subject,
				docket: { kind: message.artifactKind, title: message.title, subtitle: message.subtitle },
			} as DocketMessageDetails & { docket: { kind: ArtifactKind; title: string; subtitle: string } },
		}, { triggerTurn: false });
	};

	const refreshWorkerCarryoverForReview = async (): Promise<void> => {
		if (workerId) return;
		try {
			const workers = await createWorkerStore().list({ ...(sessionProjectKey ? { projectRoot: sessionProjectKey } : {}) });
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
			const fullArtifacts = catalog.list();
			const capped = fullArtifacts.length > HEARTBEAT_ARTIFACT_CAP ? fullArtifacts.slice(-HEARTBEAT_ARTIFACT_CAP) : fullArtifacts;
			const signature = heartbeatArtifactSignature(capped);
			const workerStore = createWorkerStore();
			if (signature !== lastHeartbeatSignature) {
				await workerStore.writeArtifacts(workerId, capped);
				lastHeartbeatSignature = signature;
			}
			const current = await workerStore.find(workerId);
			await workerStore.patchStatus(workerId, {
				...workerHeartbeatPatch(current, {
					pid: process.pid,
					sessionFile: ctx.sessionManager.getSessionFile?.(),
					artifactCount: fullArtifacts.length,
				}),
				...(ctx.model?.id ? { model: ctx.model.id } : {}),
			});
		} catch {
			// best-effort heartbeat; never crash the worker
		}
	};

	const applyWorkerState = async (ctx: ExtensionContext, state: WorkerProtocolState, text?: string, doneInput?: WorkerDoneInput, questionMeta?: { risk?: string; options?: string[]; recommend?: string }): Promise<WorkerStatus | undefined> => {
		if (!workerId) return undefined;
		const store = createWorkerStore();
		const current = await store.find(workerId);
		if (!current) return undefined;
		let nextState = state;
		let nextText = text;
		let nextDoneInput = doneInput;
		if (state === "ready") {
			const config = await loadConfig(ctx.cwd);
			const artifacts = createArtifactCatalog(ctx, config, []).list();
			const question = workerDoneClarificationQuestion(current, doneInput ?? { summary: text }, { artifactEvidenceCount: artifacts.filter((artifact) => artifact.kind === "command" || artifact.kind === "file" || artifact.kind === "code").length });
			if (question) {
				nextState = "needs_input";
				nextText = question;
				nextDoneInput = undefined;
			}
		}
		const patch = workerProtocolPatch(current, nextState, nextText, {
			id: `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`,
			text: nextText ?? "",
			createdAt: new Date().toISOString(),
			...(nextState === "needs_input" && questionMeta ? questionMeta : {}),
		}, nextDoneInput);
		const updated = patch ? await store.patchStatus(workerId, patch) : current;
		emitWorkerStateArtifact(ctx, nextState, nextText);
		appendWorkerEventSync(store.root(), workerId, { kind: "state", payload: { state: nextState, ...(nextText ? { text: nextText } : {}) } });
		await writeWorkerHeartbeat(ctx);
		return updated;
	};

	const applyWorkerTodos = async (ctx: ExtensionContext, items: WorkerTodoInput[]): Promise<WorkerStatus | undefined> => {
		if (!workerId) return undefined;
		const store = createWorkerStore();
		const current = await store.find(workerId);
		if (!current) return undefined;
		const updated = await store.patchStatus(workerId, workerTodosPatch(items));
		if (updated?.todos) {
			const progress = workerTodoProgress(updated);
			appendWorkerEventSync(store.root(), workerId, { kind: "todo", payload: { total: progress.total, completed: progress.completed, inProgress: progress.inProgress } });
		}
		await writeWorkerHeartbeat(ctx);
		return updated;
	};

	if (workerId) {
		void loadWorkerGuardrails(activeCtx?.cwd ?? process.cwd());
		void ensureKindRegistryLoaded(activeCtx?.cwd ?? process.cwd());
		pi.on("before_agent_start", async (event, ctx) => {
			const text = await loadWorkerGuardrails(ctx.cwd);
			if (!text) return;
			const kind = await loadWorkerKindForCurrent(ctx.cwd);
			const appendix = kind ? workerKindGuardrailsAppendix(kind) : "";
			return { systemPrompt: `${event.systemPrompt}\n\n<docket_worker_guardrails>\n${text.trim()}${appendix}\n</docket_worker_guardrails>` };
		});

		let workerProtocolCalledThisTurn = false;
		let workerNudgesThisSession = 0;
		const MAX_WORKER_NUDGES = 1;
		const markWorkerProtocolCalled = (): void => { workerProtocolCalledThisTurn = true; };

		pi.on("turn_start", () => {
			workerProtocolCalledThisTurn = false;
		});

		pi.on("agent_start", async () => {
			try {
				const store = createWorkerStore();
				const current = await store.find(workerId);
				if (current?.state === "idle") await store.patchStatus(workerId, { state: "active" });
			} catch { /* best-effort */ }
		});

		pi.on("agent_end", async () => {
			if (workerProtocolCalledThisTurn) return;
			try {
				const store = createWorkerStore();
				const current = await store.find(workerId);
				if (!current || current.state !== "active") return;
				await store.patchStatus(workerId, { state: "idle" });
				if (workerNudgesThisSession >= MAX_WORKER_NUDGES) return;
				workerNudgesThisSession++;
				pi.sendUserMessage("Docket: this turn ended without calling a protocol tool. If the task is complete with useful output, call `docket_done` with a summary (include a `Recommended:` bullet list if you have recommendations). If you are blocked or any non-trivial assumption is needed, call `docket_wait` with a concise question. If you cannot continue and have no useful partial output, call `docket_fail` with a one-sentence reason. Otherwise continue working.");
			} catch { /* best-effort */ }
		});

		pi.on("input", (event) => {
			if (event.source !== "extension") workerNudgesThisSession = 0;
			return { action: "continue" };
		});

		pi.registerTool({
			name: "docket_todos",
			label: "Docket Progress",
			description: "Docket worker only: publish a small ordered progress checklist visible to the parent session.",
			promptSnippet: "Publish a small worker progress checklist for the parent dock/dashboard.",
			promptGuidelines: ["See <docket_worker_guardrails> for when to call docket_todos and how it differs from a durable task manager."],
			parameters: Type.Object({
				items: Type.Array(Type.Object({
					id: Type.Optional(Type.String({ description: "Stable short id for this item, if useful" })),
					text: Type.String({ description: "Short todo text" }),
					state: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const, { description: "Todo state" })),
					note: Type.Optional(Type.String({ description: "Optional short note, e.g. current blocker or substep" })),
				})),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				markWorkerProtocolCalled();
				const updated = await applyWorkerTodos(ctx, params.items as WorkerTodoInput[]);
				const progress = updated ? workerTodoProgress(updated) : { completed: 0, total: 0 };
				return { content: [{ type: "text", text: `Docket progress recorded (${progress.completed}/${progress.total}). Parent can see it in the worker dock and /docket workers.` }], details: { todoCount: progress.total, completed: progress.completed } };
			},
		});

		pi.registerTool({
			name: "docket_wait",
			label: "Docket Wait",
			description: "Docket worker only: ask the parent session for input and mark this worker waiting.",
			promptSnippet: "Ask parent for input when a Docket worker is blocked or ambiguity is non-trivial.",
			promptGuidelines: ["See <docket_worker_guardrails> for when to call docket_wait. When the decision has discrete answers, pass concrete `options` (and `recommend` your pick) and flag stakes via `risk`. Do not assume; do not run /docket wait via bash."],
			parameters: Type.Object({
				question: Type.String({ description: "Concise question for the parent session" }),
				risk: Type.Optional(Type.String({ description: "One line on the stakes when this is irreversible or unauthorized (e.g. 'drops the sessions table'). Rendered as a warning on the parent's card." })),
				options: Type.Optional(Type.Array(Type.String({ description: "A concrete choice the parent can pick" }), { description: "2–4 concrete options the parent can accept directly; the chosen one is sent back to you verbatim. Omit for open-ended questions." })),
				recommend: Type.Optional(Type.String({ description: "Which option you would choose (must match one of `options`); pre-selected on the parent's card." })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				markWorkerProtocolCalled();
				const options = Array.isArray(params.options) ? params.options.map((option) => String(option).trim()).filter((option) => option.length > 0) : [];
				const questionMeta = {
					...(typeof params.risk === "string" && params.risk.trim() ? { risk: params.risk.trim() } : {}),
					...(options.length ? { options } : {}),
					...(typeof params.recommend === "string" && params.recommend.trim() ? { recommend: params.recommend.trim() } : {}),
				};
				await applyWorkerState(ctx, "needs_input", params.question, undefined, questionMeta);
				return { content: [{ type: "text", text: workerProtocolResultText("needs_input") }], details: { state: "needs_input", question: params.question, ...questionMeta } };
			},
		});

		pi.registerTool({
			name: "docket_done",
			label: "Docket Done",
			description: "Docket worker only: mark this worker's useful output ready for parent review. Provide outcome, concise summary, evidence, and optional recommendations.",
			promptSnippet: "Mark Docket worker output ready for parent review with outcome, summary, and evidence.",
			promptGuidelines: ["See <docket_worker_guardrails> for outcome/evidence requirements and when to use docket_done vs docket_wait vs docket_fail. Do not run /docket done via bash."],
			parameters: Type.Object({
				outcome: Type.Optional(StringEnum(["completed", "findings", "proposal", "no_evidence"] as const, { description: "Best description of the result" })),
				summary: Type.Optional(Type.String({ description: "Concise summary of completed worker output" })),
				evidence: Type.Optional(Type.Array(Type.String({ description: "Short evidence item, e.g. searched path, file changed, command result, artifact ref" }))),
				recommended: Type.Optional(Type.Array(Type.String({ description: "Short action-oriented recommendation for the parent card" }))),
				scopeConfidence: Type.Optional(StringEnum(["clear", "unclear"] as const, { description: "Whether the original task scope was clear enough to finish without more parent input" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				markWorkerProtocolCalled();
				const done = params as WorkerDoneInput;
				const updated = await applyWorkerState(ctx, "ready", done.summary, done);
				const progress = updated ? workerTodoProgress(updated) : { completed: 0, total: 0 };
				const open = Math.max(0, progress.total - progress.completed);
				if (updated?.state === "needs_input") {
					return { content: [{ type: "text", text: "Docket did not accept done; marked waiting. Stop now and wait for parent reply." }], details: { state: "needs_input", question: updated.question } };
				}
				const progressNote = open > 0 ? ` Progress board still shows ${progress.completed}/${progress.total}; parent will treat it as informational.` : "";
				return { content: [{ type: "text", text: `${workerProtocolResultText("ready")}${progressNote}` }], details: { state: "ready", summary: updated?.summary ?? done.summary, outcome: done.outcome, evidence: done.evidence, recommended: done.recommended, todoCount: progress.total, todoOpenCount: open } };
			},
		});

		pi.registerTool({
			name: "docket_fail",
			label: "Docket Fail",
			description: "Docket worker only: mark this worker failed with a one-sentence reason. Use only when no partial output is useful; prefer docket_done with notes when partial output exists.",
			promptSnippet: "Mark a Docket worker failed when it cannot continue and has no useful partial output.",
			promptGuidelines: ["See <docket_worker_guardrails> for when to use docket_fail vs docket_done vs docket_wait. Do not run /docket fail via bash."],
			parameters: Type.Object({ reason: Type.String({ description: "Reason this worker cannot continue" }) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				markWorkerProtocolCalled();
				await applyWorkerState(ctx, "failed", params.reason);
				return { content: [{ type: "text", text: workerProtocolResultText("failed") }], details: { state: "failed", reason: params.reason } };
			},
		});

		// Only expose docket_spawn_child when current worker's kind allows it.
		// We probe synchronously via status.json + the sync kind-registry fallback so the
		// tool registration decision happens before the worker's first turn starts.
		(() => {
			const status = readWorkerStatusSync(workerId);
			if (!status) return;
			const cwd = activeCtx?.cwd ?? process.cwd();
			const syncReload = (kindRegistry as unknown as { _reloadSync?: (cwd: string) => void })._reloadSync;
			if (syncReload && !kindRegistryReloaded) syncReload(cwd);
			const kind = status.kind ? kindRegistry.get(status.kind) : kindRegistry.get(undefined);
			const allowed = (status.canSpawn ?? kind.canSpawn ?? []).filter((value): value is string => typeof value === "string" && value.length > 0);
			if (allowed.length === 0) return;
			const allowedList = allowed.join(", ");
			pi.registerTool({
				name: "docket_spawn_child",
				label: "Docket Spawn Child",
				description: `Docket worker only: dispatch a child Docket worker. Allowed child kinds for this worker: ${allowedList}. Child runs in a sibling tmux window inside the shared docket-workers session; child docket_done returns here, not to the human user.`,
				promptSnippet: `Dispatch a child Docket worker (allowed kinds: ${allowedList}).`,
				promptGuidelines: [
					"Use child workers sparingly. A child consumes a worker slot and a tmux window.",
					"Only spawn when the parent's context truly lacks the information you need; otherwise grep/read here.",
					"Child outcome will arrive in your inbox as a worker artifact under its short label (e.g. wN).",
				],
				parameters: Type.Object({
					kind: StringEnum(allowed as unknown as readonly [string, ...string[]], { description: "Child kind to dispatch" }),
					task: Type.String({ description: "Concrete task description for the child. Be specific; the child inherits no extra context beyond its kind's system prompt and your seeded parent session." }),
				}),
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					markWorkerProtocolCalled();
					const store = createWorkerStore();
					const current = await store.find(workerId);
					if (!current) return { content: [{ type: "text", text: "Docket: cannot spawn child — current worker status missing." }], details: { error: "no-status" } };
					await ensureKindRegistryLoaded(ctx.cwd);
					const config = await loadConfig(ctx.cwd).catch(() => undefined);
					const maxActive = typeof config?.worker?.maxActive === "number" ? config.worker.maxActive : 8;
					const maxDepth = typeof config?.worker?.maxSpawnDepth === "number" ? config.worker.maxSpawnDepth : 2;
					const currentDepth = current.depth ?? 0;
					if (currentDepth + 1 > maxDepth) {
						return { content: [{ type: "text", text: `Docket: spawn-depth cap reached (${currentDepth + 1} > ${maxDepth}). Use docket_wait to ask the parent to dispatch instead.` }], details: { error: "max-depth", currentDepth, maxDepth } };
					}
					if (maxActive > 0) {
						const active = await store.countActive();
						if (active >= maxActive) {
							return { content: [{ type: "text", text: `Docket: fleet cap reached (${active}/${maxActive}). Cannot spawn child right now.` }], details: { error: "max-active", active, maxActive } };
						}
					}
					const requestedKind = (params as { kind: string }).kind;
					if (!allowed.includes(requestedKind)) {
						return { content: [{ type: "text", text: `Docket: kind "${requestedKind}" not in allowlist (${allowedList}).` }], details: { error: "not-allowed" } };
					}
					const childKind = kindRegistry.get(requestedKind);
					const childLaunchArgs = workerKindLaunchArgs(childKind, { model: current.model });
					const taskText = ((params as { task: string }).task ?? "").trim();
					if (!taskText) return { content: [{ type: "text", text: "Docket: child task is empty." }], details: { error: "empty-task" } };
					try {
						const child = await store.spawn({
							task: taskText,
							cwd: current.cwd,
							...(current.sessionFile ? { parentSession: current.sessionFile } : {}),
							worktree: childKind.defaultWorktree,
							kind: childKind.name,
							readOnly: childKind.readOnly,
							...(childKind.planGate ? { planGate: true } : {}),
							...(childKind.decisionRights?.length ? { decisionRights: childKind.decisionRights } : {}),
							...(childKind.canSpawn.length > 0 ? { canSpawn: childKind.canSpawn } : {}),
							parentWorkerId: current.id,
							depth: currentDepth + 1,
							layout: childKind.layout,
							...(childLaunchArgs.length ? { extensionArgs: [...explicitExtensionArgs(), ...childLaunchArgs] } : {}),
						});
						appendWorkerEventSync(store.root(), current.id, { kind: "message", payload: { event: "spawn-child", childId: child.id, childIndex: child.index, kind: childKind.name } });
						return { content: [{ type: "text", text: `Docket: dispatched child ${workerShortLabel(child.index)} (kind: ${childKind.name}). Their docket_done will surface in your inbox.` }], details: { childId: child.id, childIndex: child.index, kind: childKind.name } };
					} catch (err) {
						return { content: [{ type: "text", text: `Docket: child spawn failed: ${String(err)}` }], details: { error: "spawn-failed", message: String(err) } };
					}
				},
			});
		})();

		pi.on("tool_call", async (event, ctx) => {
			if (workerId) {
				const target = toolEventTarget(event);
				appendWorkerEventSync(createWorkerStore().root(), workerId, { kind: "tool", payload: { tool: event.toolName, when: "call", ...(target ? { target } : {}) } });
			}
			if (!isToolCallEventType("bash", event)) return;
			const intent = parseDocketWorkerShellCommand(event.input.command);
			if (!intent) return;
			markWorkerProtocolCalled();
			await applyWorkerState(ctx, intent.state, intent.text);
			event.input.command = `printf '%s\n' ${shellSingleQuote(workerProtocolResultText(intent.state))}`;
		});
	}

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		sessionProjectKey = projectKey(ctx.cwd);
		pinnedRefs = new Set();
		completedRefs = new Set();
		loadedWorkerIds = new Set<string>();
		loadedArtifacts.reset();
		workerResult = undefined;
		loadedCheckpoint = loadedCheckpointFromSession(ctx);
		if (ctx.hasUI) {
			ctx.ui.setWidget("docket-chips", undefined);
			ctx.ui.setWidget("docket-worker-result", undefined);
		}
		setLoadedCheckpointWidget(ctx, loadedCheckpoint);
		if (loadedCheckpoint) void mountLoadedCheckpoint(loadedCheckpoint.id);
		void maybeSweep(ctx.cwd);
		if (workerId) {
			void writeWorkerHeartbeat(ctx);
			heartbeatTimer = setInterval(() => void writeWorkerHeartbeat(ctx), 15000);
			heartbeatTimer.unref?.();
		} else if (ctx.hasUI) {
			const root = createWorkerStore().root();
			workerDockCache = new WorkerSnapshotCache(root);
			workerDockIdleHideMs = 0;
			workerReadyEmbedEmitted.clear();
			void loadConfig(ctx.cwd).then((config) => {
				workerDockIdleHideMs = dockIdleHideMs(config.worker);
				workerAutoEmbedSummary = config.worker?.autoEmbedSummary !== false;
				void refreshWorkerDockWidget();
			}).catch(() => undefined);
			workerDockUnwatch = watchWorkersRoot(root, () => void refreshWorkerDockWidget());
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		if (workerDockUnwatch) {
			workerDockUnwatch();
			workerDockUnwatch = undefined;
		}
		stopDockAnimation();
		dockTui = undefined;
		workerDockCache = undefined;
		workerDockPending = false;
		workerDockRunning = false;
		workerDockIdleHideMs = 0;
		sessionProjectKey = undefined;
		if (workerId) {
			try { await createWorkerStore().patchStatus(workerId, { state: "ended" }); } catch { /* best-effort */ }
		}
		await drainShutdownConsume();
		activeCtx = undefined;
		pinnedRefs = new Set();
		completedRefs = new Set();
		loadedWorkerIds = new Set<string>();
		loadedArtifacts.reset();
		workerResult = undefined;
		loadedCheckpoint = undefined;
		if (ctx.hasUI) {
			ctx.ui.setWidget(DOCKET_CHECKPOINT_WIDGET_ID, undefined);
			ctx.ui.setWidget("docket-worker-result", undefined);
			ctx.ui.setWidget("docket-workers", undefined);
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
			ctx.ui.notify(`Docket dropped stale chip(s): ${result.missing.join(", ")}`, "warning");
		}
		loadedArtifacts.clearChips();
		workerResult = undefined;
		refreshChipWidget();
		refreshWorkerResultWidget();
		if (result.expanded === 0) return { action: "continue" };
		return { action: "transform", text: result.text };
	});

	pi.registerCommand("docket", {
		description: "Review Pi agent work, worker output, and saved evidence",
		getArgumentCompletions: async (prefix: string) => {
			const trimmed = prefix.replace(/^\s+/, "");
			const firstSpace = trimmed.indexOf(" ");
			if (firstSpace === -1) {
				const items = DOCKET_COMMANDS.filter((c) => c.startsWith(trimmed)).map((c) => ({ value: c, label: c }));
				return items.length ? items : null;
			}
			const subcommand = trimmed.slice(0, firstSpace);
			const rest = trimmed.slice(firstSpace + 1);
			if (subcommand === "load" || subcommand === "unload" || subcommand === "delete" || subcommand === "tell" || subcommand === "verdict") {
				const lastSpace = rest.lastIndexOf(" ");
				const partial = lastSpace === -1 ? rest : rest.slice(lastSpace + 1);
				const completed = lastSpace === -1 ? "" : `${rest.slice(0, lastSpace + 1)}`;
				const candidates = await checkpointAndWorkerCandidates(subcommand, activeCtx ? projectKey(activeCtx.cwd) : undefined);
				const matches = candidates.filter((c) => c.value.toLowerCase().startsWith(partial.toLowerCase()));
				const items = matches.map((c) => ({ value: `${subcommand} ${completed}${c.value}`, label: c.label }));
				return items.length ? items : null;
			}
			return null;
		},
		handler: (args, ctx) => runDocketCommand(args, ctx),
	});

	// One-key path to the worker progress lens. It stays zero-context until the user
	// explicitly loads evidence or replies to a worker.
	pi.registerShortcut?.("f8", {
		description: "Docket: open worker progress lens",
		handler: (ctx) => runDocketCommand("workers", ctx as ExtensionCommandContext),
	});

	async function runDocketCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
			const parsed = parseDocketCommand(args);
			if (!parsed.ok) {
				emitText(pi, ctx, `${parsed.message}\n\n${parsed.usage}`, "usage", "docket · usage");
				return;
			}

			const intent = parsed.intent;
			const workerStore = createWorkerStore();
			const checkpointStore = createCheckpointStore();
			await ensureKindRegistryLoaded(ctx.cwd);
			const docketConfig = await loadConfig(ctx.cwd).catch(() => undefined);
			const maxActive = typeof docketConfig?.worker?.maxActive === "number" ? docketConfig.worker.maxActive : 8;
			const captureTerminal = docketConfig?.worker?.captureTerminal === true;
			const workerCommands = createWorkerCommands({
				store: workerStore,
				loadedArtifacts,
				cwd: ctx.cwd,
				projectRoot: sessionProjectKey ?? projectKey(ctx.cwd),
				...(ctx.sessionManager.getSessionFile?.() ? { parentSession: ctx.sessionManager.getSessionFile() } : {}),
				parentModel: () => ctx.model?.id,
				kinds: kindRegistry,
				maxActive: () => maxActive,
				captureTerminal: () => captureTerminal,
				defaultKind: () => docketConfig?.worker?.defaultKind,
				parentSeedPolicy: () => (docketConfig?.worker?.parentSeedPolicy === "full" ? "full" : "none"),
				notify: (text, level) => notifyDocket(pi, ctx, text, level),
				announce: (subject, detail, kind, docket, meta) => announceAction(pi, ctx, subject, detail, kind, docket, meta),
				emitText: (text, kind, heading) => emitText(pi, ctx, text, kind, heading),
			});
			const checkpointCommands = createCheckpointCommands({
				store: checkpointStore,
				hasUI: ctx.hasUI,
				notify: (text, level) => notifyDocket(pi, ctx, text, level),
				emitText: (text, kind, heading) => emitText(pi, ctx, text, kind, heading),
				confirmDelete: (checkpoint) => confirmDeleteCheckpoint(ctx, checkpoint),
				selectCheckpoint: (summaries, selected, mode) => showCheckpointResumeSelector(ctx, summaries, selected, mode),
				showText: (title, text, options) => showTextViewer(ctx, title, text, options?.diff ? "diff" : undefined),
				editText: (title, text) => ctx.hasUI ? ctx.ui.editor(title, text) : Promise.resolve(undefined),
				startSession: (checkpoint, content) => startCheckpointSession(pi, ctx, checkpoint, content, queueShutdownConsume),
			});
			await createDocketCommandRouter({
				hasUI: ctx.hasUI,
				workerId,
				projectRoot: sessionProjectKey ?? projectKey(ctx.cwd),
				workerCommands,
				checkpointCommands,
				loadedArtifacts,
				workerStore,
				checkpointStore,
				notify: (text, level) => notifyDocket(pi, ctx, text, level),
				emitText: (text, kind, heading) => emitText(pi, ctx, text, kind, heading),
				announce: (subject, detail, kind) => announceAction(pi, ctx, subject, detail, kind),
				docketUsage,
				renderArtifactList,
				renderParallelWorkList,
				formatArtifact,
				refreshChipWidget,
				refreshWorkerDockWidget,
				refreshWorkerCarryoverForReview,
				showWorkerResult: showWorkerResultWidget,
				clearWorkerResult: clearWorkerResultWidget,
				markArtifactDone: (artifact) => completedRefs.add(artifact.ref),
				markWorkerLoaded: (worker) => loadedWorkerIds.add(worker.id),
				markWorkerUnloaded: (worker) => loadedWorkerIds.delete(worker.id),
				markAllWorkersUnloaded: () => { loadedWorkerIds = new Set<string>(); },
				promoteWorkerChangeSet: async (artifact) => {
					const workerIdValue = typeof artifact.meta?.workerId === "string" ? artifact.meta.workerId : undefined;
					const worker = workerIdValue ? await workerStore.find(workerIdValue) : undefined;
					if (!worker) {
						notifyDocket(pi, ctx, "Docket worker not found for change set", "error");
						return false;
					}
					const peers = await workerStore.list({ projectRoot: sessionProjectKey ?? projectKey(ctx.cwd) });
					const peerArtifacts = new Map<string, Artifact[]>();
					await Promise.all(peers.map(async (peer) => {
						peerArtifacts.set(peer.id, await readWorkerArtifactsForReview(peer));
					}));
					const overlap = conflictSummary(workerConflictMap(peers, peerArtifacts).get(worker.id) ?? [], 4);
					if (overlap) {
						if (!ctx.hasUI) {
							notifyDocket(pi, ctx, `Docket promote blocked: ${overlap}`, "warning");
							return false;
						}
						const ok = await ctx.ui.confirm("Promote despite worker overlap?", `${overlap}\n\n${artifact.title}`);
						if (!ok) return false;
					}
					let result = promoteWorkerChangeSet(worker, ctx.cwd);
					if (!result.ok && result.needsConfirmation && ctx.hasUI) {
						const ok = await ctx.ui.confirm("Promote worker changes?", `${result.message}\n\n${artifact.title}`);
						if (!ok) return false;
						result = promoteWorkerChangeSet(worker, ctx.cwd, { force: true });
					}
					notifyDocket(pi, ctx, result.ok ? `${result.message} Stop the worker to free its workspace.` : result.message, result.ok ? "info" : result.needsConfirmation ? "warning" : "error");
					if (result.ok) await refreshWorkerDockWidget();
					return result.ok;
				},
				reviewWorkerChangeSetInHunk: (worker, changeSet) => reviewWorkerChangeSetInHunkFromTui(ctx, worker, changeSet),
				chooseHunkReviewAction: (worker, comments) => chooseHunkReviewAction(ctx, worker, comments),
				applyWorkerState: async (state, text) => { await applyWorkerState(ctx, state, text); },
				createCheckpoint: async (options) => {
					const checkpointLifecycle = await createCheckpointLifecycle(pi, ctx);
					await checkpointLifecycle.create(options);
				},
				createHandoffCheckpoint: async () => {
					const checkpointLifecycle = await createCheckpointLifecycle(pi, ctx);
					await checkpointLifecycle.create({ note: "", consumeOnUse: false, summarize: false });
				},
				catalog: async () => {
					const config = await loadConfig(ctx.cwd);
					return createArtifactCatalog(ctx, config, loadedArtifacts.carryoverArtifacts());
				},
				readWorkersWithArtifacts: (options) => readWorkersWithArtifacts(workerStore, options?.allProjects ? undefined : sessionProjectKey ?? projectKey(ctx.cwd)),
				showParallelWorkDashboard: (workers, artifactsByWorker, options) => showParallelWorkDashboard(ctx, workers, artifactsByWorker, options?.groupByProject === true, loadedWorkerIds),
				showLoadPicker: (summaries, workers, initialMode) => showLoadPicker(ctx, summaries, workers, initialMode),
				showText: (title, text, options) => showTextViewer(ctx, title, text, options?.diff ? "diff" : undefined),
				showDocketBrowser: (catalog, artifacts, initialMode) => showDocketBrowser(ctx, catalog, artifacts, pinnedRefs, completedRefs, initialMode),
				showVerdict: (worker, remaining) => showWorkerVerdict(ctx, worker, remaining),
				showArtifact: (catalog, artifact) => showArtifactViewer(ctx, catalog, artifact),
				openFileOrArtifact: async (catalog, artifact) => {
					const filePath = artifactFilePath(artifact, ctx.cwd);
					if (filePath) await showFileViewer(ctx, filePath);
					else await showArtifactViewer(ctx, catalog, artifact);
				},
				input: (title, placeholder) => ctx.hasUI ? ctx.ui.input(title, placeholder) : Promise.resolve(undefined),
				confirmDeleteWorker: (worker) => ctx.hasUI ? ctx.ui.confirm("Stop Docket worker?", `Stop ${workerSourceLabel(worker)} and remove its workspace? This cannot be undone.`) : Promise.resolve(true),
				copyText: copyToClipboard,
				announceChipChange: (artifact, mode, result) => announceChipChange(ctx, { displayId: artifact.displayId, ref: artifact.ref, mode, kind: artifact.kind, title: artifact.title }, result),
				parallelKindLabel,
				recordDecision: (recordEntry) => createDecisionLog().recordVerdict(recordEntry),
				readDecisionEvents: () => createDecisionLog().read(),
			}).handle(intent);
	}
}
