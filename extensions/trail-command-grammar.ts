import type { CheckpointMode } from "./types.js";

export type CheckpointCreateOptions = {
	mode: CheckpointMode;
	note: string;
	consumeOnUse: boolean;
	raw: boolean;
	model?: string;
	maxOutputTokens?: number;
};

export type TrailIntent =
	| { kind: "help"; advanced?: boolean }
	| { kind: "browse"; mode?: "review" | "answers" | "log" }
	| { kind: "clear" }
	| { kind: "checkpoint"; options: CheckpointCreateOptions }
	| { kind: "continue"; idOrLast?: string }
	| { kind: "delete"; target: string | undefined; targetKind: "checkpoint" | "worker" }
	| { kind: "list"; includeConsumed?: boolean; workers?: boolean }
	| { kind: "load"; ref?: string; includeConsumed?: boolean; refKind: "checkpoint" | "worker" }
	| { kind: "unload"; target: string; targetKind: "checkpoint" | "worker" | "all" }
	| { kind: "spawn"; task: string; worktree?: boolean; fresh?: boolean }
	| { kind: "workers" }
	| { kind: "worker-result"; worker: string; action: "show" | "use" }
	| { kind: "tell"; worker: string; text?: string }
	| { kind: "worker-state"; state: "needs_input" | "ready" | "failed"; text?: string }
	| { kind: "answers"; query?: string }
	| { kind: "search"; query: string }
	| { kind: "artifact"; action: "ref" | "inject" | "inject-full" | "copy"; idOrRef: string };

export type ParseResult =
	| { ok: true; intent: TrailIntent }
	| { ok: false; message: string; usage: string };

export const TRAIL_COMMANDS = ["answers", "log", "search", "checkpoint", "continue", "resume", "spawn", "result", "use", "ask", "tell", "wait", "done", "fail", "workers", "load", "unload", "delete", "list", "ref", "inject", "inject-full", "copy", "clear", "help"] as const;

const WORKER_PREFIX = "w:";
const WORKER_SHORT = /^w(\d+)$/i;

function stripWorkerPrefix(value: string): { id: string; isWorker: boolean } {
	if (value.startsWith(WORKER_PREFIX)) return { id: value.slice(WORKER_PREFIX.length), isWorker: true };
	if (WORKER_SHORT.test(value)) return { id: value, isWorker: true };
	return { id: value, isWorker: false };
}

const CHECKPOINT_USAGE = "/trail checkpoint [--handoff|--compact|--debug|--review] [--once] [--raw] [--model <provider/model>] [--max-output <tokens>] [--] [note]";
const MODE_FLAGS: Record<string, CheckpointMode> = {
	"--handoff": "handoff",
	"--compact": "compact",
	"--debug": "debug",
	"--review": "review",
};
const BOOLEAN_FLAGS = new Set(["--once", "--delete-on-use", "--raw", "--no-summary"]);
const VALUE_FLAGS = new Set(["--model", "--max-output"]);

export function trailUsage(advanced = false): string {
	const primary = [
		"Trail · core loop:",
		"/trail                         open inbox",
		"/trail spawn [--fresh] <task>  start background worker (seeds parent session by default)",
		"/trail tell w<N> [text]        reply to a worker",
		"/trail w<N>                    show worker result above editor",
		"/trail checkpoint [flags] [note]   create a handoff checkpoint",
		"/trail continue [id|last]      resume from a checkpoint",
		"",
		"more: /trail help advanced",
	];
	if (!advanced) return primary.join("\n");
	return [
		...primary,
		"",
		"Trail · advanced:",
		"/trail answers [query]         browse assistant/worker answers",
		"/trail log                     audit timeline grouped by episode",
		"/trail search <query>          ranked artifact search",
		"/trail workers                 worker dashboard",
		"/trail use w<N>                attach worker result to next prompt",
		"/trail ask w<N> [text]         alias for tell",
		"/trail result w<N>             alias for /trail w<N>",
		"/trail resume [id|last]        alias for continue",
		CHECKPOINT_USAGE,
		"/trail load [id|last|w<N>] [--include-consumed]   mount checkpoint or worker artifacts (no model tokens)",
		"/trail unload <id|w<N>|all>    drop a loaded slot",
		"/trail delete [id|last|w<N>]",
		"/trail list [--include-consumed] [--workers]",
		"/trail ref <artifact-id>       attach compact chip (@id) above editor",
		"/trail inject <artifact-id>    alias for ref",
		"/trail inject-full <artifact-id>  attach full chip (@id*) above editor",
		"/trail copy <artifact-id>      copy artifact to clipboard",
		"/trail clear                   drop all pending chips",
		"/trail wait <question>         worker fallback: ask parent for input",
		"/trail done [summary]          worker fallback: mark output ready",
		"/trail fail <reason>           worker fallback: mark work failed",
	].join("\n");
}

function parseError(message: string, usage = trailUsage()): ParseResult {
	return { ok: false, message, usage };
}

function tokenize(input: string): { ok: true; tokens: string[] } | { ok: false; message: string } {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaping) current += "\\";
	if (quote) return { ok: false, message: `Unclosed ${quote} quote` };
	if (current) tokens.push(current);
	return { ok: true, tokens };
}

function parseContinueCommand(rest: string[]): ParseResult {
	if (rest.length === 0) return { ok: true, intent: { kind: "continue" } };
	if (rest.length > 1) return parseError("Usage: /trail continue [id|last]");
	return { ok: true, intent: { kind: "continue", idOrLast: rest[0]! } };
}

function parseDeleteCommand(rest: string[]): ParseResult {
	if (rest.length === 0) return { ok: true, intent: { kind: "delete", target: undefined, targetKind: "checkpoint" } };
	if (rest.length > 1) return parseError("Usage: /trail delete [id|last|w:<worker>]");
	const { id, isWorker } = stripWorkerPrefix(rest[0]!);
	return { ok: true, intent: { kind: "delete", target: id, targetKind: isWorker ? "worker" : "checkpoint" } };
}

function requireArtifactArg(action: "ref" | "inject" | "inject-full" | "copy", rest: string[]): ParseResult {
	if (rest.length !== 1) return parseError(`Usage: /trail ${action} <artifact-id>`);
	return { ok: true, intent: { kind: "artifact", action, idOrRef: rest[0]! } };
}

function parseCheckpoint(tokens: string[]): ParseResult {
	let mode: CheckpointMode = "handoff";
	let sawMode = false;
	let consumeOnUse = false;
	let raw = false;
	let model: string | undefined;
	let maxOutputTokens: number | undefined;
	const noteParts: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--") {
			noteParts.push(...tokens.slice(i + 1));
			break;
		}
		if (token in MODE_FLAGS) {
			if (sawMode) return parseError("Use only one checkpoint mode flag", CHECKPOINT_USAGE);
			mode = MODE_FLAGS[token]!;
			sawMode = true;
			continue;
		}
		if (BOOLEAN_FLAGS.has(token)) {
			if (token === "--once" || token === "--delete-on-use") consumeOnUse = true;
			else raw = true;
			continue;
		}
		if (VALUE_FLAGS.has(token)) {
			const value = tokens[++i];
			if (!value) return parseError(`Missing value for ${token}`, CHECKPOINT_USAGE);
			if (token === "--model") model = value;
			else {
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed <= 0) return parseError("--max-output must be a positive integer", CHECKPOINT_USAGE);
				maxOutputTokens = parsed;
			}
			continue;
		}
		if (token.startsWith("--")) return parseError(`Unknown checkpoint flag: ${token}`, CHECKPOINT_USAGE);
		noteParts.push(token);
	}

	return { ok: true, intent: { kind: "checkpoint", options: { mode, note: noteParts.join(" "), consumeOnUse, raw, model, maxOutputTokens } } };
}

export function parseTrailWorkerShellCommand(command: string): Extract<TrailIntent, { kind: "worker-state" }> | undefined {
	const lines = command.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length !== 1) return undefined;
	const line = lines[0]!.trim();
	const match = line.match(/^\/?trail(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	const parsed = parseTrailCommand(match[1] ?? "");
	if (!parsed.ok || parsed.intent.kind !== "worker-state") return undefined;
	return parsed.intent;
}

export function parseTrailCommand(args: string): ParseResult {
	const tokenized = tokenize(args.trim());
	if (!tokenized.ok) return parseError(tokenized.message);
	const [command = "browse", ...rest] = tokenized.tokens;

	if (WORKER_SHORT.test(command) && rest.length === 0) return { ok: true, intent: { kind: "worker-result", worker: command, action: "show" } };
	if (command === "browse" || command === "review") return { ok: true, intent: { kind: "browse", mode: "review" } };
	if (command === "log") return { ok: true, intent: { kind: "browse", mode: "log" } };
	if (command === "help" || command === "--help" || command === "-h") {
		const advanced = rest.some((token) => token === "advanced" || token === "--advanced" || token === "all" || token === "--all");
		return { ok: true, intent: { kind: "help", ...(advanced ? { advanced: true } : {}) } };
	}
	if (command === "checkpoint" || command === "ckpt") return parseCheckpoint(rest);
	if (command === "continue" || command === "resume" || command === "r") return parseContinueCommand(rest);
	if (command === "delete") return parseDeleteCommand(rest);
	if (command === "list") {
		let includeConsumed = false;
		let workers = false;
		const extras: string[] = [];
		for (const token of rest) {
			if (token === "--include-consumed") includeConsumed = true;
			else if (token === "--workers") workers = true;
			else extras.push(token);
		}
		if (extras.length > 0) return parseError("Usage: /trail list [--include-consumed] [--workers]");
		return { ok: true, intent: { kind: "list", includeConsumed, workers } };
	}
	if (command === "load") {
		let includeConsumed = false;
		const positional: string[] = [];
		for (const token of rest) {
			if (token === "--include-consumed") includeConsumed = true;
			else positional.push(token);
		}
		if (positional.length > 1) return parseError("Usage: /trail load [id|last|w:<worker>] [--include-consumed]");
		const raw = positional[0];
		if (!raw) return { ok: true, intent: { kind: "load", ref: undefined, includeConsumed, refKind: "checkpoint" } };
		const { id, isWorker } = stripWorkerPrefix(raw);
		return { ok: true, intent: { kind: "load", ref: id, includeConsumed, refKind: isWorker ? "worker" : "checkpoint" } };
	}
	if (command === "unload") {
		if (rest.length !== 1) return parseError("Usage: /trail unload <id|w:<worker>|all>");
		const raw = rest[0]!;
		if (raw === "all") return { ok: true, intent: { kind: "unload", target: "all", targetKind: "all" } };
		const { id, isWorker } = stripWorkerPrefix(raw);
		return { ok: true, intent: { kind: "unload", target: id, targetKind: isWorker ? "worker" : "checkpoint" } };
	}
	if (command === "spawn") {
		let worktree = false;
		let fresh = false;
		const taskParts: string[] = [];
		for (const token of rest) {
			if (token === "--worktree" || token === "-w") worktree = true;
			else if (token === "--fresh") fresh = true;
			else taskParts.push(token);
		}
		if (taskParts.length === 0) return parseError("Usage: /trail spawn [--fresh] <task>");
		return { ok: true, intent: { kind: "spawn", task: taskParts.join(" "), ...(worktree ? { worktree } : {}), ...(fresh ? { fresh } : {}) } };
	}
	if (command === "workers") {
		if (rest.length > 0) return parseError("Usage: /trail workers");
		return { ok: true, intent: { kind: "workers" } };
	}
	if (command === "result" || command === "use") {
		if (rest.length !== 1) return parseError(`Usage: /trail ${command} w<N>`);
		const { id } = stripWorkerPrefix(rest[0]!);
		return { ok: true, intent: { kind: "worker-result", worker: id, action: command === "use" ? "use" : "show" } };
	}
	if (command === "ask" || command === "tell") {
		if (rest.length < 1) return parseError(`Usage: /trail ${command} w<N> [text]`);
		return { ok: true, intent: { kind: "tell", worker: rest[0]!, text: rest.length > 1 ? rest.slice(1).join(" ") : undefined } };
	}
	if (command === "wait") {
		if (rest.length === 0) return parseError("Usage: /trail wait <question>");
		return { ok: true, intent: { kind: "worker-state", state: "needs_input", text: rest.join(" ") } };
	}
	if (command === "done") {
		return { ok: true, intent: { kind: "worker-state", state: "ready", text: rest.length ? rest.join(" ") : undefined } };
	}
	if (command === "fail") {
		if (rest.length === 0) return parseError("Usage: /trail fail <reason>");
		return { ok: true, intent: { kind: "worker-state", state: "failed", text: rest.join(" ") } };
	}
	if (command === "answers") {
		return { ok: true, intent: { kind: "answers", query: rest.length ? rest.join(" ") : undefined } };
	}
	if (command === "clear") {
		if (rest.length > 0) return parseError("Usage: /trail clear");
		return { ok: true, intent: { kind: "clear" } };
	}
	if (command === "search" || command === "s") {
		if (rest.length === 0) return parseError(`Usage: /trail ${command} <query>`);
		return { ok: true, intent: { kind: "search", query: rest.join(" ") } };
	}
	if (command === "ref" || command === "inject" || command === "inject-full" || command === "copy") return requireArtifactArg(command, rest);
	return parseError(`Unknown Trail command: ${command}`);
}
