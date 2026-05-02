/**
 * Trail — session artifacts as first-class objects.
 *
 * Commands:
 *   /trail                         browse artifacts
 *   /trail search <query>           search artifacts with ripgrep
 *   /trail checkpoint [flags] [note]
 *   /trail continue <id|last>
 *   /trail resume [id|last]
 *   /trail list
 *   /trail ref <artifact-id>
 *   /trail inject <artifact-id>     alias for ref
 *   /trail inject-full <artifact-id>
 *   /trail copy <artifact-id>
 *
 * Checkpoint flags:
 *   --handoff (default), --compact, --debug, --review, --once, --raw
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, MessageRenderer } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getAgentDir, getLanguageFromPath, highlightCode } from "@mariozechner/pi-coding-agent";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import {
	Box,
	Container,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@mariozechner/pi-tui";
import { createCheckpointStore, type CheckpointSummary } from "./checkpoint-store.js";
import { createCheckpointSummarizer, type CheckpointSummarizerConfig } from "./checkpoint-summarizer.js";
import { parseTrailCommand, trailUsage, TRAIL_COMMANDS, type CheckpointCreateOptions } from "./trail-command-grammar.js";
import { handleNavigatorKey, initialNavigatorState, navigatorViewModel, type NavigatorAction, type NavigatorKey, type NavigatorState } from "./trail-navigator.js";
import type { Artifact, ArtifactKind, ArtifactSummary, CheckpointIndexEntry, CheckpointMode } from "./types.js";

type TrailConfig = {
	maxArtifacts: number;
	maxBodyChars: number;
	checkpointArtifacts: number;
	summarizer: CheckpointSummarizerConfig;
};

type ArtifactCatalog = {
	list(): Artifact[];
	find(idOrRef: string): Artifact | undefined;
	reference(artifact: Artifact): string;
	fullText(artifact: Artifact): string;
	inspect(artifact: Artifact): Promise<{ title: string; text: string }>;
	search(query: string): Promise<Artifact[]>;
	selectForCheckpoint(mode: CheckpointMode, limit: number): Artifact[];
	checkpointPayload(artifacts: Artifact[], mode: CheckpointMode): Array<Record<string, unknown>>;
	summary(artifact: Artifact): ArtifactSummary;
};

type ToolCallInfo = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	entryId: string;
	timestamp?: number;
};

type CheckpointLifecycle = {
	create(options: CheckpointCreateOptions): Promise<void>;
};

const CHECKPOINT_CUSTOM_TYPE = "trail:checkpoint";
const DEFAULT_CONFIG: TrailConfig = {
	maxArtifacts: 300,
	maxBodyChars: 6000,
	checkpointArtifacts: 24,
	summarizer: {
		enabled: true,
		maxOutputTokens: 1200,
		maxInputChars: 36000,
		timeoutMs: 120000,
	},
};

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: string; text?: string; thinking?: string };
			if (block.type === "text" && typeof block.text === "string") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function toolCallsFromContent(content: unknown): Array<{ id: string; name: string; args: Record<string, unknown> }> {
	if (!Array.isArray(content)) return [];
	const out: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
		if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
		out.push({ id: block.id, name: block.name, args: block.arguments ?? {} });
	}
	return out;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[Trail truncated ${text.length - max} chars]`;
}

function firstLine(text: string, fallback: string): string {
	return text.trim().split("\n").find((line) => line.trim())?.trim() || fallback;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatArtifact(artifact: Artifact): string {
	const lines = [
		`# Trail artifact ${artifact.displayId}`,
		`ref: ${artifact.ref}`,
		`kind: ${artifact.kind}`,
		artifact.entryId ? `entry: ${artifact.entryId}` : undefined,
		artifact.subtitle ? `meta: ${artifact.subtitle}` : undefined,
		"",
		artifact.title,
		"",
		artifact.body,
	].filter((line): line is string => line !== undefined);
	return lines.join("\n");
}

function shortCommand(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

function artifactKindRank(kind: ArtifactKind): number {
	return ["error", "command", "file", "code", "prompt", "response", "checkpoint"].indexOf(kind);
}

function makeArtifactId(kind: ArtifactKind, n: number): string {
	return `${kind[0]}${n}`;
}

function extractCodeBlocks(text: string): Array<{ lang: string; code: string }> {
	const blocks: Array<{ lang: string; code: string }> = [];
	const re = /```([^\n`]*)\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		blocks.push({ lang: match[1]?.trim() || "text", code: match[2] ?? "" });
	}
	return blocks;
}

type TrailRuntimeContext = ExtensionContext & Partial<ExtensionCommandContext>;

function fileArtifactFromTool(call: ToolCallInfo, entry: any, cwd: string): Omit<Artifact, "id" | "displayId" | "ref"> | null {
	const args = call.args;
	const pathArg = asString(args.path) ?? asString(args.file) ?? asString(args.pattern);
	if (!["read", "write", "edit", "grep", "find", "ls"].includes(call.name)) return null;

	const op = call.name;
	const target = pathArg ?? cwd;
	const meta: string[] = [];
	if (typeof args.offset === "number") meta.push(`offset ${args.offset}`);
	if (typeof args.limit === "number") meta.push(`limit ${args.limit}`);
	if (Array.isArray(args.edits)) meta.push(`${args.edits.length} edit(s)`);
	if (asString(args.pattern)) meta.push(`pattern ${asString(args.pattern)}`);

	return {
		kind: "file",
		title: `${op} ${target}`,
		subtitle: meta.join(" · "),
		body: [
			`operation: ${op}`,
			`path: ${target}`,
			`cwd: ${cwd}`,
			`status: ${entry.message?.isError ? "error" : "ok"}`,
			"",
			textFromContent(entry.message?.content),
		].join("\n"),
		entryId: entry.id,
		timestamp: Date.parse(entry.timestamp),
		meta: { tool: op, args },
	};
}

function buildArtifacts(ctx: TrailRuntimeContext, config: TrailConfig): Artifact[] {
	const branch = ctx.sessionManager.getBranch();
	const calls = new Map<string, ToolCallInfo>();
	const artifacts: Artifact[] = [];

	const push = (artifact: Omit<Artifact, "id" | "displayId" | "ref">) => {
		if (artifacts.length >= config.maxArtifacts) return;
		const displayId = makeArtifactId(artifact.kind, artifacts.length + 1);
		const entryKey = artifact.entryId ?? "session";
		const sameEntryOrdinal = artifacts.filter((a) => a.kind === artifact.kind && (a.entryId ?? "session") === entryKey).length;
		const ref = `${artifact.kind}:${entryKey}:${sameEntryOrdinal}`;
		artifacts.push({ ...artifact, id: displayId, displayId, ref, body: truncate(artifact.body, config.maxBodyChars) });
	};

	for (const entry of branch as any[]) {
		if (entry.type === "custom" && entry.customType === CHECKPOINT_CUSTOM_TYPE) {
			const data = entry.data as Partial<CheckpointIndexEntry> | undefined;
			push({
				kind: "checkpoint",
				title: `checkpoint ${data?.id ?? entry.id}`,
				subtitle: data?.mode ?? "handoff",
				body: `checkpoint: ${data?.id ?? entry.id}\nfile: ${data?.file ?? "(unknown)"}\nnote: ${data?.note ?? ""}`,
				entryId: entry.id,
				timestamp: Date.parse(entry.timestamp),
				meta: data as Record<string, unknown>,
			});
			continue;
		}

		if (entry.type !== "message") continue;
		const msg = entry.message;
		const timestamp = Date.parse(entry.timestamp);

		if (msg?.role === "assistant") {
			for (const call of toolCallsFromContent(msg.content)) {
				calls.set(call.id, { ...call, entryId: entry.id, timestamp });
			}

			const text = textFromContent(msg.content).trim();
			if (text) {
				push({
					kind: msg.errorMessage ? "error" : "response",
					title: firstLine(text, "assistant response"),
					subtitle: `${msg.provider ?? "model"}/${msg.model ?? "unknown"}`,
					body: text,
					entryId: entry.id,
					timestamp,
					meta: { provider: msg.provider, model: msg.model, stopReason: msg.stopReason },
				});

				for (const block of extractCodeBlocks(text)) {
					push({
						kind: "code",
						title: `${block.lang} code block`,
						subtitle: `${block.code.split("\n").length} lines`,
						body: `\`\`\`${block.lang}\n${block.code}\`\`\``,
						entryId: entry.id,
						timestamp,
						meta: { language: block.lang },
					});
				}
			}
			continue;
		}

		if (msg?.role === "user") {
			const text = textFromContent(msg.content).trim();
			if (text) {
				push({
					kind: "prompt",
					title: firstLine(text, "user prompt"),
					subtitle: new Date(timestamp).toLocaleString(),
					body: text,
					entryId: entry.id,
					timestamp,
				});
			}
			continue;
		}

		if (msg?.role === "toolResult") {
			const call: ToolCallInfo = calls.get(msg.toolCallId) ?? {
				id: msg.toolCallId,
				name: msg.toolName,
				args: {},
				entryId: entry.id,
				timestamp,
			};
			const output = textFromContent(msg.content);

			if (call.name === "bash") {
				const command = asString(call.args.command) ?? "(unknown command)";
				push({
					kind: "command",
					title: `$ ${shortCommand(command)}`,
					subtitle: `${msg.isError ? "failed" : "ok"} · cwd ${ctx.cwd}`,
					body: [`cwd: ${ctx.cwd}`, `command: ${command}`, `status: ${msg.isError ? "error" : "ok"}`, "", output].join("\n"),
					entryId: entry.id,
					timestamp,
					meta: { cwd: ctx.cwd, command, args: call.args },
				});
			}

			const fileArtifact = fileArtifactFromTool(call, entry, ctx.cwd);
			if (fileArtifact) push(fileArtifact);

			if (msg.isError) {
				push({
					kind: "error",
					title: `${call.name} failed`,
					subtitle: asString(call.args.path) ?? asString(call.args.command) ?? "tool error",
					body: [`tool: ${call.name}`, `args: ${JSON.stringify(call.args)}`, "", output].join("\n"),
					entryId: entry.id,
					timestamp,
					meta: { tool: call.name, args: call.args },
				});
			}
			continue;
		}

		if (msg?.role === "bashExecution") {
			push({
				kind: "command",
				title: `$ ${shortCommand(msg.command ?? "")}`,
				subtitle: `${msg.exitCode === 0 ? "ok" : "failed"} · user bash`,
				body: [`command: ${msg.command}`, `exitCode: ${msg.exitCode}`, "", msg.output ?? ""].join("\n"),
				entryId: entry.id,
				timestamp,
				meta: { command: msg.command, exitCode: msg.exitCode },
			});
		}
	}

	return artifacts.sort((a, b) => {
		const time = (b.timestamp ?? 0) - (a.timestamp ?? 0);
		if (time !== 0) return time;
		return artifactKindRank(a.kind) - artifactKindRank(b.kind);
	});
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
	try {
		if (!existsSync(file)) return fallback;
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

async function loadConfig(cwd: string): Promise<TrailConfig> {
	const globalConfig = await readJsonFile<Partial<TrailConfig>>(path.join(getAgentDir(), "trail.json"), {});
	const projectConfig = await readJsonFile<Partial<TrailConfig>>(path.join(cwd, ".pi", "trail.json"), {});
	return {
		...DEFAULT_CONFIG,
		...globalConfig,
		...projectConfig,
		summarizer: {
			...DEFAULT_CONFIG.summarizer,
			...(globalConfig.summarizer ?? {}),
			...(projectConfig.summarizer ?? {}),
		},
	};
}

function makeCheckpointId(): string {
	const d = new Date();
	const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	return stamp.replace("T", "-");
}

function chooseCheckpointArtifacts(artifacts: Artifact[], mode: CheckpointMode, limit: number): Artifact[] {
	const preferred: Record<CheckpointMode, ArtifactKind[]> = {
		handoff: ["error", "file", "command", "prompt", "response", "code"],
		compact: ["error", "file", "prompt", "response"],
		debug: ["error", "command", "file"],
		review: ["file", "code", "response", "prompt", "error"],
	};
	const kinds = preferred[mode];
	return artifacts
		.filter((a) => kinds.includes(a.kind))
		.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || (b.timestamp ?? 0) - (a.timestamp ?? 0))
		.slice(0, limit);
}

function artifactRefId(artifact: Artifact): string {
	return artifact.ref;
}

function buildArtifactReference(artifact: Artifact, cwd: string): string {
	const ref = artifactRefId(artifact);
	if (artifact.kind === "file") {
		const file = artifactFilePath(artifact, cwd);
		return file
			? `Reference Trail ${ref}: file \`${path.relative(cwd, file) || file}\` (${artifact.title}). Use current file contents from disk if needed; do not paste file contents unless asked.`
			: `Reference Trail ${ref}: file artifact \`${artifact.title}\`. ${artifact.subtitle}`;
	}
	if (artifact.kind === "command") return `Reference Trail ${ref}: command ${artifact.title} (${artifact.subtitle}). Use result only if relevant; avoid repeating failed command unless correcting it.`;
	if (artifact.kind === "error") return `Reference Trail ${ref}: prior error ${artifact.title} (${artifact.subtitle}). Avoid repeating this failure unless explicitly fixing it.`;
	if (artifact.kind === "prompt") return `Reference Trail ${ref}: prior user prompt \"${truncate(artifact.title, 160)}\".`;
	if (artifact.kind === "response") return `Reference Trail ${ref}: prior model response \"${truncate(artifact.title, 160)}\".`;
	if (artifact.kind === "code") return `Reference Trail ${ref}: ${artifact.title} (${artifact.subtitle}). Inspect artifact before reusing exact code.`;
	return `Reference Trail ${ref}: ${artifact.title}. ${artifact.subtitle}`;
}

function buildReferenceList(artifacts: Artifact[], cwd: string): string {
	return artifacts.map((artifact) => `- ${artifactRefId(artifact)} ${buildArtifactReference(artifact, cwd)}`).join("\n");
}

function buildRawCheckpointMarkdown(
	ctx: ExtensionCommandContext,
	id: string,
	mode: CheckpointMode,
	note: string,
	consumeOnUse: boolean,
	artifacts: Artifact[],
): string {
	const usage = ctx.getContextUsage();
	const files = [...new Set(artifacts.filter((a) => a.kind === "file").map((a) => a.title.replace(/^(read|write|edit|grep|find|ls)\s+/, "")))];
	const errors = artifacts.filter((a) => a.kind === "error");
	const commands = artifacts.filter((a) => a.kind === "command");

	const lines: string[] = [];
	lines.push(`# Trail checkpoint ${id}`);
	lines.push("");
	lines.push(`mode: ${mode}`);
	lines.push(`cwd: ${ctx.cwd}`);
	lines.push(`created: ${new Date().toISOString()}`);
	if (ctx.sessionManager.getSessionFile()) lines.push(`sourceSession: ${ctx.sessionManager.getSessionFile()}`);
	if (usage && usage.tokens !== null) lines.push(`context: ~${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`);
	if (note) lines.push(`note: ${note}`);
	if (consumeOnUse) lines.push("consumeOnUse: true");
	lines.push("");
	lines.push("## Intent");
	lines.push(note || "Continue from preserved session artifacts. Preserve continuity, discard noise, avoid repeated mistakes.");
	lines.push("");
	lines.push("## Files touched or inspected");
	lines.push(files.length ? files.map((f) => `- ${f}`).join("\n") : "- (none captured)");
	lines.push("");
	lines.push("## Errors and failed attempts");
	lines.push(errors.length ? errors.map((a) => `- ${a.title}: ${a.subtitle}`).join("\n") : "- (none captured)");
	lines.push("");
	lines.push("## Commands worth preserving");
	lines.push(commands.length ? commands.slice(0, 10).map((a) => `- ${a.title} (${a.subtitle})`).join("\n") : "- (none captured)");
	lines.push("");
	lines.push("## Artifact excerpts");
	for (const artifact of artifacts) {
		lines.push("");
		lines.push(`### ${artifact.kind}: ${artifact.title}`);
		if (artifact.subtitle) lines.push(`_${artifact.subtitle}_`);
		lines.push("");
		lines.push(truncate(artifact.body.trim(), mode === "compact" ? 900 : 1800));
	}
	lines.push("");
	lines.push("## Fresh-session instruction");
	lines.push("Use checkpoint above as source of truth. Continue work without assuming full prior transcript exists. Do not repeat failed attempts listed above unless explicitly correcting them.");
	return lines.join("\n");
}

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

async function searchArtifacts(query: string, artifacts: Artifact[]): Promise<Artifact[]> {
	const tempDir = await fs.mkdtemp(path.join(tmpdir(), "pi-trail-"));
	try {
		for (const artifact of artifacts) {
			const file = path.join(tempDir, `${artifact.id}.md`);
			const content = `${formatArtifact(artifact)}\n\nmetadata:\n${JSON.stringify(artifact.meta ?? {}, null, 2)}\n`;
			await fs.writeFile(file, content, "utf8");
		}

		try {
			const result = await runCommand("rg", ["--files-with-matches", "--fixed-strings", "--ignore-case", "-e", query, tempDir]);
			if (result.code === 0) {
				const ids = new Set(result.stdout.split("\n").map((line) => path.basename(line, ".md")).filter(Boolean));
				return artifacts.filter((artifact) => ids.has(artifact.id));
			}
			if (result.code !== 1) throw new Error(result.stderr || `rg exited ${result.code}`);
		} catch {
			const needle = query.toLowerCase();
			return artifacts.filter((artifact) => formatArtifact(artifact).toLowerCase().includes(needle));
		}
		return [];
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
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

function artifactFilePath(artifact: Artifact, cwd: string): string | undefined {
	if (artifact.kind !== "file") return undefined;
	const args = (artifact.meta?.args ?? {}) as Record<string, unknown>;
	const raw = asString(args.path) ?? asString(args.file) ?? artifact.body.match(/^path: (.+)$/m)?.[1];
	if (!raw || raw === cwd) return undefined;
	const cleaned = raw.startsWith("@") ? raw.slice(1) : raw;
	return path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned);
}

async function inspectTextForArtifact(artifact: Artifact, cwd: string): Promise<{ title: string; text: string }> {
	const file = artifactFilePath(artifact, cwd);
	if (!file) return { title: artifact.title, text: formatArtifact(artifact) };
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile()) return { title: artifact.title, text: `${formatArtifact(artifact)}\n\n[Trail: ${file} is not a file]` };
		const content = await fs.readFile(file, "utf8");
		return {
			title: file,
			text: [`# Trail file view`, `path: ${file}`, `artifact: ${artifact.ref} (${artifact.displayId}) ${artifact.title}`, `viewing: current file contents`, "", content].join("\n"),
		};
	} catch (err) {
		return { title: artifact.title, text: `${formatArtifact(artifact)}\n\n[Trail could not read current file: ${String(err)}]` };
	}
}

function createArtifactCatalog(ctx: TrailRuntimeContext, config: TrailConfig): ArtifactCatalog {
	const artifacts = buildArtifacts(ctx, config);
	const byId = new Map<string, Artifact>();
	for (const artifact of artifacts) {
		byId.set(artifact.displayId.toLowerCase(), artifact);
		byId.set(artifact.ref.toLowerCase(), artifact);
	}

	return {
		list() {
			return artifacts;
		},
		find(idOrRef: string) {
			return byId.get(idOrRef.toLowerCase());
		},
		reference(artifact: Artifact) {
			return buildArtifactReference(artifact, ctx.cwd);
		},
		fullText(artifact: Artifact) {
			return formatArtifact(artifact);
		},
		inspect(artifact: Artifact) {
			return inspectTextForArtifact(artifact, ctx.cwd);
		},
		search(query: string) {
			return searchArtifacts(query, artifacts);
		},
		selectForCheckpoint(mode: CheckpointMode, limit: number) {
			return chooseCheckpointArtifacts(artifacts, mode, limit);
		},
		checkpointPayload(selected: Artifact[], mode: CheckpointMode) {
			return selected.map((artifact) => ({
				ref: artifact.ref,
				displayId: artifact.displayId,
				kind: artifact.kind,
				title: artifact.title,
				subtitle: artifact.subtitle,
				body: truncate(artifact.body, mode === "compact" ? 900 : 1600),
				meta: artifact.meta ?? {},
			}));
		},
		summary(artifact: Artifact) {
			return {
				displayId: artifact.displayId,
				ref: artifact.ref,
				kind: artifact.kind,
				title: artifact.title,
				subtitle: artifact.subtitle,
				timestamp: artifact.timestamp,
			};
		},
	};
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
	if (artifact.kind === "file") {
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

const TOP_CORNERS: BorderOptions = { left: "╭", right: "╮" };
const BOTTOM_CORNERS: BorderOptions = { left: "╰", right: "╯" };

function trailCardBg(theme: any): (s: string) => string {
	return (s: string) => theme.bg("customMessageBg", s);
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
	return filters.map((filter) => filter.value === active ? theme.fg("accent", `[${filter.label}]`) : theme.fg("dim", ` ${filter.label} `)).join(" ");
}

class TrailView implements Component {
	private container: Container | Box = new Container();
	private state: NavigatorState = initialNavigatorState();
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private tui: TUI,
		private theme: any,
		private artifacts: Artifact[],
		private fullText: (artifact: Artifact) => string,
		private done: (result: { action: "inspect" | "reference" | "injectFull" | "copy" | "checkpoint"; artifact?: Artifact } | null) => void,
	) {}

	handleInput(data: string): void {
		const key: NavigatorKey = {
			raw: data,
			isDown: matchesKey(data, Key.down),
			isUp: matchesKey(data, Key.up),
			isEnter: matchesKey(data, Key.enter),
			isTab: matchesKey(data, Key.tab),
			isEscape: matchesKey(data, Key.escape),
			isCtrlC: matchesKey(data, Key.ctrl("c")),
		};
		const transition = handleNavigatorKey(this.state, this.artifacts, key);
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
		this.container = new Box(2, 1, trailCardBg(this.theme));
		const innerWidth = Math.max(20, width - 4);
		const view = navigatorViewModel(this.state, this.artifacts, this.state.showDetail ? 10 : 18);
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const outerBorder = (s: string) => this.theme.fg("borderAccent", s);
		const dividerBorder = (s: string) => this.theme.fg("borderMuted", s);

		const sel = view.selectedArtifact;
		const headerLeft = ` ${accent(this.theme.bold("trail"))} ${dim(`${view.items.length}/${this.artifacts.length}`)} `;
		const headerRight = sel
			? ` ${dim(`@${sel.id}`)} ${colorKind(this.theme, sel.kind, kindLabel(sel.kind))} `
			: "";
		this.container.addChild(new Text(fitBorder(headerLeft, headerRight, innerWidth, outerBorder, TOP_CORNERS), 0, 0));
		this.container.addChild(new Text(filterBar(this.theme, this.state.filter), 1, 0));

		const listWidth = Math.max(30, innerWidth);
		if (view.visible.length === 0) {
			const isAllEmpty = this.artifacts.length === 0;
			const title = isAllEmpty
				? muted("no artifacts captured yet")
				: muted(`no ${this.state.filter === "all" ? "" : `${kindLabel(this.state.filter)} `}artifacts in this filter`);
			const hint = isAllEmpty
				? dim("run a command, ask the agent, or create a checkpoint")
				: dim("tab to switch filter · q close");
			this.container.addChild(new Text("", 1, 0));
			this.container.addChild(new Text(title, 2, 0));
			this.container.addChild(new Text(hint, 2, 0));
			this.container.addChild(new Text("", 1, 0));
		} else {
			for (let i = 0; i < view.visible.length; i++) {
				const artifact = view.visible[i];
				if (!artifact) continue;
				const absolute = view.visibleStart + i;
				const selected = absolute === view.selected;
				const marker = selected ? accent("▸") : dim(" ");
				const id = selected ? accent(this.theme.bold(artifact.id.padEnd(5))) : muted(artifact.id.padEnd(5));
				const kind = colorKind(this.theme, artifact.kind, kindLabel(artifact.kind).padEnd(5));
				const age = relativeTime(artifact.timestamp);
				const meta = [artifact.subtitle, age].filter(Boolean).join(" · ");
				const title = selected
					? this.theme.bold(this.theme.fg("text", artifact.title))
					: muted(artifact.title);
				const line = `${marker} ${id} ${kind} ${title} ${dim(meta)}`;
				this.container.addChild(new Text(truncateToWidth(line, listWidth - 2), 1, 0));
			}
		}

		if (this.state.showDetail && view.selectedArtifact) {
			this.container.addChild(new DynamicBorder(dividerBorder));
			this.container.addChild(new Text(`${accent("preview")} ${muted(view.selectedArtifact.ref)}`, 1, 0));
			const detail = this.fullText(view.selectedArtifact).split("\n").slice(0, 14);
			for (const line of detail) this.container.addChild(new Text(truncateToWidth(dim(line), listWidth - 2), 1, 0));
		}

		this.container.addChild(new DynamicBorder(dividerBorder));
		this.container.addChild(new Text(dim("j/k move · tab filter · enter open · r cite · I full · y copy · c checkpoint · v preview · q close"), 1, 0));
		this.container.addChild(new Text(fitBorder("", "", innerWidth, outerBorder, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = this.container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

async function showTrailBrowser(ctx: ExtensionCommandContext, catalog: ArtifactCatalog, artifacts: Artifact[]): Promise<{ action: "inspect" | "reference" | "injectFull" | "copy" | "checkpoint"; artifact?: Artifact } | null> {
	return ctx.ui.custom((tui, theme, _kb, done) => new TrailView(tui, theme, artifacts, (artifact) => catalog.fullText(artifact), done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "88%", minWidth: 84, maxHeight: "90%", margin: 1 },
	});
}

type ResumeSelection = { action: "continue" | "preview" | "edit"; summary: CheckpointSummary; index: number } | null;

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
		else if (matchesKey(data, Key.enter)) this.finish("continue");
		else if (data === "p") this.finish("preview");
		else if (data === "e") this.finish("edit");
		this.invalidate();
		this.tui.requestRender();
	}

	private finish(action: "continue" | "preview" | "edit"): void {
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

		const headerLeft = ` ${accent(this.theme.bold("trail · resume"))} ${dim(`${this.summaries.length} checkpoint${this.summaries.length === 1 ? "" : "s"}`)} `;
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
		this.container.addChild(new Text(dim("j/k move · enter continue · p preview · e edit then continue · q close"), 1, 0));
		this.container.addChild(new Text(fitBorder("", "", innerWidth, outerBorder, BOTTOM_CORNERS), 0, 0));
		this.cachedLines = this.container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

async function showCheckpointResumeSelector(ctx: ExtensionCommandContext, summaries: CheckpointSummary[], selected: number): Promise<ResumeSelection> {
	return ctx.ui.custom((tui, theme, _kb, done) => new TrailResumeView(tui, theme, summaries, selected, done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "88%", minWidth: 84, maxHeight: "90%", margin: 1 },
	});
}

function renderArtifactList(artifacts: Artifact[]): string {
	if (artifacts.length === 0) return "No Trail artifacts";
	return artifacts.map((a) => `${a.displayId}\t${a.ref}\t${a.kind}\t${a.title}\t${a.subtitle}`).join("\n");
}

async function createCheckpointLifecycle(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<CheckpointLifecycle> {
	const config = await loadConfig(ctx.cwd);
	const catalog = createArtifactCatalog(ctx, config);
	const store = createCheckpointStore();
	const summarizer = createCheckpointSummarizer();

	const selectArtifacts = (options: CheckpointCreateOptions): Artifact[] => {
		return catalog.selectForCheckpoint(options.mode, config.checkpointArtifacts);
	};

	const draftMarkdown = async (id: string, options: CheckpointCreateOptions, artifacts: Artifact[]): Promise<string> => {
		if (options.raw || !config.summarizer.enabled) {
			return buildRawCheckpointMarkdown(ctx, id, options.mode, options.note, options.consumeOnUse, artifacts);
		}
		if (ctx.hasUI) ctx.ui.notify("Trail summarizing checkpoint...", "info");
		try {
			return await summarizer.summarize({
				id,
				mode: options.mode,
				note: options.note,
				consumeOnUse: options.consumeOnUse,
				cwd: ctx.cwd,
				sourceSession: ctx.sessionManager.getSessionFile(),
				artifactsFile: store.artifactsFile(id),
				payload: catalog.checkpointPayload(artifacts, options.mode),
				references: buildReferenceList(artifacts, ctx.cwd),
				activeModel: ctx.model,
				modelRegistry: ctx.modelRegistry,
				config: config.summarizer,
				overrides: { model: options.model, maxOutputTokens: options.maxOutputTokens },
			});
		} catch (err) {
			notifyTrail(pi, ctx, `Trail summarizer failed; using raw checkpoint: ${String(err)}`, "warning");
			return buildRawCheckpointMarkdown(ctx, id, options.mode, options.note, options.consumeOnUse, artifacts);
		}
	};

	const reviewMarkdown = async (markdown: string): Promise<string | null> => {
		if (!ctx.hasUI) return markdown;
		const edited = await ctx.ui.editor("Edit Trail checkpoint", markdown);
		if (edited === undefined) return null;
		return edited;
	};

	const persistCheckpoint = async (id: string, options: CheckpointCreateOptions, markdown: string, artifacts: Artifact[]): Promise<CheckpointIndexEntry> => {
		return store.save({
			id,
			mode: options.mode,
			markdown,
			artifacts,
			cwd: ctx.cwd,
			sourceSession: ctx.sessionManager.getSessionFile(),
			note: options.note,
			consumeOnUse: options.consumeOnUse,
		});
	};

	const labelSession = (id: string, entry: CheckpointIndexEntry): void => {
		pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, entry);
		const leaf = ctx.sessionManager.getLeafId();
		if (leaf) pi.setLabel(leaf, `trail:${id}`);
	};

	return {
		async create(options: CheckpointCreateOptions): Promise<void> {
			const artifacts = selectArtifacts(options);
			if (artifacts.length === 0) {
				notifyTrail(pi, ctx, "Trail found no artifacts to checkpoint", "warning");
				return;
			}

			const id = makeCheckpointId();
			const draft = await draftMarkdown(id, options, artifacts);
			const markdown = await reviewMarkdown(draft);
			if (markdown === null) {
				notifyTrail(pi, ctx, "Trail checkpoint cancelled", "info");
				return;
			}

			const entry = await persistCheckpoint(id, options, markdown, artifacts);
			labelSession(id, entry);
			notifyTrail(pi, ctx, `Trail checkpoint saved: ${id}${options.consumeOnUse ? " (once)" : ""}`, "info");
		},
	};
}

async function startCheckpointSession(pi: ExtensionAPI, ctx: ExtensionCommandContext, store: ReturnType<typeof createCheckpointStore>, checkpoint: CheckpointIndexEntry, content: string): Promise<void> {
	const parentSession = ctx.sessionManager.getSessionFile();
	const result = await ctx.newSession({
		parentSession,
		withSession: async (replacementCtx) => {
			replacementCtx.ui.setEditorText(content);
			if (checkpoint.consumeOnUse) {
				try {
					await store.consume(checkpoint);
					replacementCtx.ui.notify(`Trail loaded and consumed checkpoint ${checkpoint.id}`, "info");
				} catch (err) {
					replacementCtx.ui.notify(`Trail loaded checkpoint ${checkpoint.id}, but could not delete it: ${String(err)}`, "warning");
				}
			} else {
				replacementCtx.ui.notify(`Trail loaded checkpoint ${checkpoint.id}`, "info");
			}
		},
	});
	if (result.cancelled) notifyTrail(pi, ctx, "Trail continue cancelled", "info");
}

async function continueCheckpoint(pi: ExtensionAPI, ctx: ExtensionCommandContext, idOrLast: string): Promise<void> {
	const store = createCheckpointStore();
	const checkpoint = await store.find(idOrLast || "last");
	if (!checkpoint) {
		notifyTrail(pi, ctx, "Trail checkpoint not found", "error");
		return;
	}
	await startCheckpointSession(pi, ctx, store, checkpoint, await store.readMarkdown(checkpoint));
}

async function selectCheckpointToContinue(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const store = createCheckpointStore();
	if (!ctx.hasUI) {
		await continueCheckpoint(pi, ctx, "last");
		return;
	}
	const summaries = await store.listSummaries();
	if (summaries.length === 0) {
		notifyTrail(pi, ctx, "Trail checkpoint not found", "error");
		return;
	}
	let selected = Math.max(0, summaries.length - 1);
	while (true) {
		const result = await showCheckpointResumeSelector(ctx, summaries, selected);
		if (!result) return;
		selected = result.index;
		const checkpoint = result.summary.entry;
		const markdown = await store.readMarkdown(checkpoint);
		if (result.action === "preview") {
			await showTextViewer(ctx, `Trail checkpoint ${checkpoint.id}`, markdown);
			continue;
		}
		if (result.action === "edit") {
			const edited = await ctx.ui.editor("Edit Trail checkpoint", markdown);
			if (edited === undefined) {
				notifyTrail(pi, ctx, "Trail continue cancelled", "info");
				return;
			}
			await startCheckpointSession(pi, ctx, store, checkpoint, edited);
			return;
		}
		await startCheckpointSession(pi, ctx, store, checkpoint, markdown);
		return;
	}
}

async function showCheckpointList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const store = createCheckpointStore();
	const index = await store.list();
	const lines = index.length
		? index.map((c) => `${c.id}\t${c.mode}${c.consumeOnUse ? ":once" : ""}\t${c.cwd}\t${c.note ?? ""}`).join("\n")
		: "No Trail checkpoints";
	emitText(pi, ctx, lines, "list", "trail · checkpoints");
}

type TrailMessageKind = "help" | "list" | "notice" | "error" | "usage";

type TrailMessageDetails = { kind: TrailMessageKind; heading?: string };

function emitText(pi: ExtensionAPI, _ctx: ExtensionCommandContext, text: string, kind: TrailMessageKind = "notice", heading?: string): void {
	pi.sendMessage(
		{ customType: "trail", content: text, display: true, details: { kind, heading } satisfies TrailMessageDetails },
		{ triggerTurn: false },
	);
}

function notifyTrail(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else pi.sendMessage({ customType: "trail", content: text, display: true, details: { kind: level === "error" ? "error" : "notice" } satisfies TrailMessageDetails }, { triggerTurn: false });
}

function trailMessageRenderer(): MessageRenderer<TrailMessageDetails> {
	return (message, _options, theme) => {
		const details = (message.details ?? { kind: "notice" }) as TrailMessageDetails;
		const kind = details.kind ?? "notice";
		const labelByKind: Record<TrailMessageKind, ThemeColor> = {
			help: "accent",
			list: "customMessageLabel",
			notice: "muted",
			usage: "warning",
			error: "error",
		};
		const labelColor: ThemeColor = labelByKind[kind] ?? "muted";
		const headingText = details.heading ?? `trail · ${kind}`;
		const content = typeof message.content === "string" ? message.content : "";
		const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));
		box.addChild(new Text(theme.fg(labelColor, theme.bold(headingText)), 0, 0));
		box.addChild(new Text("", 0, 0));
		for (const rawLine of content.split("\n")) {
			const colored = kind === "error" ? theme.fg("error", rawLine) : rawLine;
			box.addChild(new Text(colored, 0, 0));
		}
		return box;
	};
}

type ChipMode = "ref" | "full";

type Chip = {
	displayId: string;
	ref: string;
	mode: ChipMode;
	kind: ArtifactKind;
	title: string;
};

type ChipToggleResult = "added" | "removed" | "upgraded" | "downgraded";

export default function trailExtension(pi: ExtensionAPI) {
	let chips: Chip[] = [];
	let activeCtx: ExtensionContext | undefined;

	const findChipIndex = (ref: string): number => chips.findIndex((c) => c.ref === ref);

	const toggleChip = (artifact: Artifact, mode: ChipMode): ChipToggleResult => {
		const idx = findChipIndex(artifact.ref);
		if (idx === -1) {
			chips = [...chips, { displayId: artifact.displayId, ref: artifact.ref, mode, kind: artifact.kind, title: artifact.title }];
			return "added";
		}
		const existing = chips[idx]!;
		if (existing.mode === mode) {
			chips = chips.filter((_, i) => i !== idx);
			return "removed";
		}
		chips = chips.map((c, i) => (i === idx ? { ...c, mode } : c));
		return mode === "full" ? "upgraded" : "downgraded";
	};

	const clearChips = (): boolean => {
		if (chips.length === 0) return false;
		chips = [];
		return true;
	};

	const refreshChipWidget = (): void => {
		const ctx = activeCtx;
		if (!ctx?.hasUI) return;
		if (chips.length === 0) {
			ctx.ui.setWidget("trail-chips", undefined);
			return;
		}
		const snapshot = chips;
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
				const summary = dim(`${snapshot.length} chip${snapshot.length === 1 ? "" : "s"} · expand at send · /trail clear`);
				const container = new Container();
				container.addChild(new Text(`${label} ${dim("·")} ${tags}  ${summary}`, 0, 0));
				return container;
			},
			{ placement: "aboveEditor" },
		);
	};

	const renderChipBlock = (chip: Chip, content: string): string => {
		const opener = `<<trail @${chip.displayId} ${chip.mode}>>`;
		const closer = `<</trail>>`;
		return `${opener}\n${content}\n${closer}`;
	};

	const expandChipsForSubmit = async (
		ctx: ExtensionContext,
		userText: string,
	): Promise<{ text: string; expanded: number; missing: string[] }> => {
		if (chips.length === 0) return { text: userText, expanded: 0, missing: [] };
		const config = await loadConfig(ctx.cwd);
		const catalog = createArtifactCatalog(ctx, config);
		const blocks: string[] = [];
		const missing: string[] = [];
		for (const chip of chips) {
			const artifact = catalog.find(chip.ref) ?? catalog.find(chip.displayId);
			if (!artifact) {
				missing.push(chip.displayId);
				continue;
			}
			const body = chip.mode === "full" ? catalog.fullText(artifact) : catalog.reference(artifact);
			blocks.push(renderChipBlock(chip, body));
		}
		if (blocks.length === 0) return { text: userText, expanded: 0, missing };
		const header = `<<trail-context: ${blocks.length} reference${blocks.length === 1 ? "" : "s"}>>`;
		const footer = `<</trail-context>>`;
		const wrapped = `${header}\n${blocks.join("\n\n")}\n${footer}`;
		const text = userText.trim() ? `${wrapped}\n\n${userText}` : wrapped;
		return { text, expanded: blocks.length, missing };
	};

	const announceChipChange = (ctx: ExtensionCommandContext, chip: Chip, result: ChipToggleResult): void => {
		const name = `@${chip.displayId}${chip.mode === "full" ? "*" : ""}`;
		const verb =
			result === "added" ? "added" :
			result === "removed" ? "removed" :
			result === "upgraded" ? "→ full" :
			"→ ref";
		notifyTrail(pi, ctx, `Trail chip ${name} ${verb}`, "info");
	};

	pi.registerMessageRenderer("trail", trailMessageRenderer());

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		chips = [];
		if (ctx.hasUI) ctx.ui.setWidget("trail-chips", undefined);
	});

	pi.on("session_shutdown", () => {
		activeCtx = undefined;
		chips = [];
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (chips.length === 0) return { action: "continue" };
		const result = await expandChipsForSubmit(ctx, event.text);
		if (result.expanded === 0 && result.missing.length === 0) return { action: "continue" };
		if (result.missing.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Trail dropped stale chip(s): ${result.missing.join(", ")}`, "warning");
		}
		chips = [];
		refreshChipWidget();
		if (result.expanded === 0) return { action: "continue" };
		return { action: "transform", text: result.text };
	});

	pi.registerCommand("trail", {
		description: "Navigate session artifacts and create fresh-session checkpoints",
		getArgumentCompletions: (prefix: string) => {
			const items = TRAIL_COMMANDS.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseTrailCommand(args);
			if (!parsed.ok) {
				emitText(pi, ctx, `${parsed.message}\n\n${parsed.usage}`, "usage", "trail · usage");
				return;
			}

			const intent = parsed.intent;
			if (intent.kind === "help") {
				emitText(pi, ctx, trailUsage(), "help", "trail · help");
				return;
			}

			if (intent.kind === "clear") {
				const had = clearChips();
				refreshChipWidget();
				notifyTrail(pi, ctx, had ? "Trail chips cleared" : "Trail had no chips", "info");
				return;
			}

			if (intent.kind === "checkpoint") {
				const checkpointLifecycle = await createCheckpointLifecycle(pi, ctx);
				await checkpointLifecycle.create(intent.options);
				return;
			}

			if (intent.kind === "continue") {
				if (intent.idOrLast) await continueCheckpoint(pi, ctx, intent.idOrLast);
				else await selectCheckpointToContinue(pi, ctx);
				return;
			}

			if (intent.kind === "list") {
				await showCheckpointList(pi, ctx);
				return;
			}

			const config = await loadConfig(ctx.cwd);
			const catalog = createArtifactCatalog(ctx, config);
			let artifacts = catalog.list();

			if (intent.kind === "search") {
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
				if (intent.action === "ref" || intent.action === "inject") {
					const r = toggleChip(artifact, "ref");
					refreshChipWidget();
					announceChipChange(ctx, { displayId: artifact.displayId, ref: artifact.ref, mode: "ref", kind: artifact.kind, title: artifact.title }, r);
				} else if (intent.action === "inject-full") {
					const r = toggleChip(artifact, "full");
					refreshChipWidget();
					announceChipChange(ctx, { displayId: artifact.displayId, ref: artifact.ref, mode: "full", kind: artifact.kind, title: artifact.title }, r);
				} else {
					const ok = await copyToClipboard(catalog.fullText(artifact));
					notifyTrail(pi, ctx, ok ? `Trail copied ${artifact.id}` : "No clipboard command found", ok ? "info" : "warning");
				}
				return;
			}

			if (!ctx.hasUI) {
				emitText(pi, ctx, renderArtifactList(artifacts), "list", "trail · artifacts");
				return;
			}

			while (true) {
				const result = await showTrailBrowser(ctx, catalog, artifacts);
				if (!result) return;
				if (result.action === "checkpoint") {
					const checkpointLifecycle = await createCheckpointLifecycle(pi, ctx);
					await checkpointLifecycle.create({ mode: "handoff", note: "", consumeOnUse: false, raw: false });
					return;
				}
				if (!result.artifact) return;
				if (result.action === "inspect") {
					await showArtifactViewer(ctx, catalog, result.artifact);
					continue;
				}
				const artifact = result.artifact;
				if (result.action === "reference") {
					const r = toggleChip(artifact, "ref");
					refreshChipWidget();
					announceChipChange(ctx, { displayId: artifact.displayId, ref: artifact.ref, mode: "ref", kind: artifact.kind, title: artifact.title }, r);
				} else if (result.action === "injectFull") {
					const r = toggleChip(artifact, "full");
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
