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
	| { kind: "help" }
	| { kind: "browse" }
	| { kind: "clear" }
	| { kind: "checkpoint"; options: CheckpointCreateOptions }
	| { kind: "continue"; idOrLast?: string }
	| { kind: "delete"; target: string | undefined; targetKind: "checkpoint" | "worker" }
	| { kind: "list"; includeConsumed?: boolean; workers?: boolean }
	| { kind: "load"; ref?: string; includeConsumed?: boolean; refKind: "checkpoint" | "worker" }
	| { kind: "unload"; target: string; targetKind: "checkpoint" | "worker" | "all" }
	| { kind: "spawn"; task: string }
	| { kind: "workers" }
	| { kind: "recall"; query?: string }
	| { kind: "search"; query: string }
	| { kind: "artifact"; action: "ref" | "inject" | "inject-full" | "copy"; idOrRef: string };

export type ParseResult =
	| { ok: true; intent: TrailIntent }
	| { ok: false; message: string; usage: string };

export const TRAIL_COMMANDS = ["recall", "search", "checkpoint", "continue", "resume", "load", "unload", "delete", "list", "spawn", "workers", "ref", "inject", "inject-full", "copy", "clear", "help"] as const;

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

export function trailUsage(): string {
	return [
		"Trail commands:",
		"/trail                         open working set",
		"/trail recall [query]          recall assistant/worker answers",
		"/trail search <query>          search ranked artifacts, then browse matches",
		CHECKPOINT_USAGE,
		"/trail continue [id|last]",
		"/trail resume [id|last]",
		"/trail spawn <task>            spawn a tmux pi worker to investigate <task>",
		"/trail workers                 open parallel-work artifact inbox",
		"/trail load [id|last|w<N>] [--include-consumed]   mount checkpoint or worker artifacts (no context bytes)",
		"/trail unload <id|w<N>|all>   drop a loaded slot from session",
		"/trail delete [id|last|w<N>]",
		"/trail list [--include-consumed] [--workers]",
		"/trail ref <artifact-id>       add compact ref chip (@id) above editor",
		"/trail inject <artifact-id>    alias for ref",
		"/trail inject-full <artifact-id>  add full chip (@id*) above editor",
		"/trail copy <artifact-id>      copy artifact to clipboard",
		"/trail clear                   drop all pending chips",
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

export function parseTrailCommand(args: string): ParseResult {
	const tokenized = tokenize(args.trim());
	if (!tokenized.ok) return parseError(tokenized.message);
	const [command = "browse", ...rest] = tokenized.tokens;

	if (command === "browse") return { ok: true, intent: { kind: "browse" } };
	if (command === "help" || command === "--help" || command === "-h") return { ok: true, intent: { kind: "help" } };
	if (command === "checkpoint") return parseCheckpoint(rest);
	if (command === "continue" || command === "resume") return parseContinueCommand(rest);
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
		if (rest.length === 0) return parseError("Usage: /trail spawn <task>");
		return { ok: true, intent: { kind: "spawn", task: rest.join(" ") } };
	}
	if (command === "workers") {
		if (rest.length > 0) return parseError("Usage: /trail workers");
		return { ok: true, intent: { kind: "workers" } };
	}
	if (command === "recall") {
		return { ok: true, intent: { kind: "recall", query: rest.length ? rest.join(" ") : undefined } };
	}
	if (command === "clear") {
		if (rest.length > 0) return parseError("Usage: /trail clear");
		return { ok: true, intent: { kind: "clear" } };
	}
	if (command === "search") {
		if (rest.length === 0) return parseError("Usage: /trail search <query>");
		return { ok: true, intent: { kind: "search", query: rest.join(" ") } };
	}
	if (command === "ref" || command === "inject" || command === "inject-full" || command === "copy") return requireArtifactArg(command, rest);
	return parseError(`Unknown Trail command: ${command}`);
}
