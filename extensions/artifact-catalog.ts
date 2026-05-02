import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Artifact, ArtifactKind, ArtifactSummary, CheckpointIndexEntry, CheckpointMode } from "./types.js";

export type ArtifactCatalogConfig = {
	maxArtifacts: number;
	maxBodyChars: number;
};

export type TrailRuntimeContext = {
	cwd: string;
	sessionManager: { getBranch(): unknown[] };
};

export type ArtifactCatalog = {
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

const CHECKPOINT_CUSTOM_TYPE = "trail:checkpoint";

export function textFromContent(content: unknown): string {
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

export function truncateText(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[Trail truncated ${text.length - max} chars]`;
}

function firstLine(text: string, fallback: string): string {
	return text.trim().split("\n").find((line) => line.trim())?.trim() || fallback;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function formatArtifact(artifact: Artifact): string {
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

function buildArtifacts(ctx: TrailRuntimeContext, config: ArtifactCatalogConfig): Artifact[] {
	const branch = ctx.sessionManager.getBranch();
	const calls = new Map<string, ToolCallInfo>();
	const artifacts: Artifact[] = [];

	const push = (artifact: Omit<Artifact, "id" | "displayId" | "ref">) => {
		if (artifacts.length >= config.maxArtifacts) return;
		const displayId = makeArtifactId(artifact.kind, artifacts.length + 1);
		const entryKey = artifact.entryId ?? "session";
		const sameEntryOrdinal = artifacts.filter((a) => a.kind === artifact.kind && (a.entryId ?? "session") === entryKey).length;
		const ref = `${artifact.kind}:${entryKey}:${sameEntryOrdinal}`;
		artifacts.push({ ...artifact, id: displayId, displayId, ref, body: truncateText(artifact.body, config.maxBodyChars) });
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
	if (artifact.kind === "prompt") return `Reference Trail ${ref}: prior user prompt \"${truncateText(artifact.title, 160)}\".`;
	if (artifact.kind === "response") return `Reference Trail ${ref}: prior model response \"${truncateText(artifact.title, 160)}\".`;
	if (artifact.kind === "code") return `Reference Trail ${ref}: ${artifact.title} (${artifact.subtitle}). Inspect artifact before reusing exact code.`;
	return `Reference Trail ${ref}: ${artifact.title}. ${artifact.subtitle}`;
}

export function buildReferenceList(artifacts: Artifact[], cwd: string): string {
	return artifacts.map((artifact) => `- ${artifactRefId(artifact)} ${buildArtifactReference(artifact, cwd)}`).join("\n");
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

export function artifactFilePath(artifact: Artifact, cwd: string): string | undefined {
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

export function createArtifactCatalog(ctx: TrailRuntimeContext, config: ArtifactCatalogConfig): ArtifactCatalog {
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
				body: truncateText(artifact.body, mode === "compact" ? 900 : 1600),
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
