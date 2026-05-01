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
import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@mariozechner/pi-coding-agent";
import {
	Container,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	type Component,
	type TUI,
} from "@mariozechner/pi-tui";
import { createCheckpointStore } from "./checkpoint-store.js";
import type { Artifact, ArtifactKind, ArtifactSummary, CheckpointIndexEntry, CheckpointMode } from "./types.js";


type TrailConfig = {
	maxArtifacts: number;
	maxBodyChars: number;
	checkpointArtifacts: number;
	summarizer: {
		enabled: boolean;
		provider?: string;
		model?: string;
		maxOutputTokens: number;
		maxInputChars: number;
		timeoutMs: number;
		systemPrompt?: string;
	};
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

type CheckpointCreateOptions = {
	mode: CheckpointMode;
	note: string;
	consumeOnUse: boolean;
	raw: boolean;
	model?: string;
	maxOutputTokens?: number;
};

type CheckpointLifecycle = {
	create(args: string): Promise<void>;
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

function buildArtifacts(ctx: ExtensionCommandContext, config: TrailConfig): Artifact[] {
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

function parseCheckpointArgs(args: string): CheckpointCreateOptions {
	let mode: CheckpointMode = "handoff";
	let consumeOnUse = false;
	let raw = false;
	let model: string | undefined;
	let maxOutputTokens: number | undefined;
	const noteParts: string[] = [];
	const parts = args.trim().split(/\s+/).filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part === "--handoff") mode = "handoff";
		else if (part === "--compact") mode = "compact";
		else if (part === "--debug") mode = "debug";
		else if (part === "--review") mode = "review";
		else if (part === "--once" || part === "--delete-on-use") consumeOnUse = true;
		else if (part === "--raw" || part === "--no-summary") raw = true;
		else if (part === "--model" && parts[i + 1]) model = parts[++i];
		else if (part === "--max-output" && parts[i + 1]) maxOutputTokens = Number(parts[++i]) || undefined;
		else noteParts.push(part);
	}
	return { mode, note: noteParts.join(" "), consumeOnUse, raw, model, maxOutputTokens };
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

function checkpointSystemPrompt(mode: CheckpointMode, maxOutputTokens: number): string {
	const modeGuidance: Record<CheckpointMode, string> = {
		handoff: "Preserve continuity for a fresh coding-agent session. Prioritize current goal, decisions, edited/important files, and next steps.",
		compact: "Make the smallest useful continuation note. Ruthlessly remove transcript noise and low-value details.",
		debug: "Focus on failing commands, error messages, hypotheses already tried, likely root causes, and safest next debugging steps.",
		review: "Focus on review state: changed files, design decisions, risks, test status, and what a reviewer should inspect next.",
	};
	return [
		"You are Trail, a context distillation assistant for Pi coding sessions.",
		"Summarize session artifacts into a fresh-session checkpoint.",
		"Do not produce a transcript search result or artifact dump.",
		"Preserve continuity, discard noise, and prevent repeated mistakes.",
		"Use compact markdown. Target the requested maximum output length.",
		"Reference artifacts by IDs like [file:f12] or [command:c8] when useful instead of copying large excerpts.",
		"Never invent files, commands, decisions, or outcomes not present in artifacts.",
		`Mode: ${mode}. ${modeGuidance[mode]}`,
		`Maximum output tokens: ${maxOutputTokens}.`,
	].join("\n");
}

function checkpointInput(ctx: ExtensionCommandContext, catalog: ArtifactCatalog, mode: CheckpointMode, note: string, artifacts: Artifact[], maxInputChars: number): string {
	const payload = catalog.checkpointPayload(artifacts, mode);
	return truncate([
		`cwd: ${ctx.cwd}`,
		ctx.sessionManager.getSessionFile() ? `sourceSession: ${ctx.sessionManager.getSessionFile()}` : undefined,
		`mode: ${mode}`,
		note ? `userNote: ${note}` : undefined,
		"",
		"Write checkpoint markdown with these sections:",
		"## Summary",
		"## Decisions / constraints",
		"## Current state",
		"## Next steps",
		"## Avoid repeating",
		"## References",
		"",
		"References available:",
		buildReferenceList(artifacts, ctx.cwd),
		"",
		"Artifacts JSON:",
		JSON.stringify(payload, null, 2),
	].filter((line): line is string => line !== undefined).join("\n"), maxInputChars);
}

async function buildSummarizedCheckpointMarkdown(
	ctx: ExtensionCommandContext,
	config: TrailConfig,
	catalog: ArtifactCatalog,
	id: string,
	mode: CheckpointMode,
	note: string,
	consumeOnUse: boolean,
	artifacts: Artifact[],
	artifactsFile: string,
	overrides: { model?: string; maxOutputTokens?: number },
): Promise<string> {
	const maxOutputTokens = overrides.maxOutputTokens ?? config.summarizer.maxOutputTokens;
	const modelName = overrides.model ?? (config.summarizer.provider && config.summarizer.model ? `${config.summarizer.provider}/${config.summarizer.model}` : undefined);
	const model = modelName
		? (() => {
			const [provider, ...rest] = modelName.split("/");
			return provider && rest.length ? ctx.modelRegistry.find(provider, rest.join("/")) : undefined;
		})()
		: ctx.model;
	if (!model) throw new Error("No Trail summarizer model configured and no active model selected");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);

	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: checkpointInput(ctx, catalog, mode, note, artifacts, config.summarizer.maxInputChars) }],
		timestamp: Date.now(),
	};
	const response = await complete(
		model,
		{ systemPrompt: config.summarizer.systemPrompt ?? checkpointSystemPrompt(mode, maxOutputTokens), messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: maxOutputTokens, timeoutMs: config.summarizer.timeoutMs },
	);
	const summary = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n").trim();
	if (!summary) throw new Error("Trail summarizer returned empty checkpoint");

	const lines: string[] = [];
	lines.push(`# Trail checkpoint ${id}`);
	lines.push("");
	lines.push(`mode: ${mode}`);
	lines.push(`summary: llm`);
	lines.push(`cwd: ${ctx.cwd}`);
	lines.push(`created: ${new Date().toISOString()}`);
	if (ctx.sessionManager.getSessionFile()) lines.push(`sourceSession: ${ctx.sessionManager.getSessionFile()}`);
	if (note) lines.push(`note: ${note}`);
	if (consumeOnUse) lines.push("consumeOnUse: true");
	lines.push(`artifacts: ${artifactsFile}`);
	lines.push("");
	lines.push(summary);
	lines.push("");
	lines.push("## Trail artifact references");
	lines.push(buildReferenceList(artifacts, ctx.cwd));
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

function injectIntoEditor(ctx: ExtensionCommandContext, text: string): void {
	if (!ctx.hasUI) return;
	const current = ctx.ui.getEditorText?.() ?? "";
	ctx.ui.setEditorText(current.trim() ? `${current}\n\n${text}` : text);
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

function createArtifactCatalog(ctx: ExtensionCommandContext, config: TrailConfig): ArtifactCatalog {
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
		const container = new Container();
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		container.addChild(new DynamicBorder((s: string) => accent(s)));
		container.addChild(new Text(`${accent(this.theme.bold("Trail inspect"))} ${dim(this.title)}`, 1, 0));
		container.addChild(new Text(dim(`lines ${Math.min(this.offset + 1, this.lines.length)}-${Math.min(this.offset + 34, this.lines.length)} / ${this.lines.length}`), 1, 0));
		for (const line of this.lines.slice(this.offset, this.offset + 34)) {
			container.addChild(new Text(truncateToWidth(line, width - 2), 1, 0));
		}
		container.addChild(new Text(dim("j/k scroll · d/u half-page · g/G top/bottom · q close"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => accent(s)));
		this.cachedLines = container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

async function showArtifactViewer(ctx: ExtensionCommandContext, catalog: ArtifactCatalog, artifact: Artifact): Promise<void> {
	const inspected = await catalog.inspect(artifact);
	await ctx.ui.custom<void>((tui, theme, _kb, done) => new TrailTextViewer(tui, theme, inspected.title, inspected.text, done), {
		overlay: true,
		overlayOptions: { anchor: "right-center", width: "90%", minWidth: 90, maxHeight: "95%", margin: 1 },
	});
}

class TrailView implements Component {
	private container = new Container();
	private selected = 0;
	private filter: ArtifactKind | "all" = "all";
	private showDetail = true;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private tui: TUI,
		private theme: any,
		private artifacts: Artifact[],
		private fullText: (artifact: Artifact) => string,
		private done: (result: { action: "inspect" | "reference" | "injectFull" | "copy" | "checkpoint"; artifact?: Artifact } | null) => void,
	) {}

	private filtered(): Artifact[] {
		return this.filter === "all" ? this.artifacts : this.artifacts.filter((a) => a.kind === this.filter);
	}

	handleInput(data: string): void {
		const items = this.filtered();
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
			this.done(null);
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) this.selected = Math.min(this.selected + 1, Math.max(0, items.length - 1));
		else if (data === "k" || matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (data === "g") this.selected = 0;
		else if (data === "G") this.selected = Math.max(0, items.length - 1);
		else if (data === "v") this.showDetail = !this.showDetail;
		else if (data === "\t" || matchesKey(data, Key.tab)) this.cycleFilter();
		else if (matchesKey(data, Key.enter)) this.done({ action: "inspect", artifact: items[this.selected] });
		else if (data === "r" || data === "i") this.done({ action: "reference", artifact: items[this.selected] });
		else if (data === "I") this.done({ action: "injectFull", artifact: items[this.selected] });
		else if (data === "y") this.done({ action: "copy", artifact: items[this.selected] });
		else if (data === "c") this.done({ action: "checkpoint" });
		this.invalidate();
		this.tui.requestRender();
	}

	private cycleFilter(): void {
		const filters: Array<ArtifactKind | "all"> = ["all", "error", "command", "file", "code", "prompt", "response", "checkpoint"];
		this.filter = filters[(filters.indexOf(this.filter) + 1) % filters.length] ?? "all";
		this.selected = 0;
	}

	invalidate(): void {
		this.container.invalidate();
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.container = new Container();
		const items = this.filtered();
		const selected = items[this.selected];
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);

		this.container.addChild(new DynamicBorder((s: string) => accent(s)));
		this.container.addChild(new Text(`${accent(this.theme.bold("Trail"))} ${dim(`artifacts:${items.length}/${this.artifacts.length} filter:${this.filter}`)}`, 1, 0));

		const listWidth = Math.max(30, width);
		const visible = items.slice(Math.max(0, this.selected - 6), Math.max(12, this.selected + 6));
		const start = items.indexOf(visible[0] ?? items[0]);
		for (let i = 0; i < visible.length; i++) {
			const artifact = visible[i];
			if (!artifact) continue;
			const absolute = start + i;
			const marker = absolute === this.selected ? accent("▸") : " ";
			const kind = absolute === this.selected ? accent(artifact.kind.padEnd(10)) : muted(artifact.kind.padEnd(10));
			const line = `${marker} ${kind} ${artifact.id.padEnd(5)} ${artifact.title} ${dim(artifact.subtitle)}`;
			this.container.addChild(new Text(truncateToWidth(line, listWidth - 2), 1, 0));
		}

		if (this.showDetail && selected) {
			this.container.addChild(new Text("", 1, 0));
			this.container.addChild(new DynamicBorder((s: string) => muted(s)));
			this.container.addChild(new Text(accent(selected.title), 1, 0));
			const detail = this.fullText(selected).split("\n").slice(0, 22);
			for (const line of detail) this.container.addChild(new Text(truncateToWidth(line, listWidth - 2), 1, 0));
		}

		this.container.addChild(new Text(dim("j/k move · tab kind · enter inspect · i/r ref · I full inject · y copy · c checkpoint · v detail · q close"), 1, 0));
		this.container.addChild(new DynamicBorder((s: string) => accent(s)));
		this.cachedLines = this.container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

async function showTrailBrowser(ctx: ExtensionCommandContext, catalog: ArtifactCatalog, artifacts: Artifact[]): Promise<{ action: "inspect" | "reference" | "injectFull" | "copy" | "checkpoint"; artifact?: Artifact } | null> {
	return ctx.ui.custom((tui, theme, _kb, done) => new TrailView(tui, theme, artifacts, (artifact) => catalog.fullText(artifact), done), {
		overlay: true,
		overlayOptions: { anchor: "right-center", width: "80%", minWidth: 80, maxHeight: "90%", margin: 1 },
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

	const selectArtifacts = (options: CheckpointCreateOptions): Artifact[] => {
		return catalog.selectForCheckpoint(options.mode, config.checkpointArtifacts);
	};

	const draftMarkdown = async (id: string, options: CheckpointCreateOptions, artifacts: Artifact[]): Promise<string> => {
		if (options.raw || !config.summarizer.enabled) {
			return buildRawCheckpointMarkdown(ctx, id, options.mode, options.note, options.consumeOnUse, artifacts);
		}
		if (ctx.hasUI) ctx.ui.notify("Trail summarizing checkpoint...", "info");
		try {
			return await buildSummarizedCheckpointMarkdown(ctx, config, catalog, id, options.mode, options.note, options.consumeOnUse, artifacts, store.artifactsFile(id), {
				model: options.model,
				maxOutputTokens: options.maxOutputTokens,
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
		async create(args: string): Promise<void> {
			const options = parseCheckpointArgs(args);
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

async function continueCheckpoint(pi: ExtensionAPI, ctx: ExtensionCommandContext, idOrLast: string): Promise<void> {
	const store = createCheckpointStore();
	const checkpoint = await store.find(idOrLast || "last");
	if (!checkpoint) {
		notifyTrail(pi, ctx, "Trail checkpoint not found", "error");
		return;
	}
	const content = await fs.readFile(checkpoint.file, "utf8");
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

async function showCheckpointList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const store = createCheckpointStore();
	const index = await store.list();
	const lines = index.length
		? index.map((c) => `${c.id}\t${c.mode}${c.consumeOnUse ? ":once" : ""}\t${c.cwd}\t${c.note ?? ""}`).join("\n")
		: "No Trail checkpoints";
	emitText(pi, ctx, lines);
}

function helpText(): string {
	return [
		"Trail commands:",
		"/trail                         browse artifacts",
		"/trail search <query>          search artifacts with ripgrep, then browse matches",
		"/trail checkpoint [--handoff|--compact|--debug|--review] [--once] [--raw] [note]",
		"/trail continue <id|last>",
		"/trail resume [id|last]",
		"/trail list",
		"/trail ref <artifact-id>       inject compact artifact reference",
		"/trail inject <artifact-id>    alias for ref",
		"/trail inject-full <artifact-id>",
		"/trail copy <artifact-id>",
	].join("\n");
}

function emitText(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string): void {
	if (ctx.hasUI) ctx.ui.setEditorText(text);
	else pi.sendMessage({ customType: "trail", content: text, display: true }, { triggerTurn: false });
}

function notifyTrail(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else pi.sendMessage({ customType: "trail", content: text, display: true }, { triggerTurn: false });
}

export default function trailExtension(pi: ExtensionAPI) {
	pi.registerCommand("trail", {
		description: "Navigate session artifacts and create fresh-session checkpoints",
		getArgumentCompletions: (prefix: string) => {
			const commands = ["search", "checkpoint", "continue", "resume", "list", "ref", "inject", "inject-full", "copy", "help"];
			const items = commands.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [subcommandRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = subcommandRaw ?? "browse";
			const restText = rest.join(" ");

			if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
				emitText(pi, ctx, helpText());
				return;
			}

			if (subcommand === "checkpoint") {
				const checkpointLifecycle = await createCheckpointLifecycle(pi, ctx);
				await checkpointLifecycle.create(restText);
				return;
			}

			if (subcommand === "continue" || subcommand === "resume") {
				await continueCheckpoint(pi, ctx, restText || "last");
				return;
			}

			if (subcommand === "list") {
				await showCheckpointList(pi, ctx);
				return;
			}

			const config = await loadConfig(ctx.cwd);
			const catalog = createArtifactCatalog(ctx, config);
			let artifacts = catalog.list();

			if (subcommand === "search") {
				if (!restText) {
					notifyTrail(pi, ctx, "Usage: /trail search <query>", "warning");
					return;
				}
				artifacts = await catalog.search(restText);
				if (artifacts.length === 0) {
					notifyTrail(pi, ctx, `Trail search found no artifacts for: ${restText}`, "info");
					return;
				}
				if (!ctx.hasUI) {
					emitText(pi, ctx, renderArtifactList(artifacts));
					return;
				}
			}

			if (["ref", "inject", "inject-full", "copy"].includes(subcommand)) {
				const artifact = catalog.find(restText || subcommandRaw || "");
				if (!artifact) {
					notifyTrail(pi, ctx, "Trail artifact not found", "error");
					return;
				}
				if (subcommand === "ref" || subcommand === "inject") {
					injectIntoEditor(ctx, catalog.reference(artifact));
					notifyTrail(pi, ctx, `Trail referenced ${artifact.id}`, "info");
				} else if (subcommand === "inject-full") {
					injectIntoEditor(ctx, catalog.fullText(artifact));
					notifyTrail(pi, ctx, `Trail injected full ${artifact.id}`, "info");
				} else {
					const ok = await copyToClipboard(catalog.fullText(artifact));
					notifyTrail(pi, ctx, ok ? `Trail copied ${artifact.id}` : "No clipboard command found", ok ? "info" : "warning");
				}
				return;
			}

			if (!ctx.hasUI) {
				emitText(pi, ctx, renderArtifactList(artifacts));
				return;
			}

			while (true) {
				const result = await showTrailBrowser(ctx, catalog, artifacts);
				if (!result) return;
				if (result.action === "checkpoint") {
					const checkpointLifecycle = await createCheckpointLifecycle(pi, ctx);
					await checkpointLifecycle.create("--handoff");
					return;
				}
				if (!result.artifact) return;
				if (result.action === "inspect") {
					await showArtifactViewer(ctx, catalog, result.artifact);
					continue;
				}
				if (result.action === "reference") {
					injectIntoEditor(ctx, catalog.reference(result.artifact));
					notifyTrail(pi, ctx, `Trail referenced ${result.artifact.id}`, "info");
				} else if (result.action === "injectFull") {
					injectIntoEditor(ctx, catalog.fullText(result.artifact));
					notifyTrail(pi, ctx, `Trail injected full ${result.artifact.id}`, "info");
				} else if (result.action === "copy") {
					const ok = await copyToClipboard(catalog.fullText(result.artifact));
					notifyTrail(pi, ctx, ok ? `Trail copied ${result.artifact.id}` : "No clipboard command found", ok ? "info" : "warning");
				}
				return;
			}
		},
	});
}
