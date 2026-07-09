import fs from "node:fs/promises";
import { getLanguageFromPath, highlightCode } from "@mariozechner/pi-coding-agent";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Box, Container, Key, Text, matchesKey, truncateToWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import { artifactFilePath, type ArtifactCatalog } from "../artifact-catalog.js";
import { renderGitDiffLine } from "../diff-render.js";
import type { Artifact } from "../types.js";
import { BOTTOM_CORNERS, fitBorder, TOP_CORNERS } from "./primitives.js";

function docketCardBg(theme: any): (s: string) => string {
	return (s: string) => theme.bg("customMessageBg", s);
}

function artifactHasDiff(artifact: Artifact): boolean {
	const diff = artifact.meta?.diff;
	return typeof diff === "string" && diff.length > 0;
}

function artifactIsDiffLike(artifact: Artifact): boolean {
	return artifactHasDiff(artifact) || artifact.meta?.workerChangeSet === true;
}

export class DocketTextViewer implements Component {
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

export class DocketFileViewer implements Component {
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
		const headerLeft = ` ${accent(this.theme.bold(this.filePath))} ${dim(this.language ?? "text")} `;
		const headerRight = ` ${dim(`${Math.min(this.offset + 1, this.lines.length)}-${last}/${this.lines.length} · col ${this.column}`)} `;
		container.addChild(new Text(fitBorder(headerLeft, headerRight, innerWidth, outerBorder, TOP_CORNERS), 0, 0));
		for (let i = 0; i < visible.length; i++) {
			const lineNo = this.offset + i + 1;
			const numStr = muted(String(lineNo).padStart(lineNumWidth));
			container.addChild(new Text(truncateToWidth(`${numStr}  ${highlighted[i] ?? ""}`, innerWidth - 2), 1, 0));
		}
		for (let i = visible.length; i < this.viewportHeight; i++) container.addChild(new Text("", 1, 0));
		container.addChild(new Text(dim("j/k line · h/l horizontal · 0 left · Space/b page · g/G top/bottom · q close"), 1, 0));
		container.addChild(new Text(fitBorder("", "", innerWidth, outerBorder, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

export async function showFileViewer(ctx: ExtensionCommandContext, filePath: string): Promise<void> {
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
	await ctx.ui.custom<void>((tui, theme, _kb, done) => new DocketFileViewer(tui, theme, filePath, getLanguageFromPath(filePath), content.split("\n"), done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "92%", minWidth: 84, maxHeight: "95%", margin: 1 },
	});
}

export async function showTextViewer(ctx: ExtensionCommandContext, title: string, text: string, mode?: "diff"): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => new DocketTextViewer(tui, theme, title, text, done, mode), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "90%", minWidth: 90, maxHeight: "95%", margin: 1 },
	});
}

export async function showArtifactViewer(ctx: ExtensionCommandContext, catalog: ArtifactCatalog, artifact: Artifact): Promise<void> {
	if (artifact.kind === "file" && !artifactHasDiff(artifact)) {
		const filePath = artifactFilePath(artifact, ctx.cwd);
		if (filePath) return showFileViewer(ctx, filePath);
	}
	const inspected = await catalog.inspect(artifact);
	await showTextViewer(ctx, inspected.title, inspected.text, artifactIsDiffLike(artifact) ? "diff" : undefined);
}
