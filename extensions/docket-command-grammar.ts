export type CheckpointCreateOptions = {
	note: string;
	consumeOnUse: boolean;
	/** Opt-in: add a model-written prose summary on top of the deterministic bundle header. */
	summarize: boolean;
	model?: string;
	maxOutputTokens?: number;
};

export type DocketIntent =
	| { kind: "help"; advanced?: boolean }
	| { kind: "browse"; mode?: "review" | "answers" | "log" }
	| { kind: "clear" }
	| { kind: "save"; options: CheckpointCreateOptions }
	| { kind: "delete"; target: string | undefined; targetKind: "checkpoint" | "worker" }
	| { kind: "list"; includeConsumed?: boolean; workers?: boolean; allProjects?: boolean }
	| { kind: "load"; ref?: string; includeConsumed?: boolean; refKind: "checkpoint" | "worker" }
	| { kind: "unload"; target: string; targetKind: "checkpoint" | "worker" | "all" }
	| { kind: "spawn"; task: string; worktree?: boolean; fresh?: boolean; as?: string }
	| { kind: "kinds" }
	| { kind: "respawn"; target: string }
	| { kind: "workers"; allProjects?: boolean }
	| { kind: "verdict"; worker?: string }
	| { kind: "tell"; worker: string; text?: string }
	| { kind: "attach"; worker?: string }
	| { kind: "worker-state"; state: "needs_input" | "ready" | "failed"; text?: string }
	| { kind: "answers"; query?: string }
	| { kind: "search"; query: string }
	| { kind: "artifact"; action: "ref" | "inject-full" | "copy"; idOrRef: string };

export type ParseResult =
	| { ok: true; intent: DocketIntent }
	| { ok: false; message: string; usage: string };

export const DOCKET_COMMANDS = ["answers", "attach", "clear", "copy", "delete", "done", "fail", "help", "inject-full", "kinds", "list", "load", "log", "ref", "respawn", "save", "search", "spawn", "tell", "unload", "verdict", "wait", "workers"] as const;

const WORKER_PREFIX = "w:";
const WORKER_SHORT = /^w(\d+)$/i;

function stripWorkerPrefix(value: string): { id: string; isWorker: boolean } {
	if (value.startsWith(WORKER_PREFIX)) return { id: value.slice(WORKER_PREFIX.length), isWorker: true };
	if (WORKER_SHORT.test(value)) return { id: value, isWorker: true };
	return { id: value, isWorker: false };
}

const SAVE_USAGE = "/docket save [--once] [--summarize [--model <provider/model>] [--max-output <tokens>]] [--] [note]";
const BOOLEAN_FLAGS = new Set(["--once", "--delete-on-use", "--summarize"]);
const VALUE_FLAGS = new Set(["--model", "--max-output"]);

export function docketUsage(advanced = false): string {
	const primary = [
		"Docket · core loop:",
		"/docket                         open decision docket",
		"/docket spawn [--fresh] [--as <kind>] <task>  start explicit background worker",
		"/docket tell w<N> [text]        reply to a worker",
		"/docket attach [w<N>]           print/copy tmux attach command for the shared worker session",
		"/docket save [flags] [note]     save selected evidence as a zero-token bundle",
		"/docket load [id|last|w<N>]     mount bundle/worker artifacts without model tokens",
		"",
		"more: /docket help advanced",
	];
	if (!advanced) return primary.join("\n");
	return [
		...primary,
		"",
		"Docket · advanced:",
		"/docket answers [query]         browse assistant/worker answers",
		"/docket log                     audit timeline grouped by episode",
		"/docket search <query>          ranked artifact search",
		"/docket workers [--all]         worker dashboard",
		"/docket verdict [w<N>]          decide worker outcome (accept/reject/chat)",
		"/docket kinds                   list registered worker kinds",
		"/docket respawn <w<N>|all>      relaunch a worker whose tmux window died",
		SAVE_USAGE,
		"/docket load [id|last|w<N>] [--include-consumed]   mount bundle or worker artifacts (no model tokens)",
		"/docket unload <id|w<N>|all>    drop a loaded slot",
		"/docket delete [id|last|w<N>]",
		"/docket list [--include-consumed] [--workers|--all]",
		"/docket ref <artifact-id>       attach compact chip (@id) above editor",
		"/docket inject-full <artifact-id>  attach full chip (@id*) above editor",
		"/docket copy <artifact-id>      copy artifact to clipboard",
		"/docket clear                   drop all pending chips",
		"/docket wait <question>         worker fallback: ask parent for input",
		"/docket done [summary]          worker fallback: mark output ready",
		"/docket fail <reason>           worker fallback: mark work failed",
	].join("\n");
}

function parseError(message: string, usage = docketUsage()): ParseResult {
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

function parseDeleteCommand(rest: string[]): ParseResult {
	if (rest.length === 0) return { ok: true, intent: { kind: "delete", target: undefined, targetKind: "checkpoint" } };
	if (rest.length > 1) return parseError("Usage: /docket delete [id|last|w:<worker>]");
	const { id, isWorker } = stripWorkerPrefix(rest[0]!);
	return { ok: true, intent: { kind: "delete", target: id, targetKind: isWorker ? "worker" : "checkpoint" } };
}

function requireArtifactArg(action: "ref" | "inject-full" | "copy", rest: string[]): ParseResult {
	if (rest.length !== 1) return parseError(`Usage: /docket ${action} <artifact-id>`);
	return { ok: true, intent: { kind: "artifact", action, idOrRef: rest[0]! } };
}

function parseSave(tokens: string[]): ParseResult {
	let consumeOnUse = false;
	let summarize = false;
	let model: string | undefined;
	let maxOutputTokens: number | undefined;
	const noteParts: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--") {
			noteParts.push(...tokens.slice(i + 1));
			break;
		}
		if (BOOLEAN_FLAGS.has(token)) {
			if (token === "--once" || token === "--delete-on-use") consumeOnUse = true;
			else summarize = true;
			continue;
		}
		if (VALUE_FLAGS.has(token)) {
			const value = tokens[++i];
			if (!value) return parseError(`Missing value for ${token}`, SAVE_USAGE);
			if (token === "--model") model = value;
			else {
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed <= 0) return parseError("--max-output must be a positive integer", SAVE_USAGE);
				maxOutputTokens = parsed;
			}
			// --model/--max-output only make sense with a summary; imply it.
			summarize = true;
			continue;
		}
		if (token.startsWith("--")) return parseError(`Unknown save flag: ${token}`, SAVE_USAGE);
		noteParts.push(token);
	}

	return { ok: true, intent: { kind: "save", options: { note: noteParts.join(" "), consumeOnUse, summarize, model, maxOutputTokens } } };
}

export function parseDocketWorkerShellCommand(command: string): Extract<DocketIntent, { kind: "worker-state" }> | undefined {
	const lines = command.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length !== 1) return undefined;
	const line = lines[0]!.trim();
	const match = line.match(/^\/?docket(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	const parsed = parseDocketCommand(match[1] ?? "");
	if (!parsed.ok || parsed.intent.kind !== "worker-state") return undefined;
	return parsed.intent;
}

export function parseDocketCommand(args: string): ParseResult {
	const tokenized = tokenize(args.trim());
	if (!tokenized.ok) return parseError(tokenized.message);
	const [command = "", ...rest] = tokenized.tokens;

	if (command === "") return { ok: true, intent: { kind: "browse", mode: "review" } };
	if (command === "log") return { ok: true, intent: { kind: "browse", mode: "log" } };
	if (command === "help" || command === "--help" || command === "-h") {
		const advanced = rest.some((token) => token === "advanced" || token === "--advanced" || token === "all" || token === "--all");
		return { ok: true, intent: { kind: "help", ...(advanced ? { advanced: true } : {}) } };
	}
	if (command === "save") return parseSave(rest);
	if (command === "delete") return parseDeleteCommand(rest);
	if (command === "list") {
		let includeConsumed = false;
		let workers = false;
		let allProjects = false;
		const extras: string[] = [];
		for (const token of rest) {
			if (token === "--include-consumed") includeConsumed = true;
			else if (token === "--workers") workers = true;
			else if (token === "--all") { workers = true; allProjects = true; }
			else extras.push(token);
		}
		if (extras.length > 0) return parseError("Usage: /docket list [--include-consumed] [--workers|--all]");
		return { ok: true, intent: { kind: "list", includeConsumed, workers, ...(allProjects ? { allProjects } : {}) } };
	}
	if (command === "load") {
		let includeConsumed = false;
		const positional: string[] = [];
		for (const token of rest) {
			if (token === "--include-consumed") includeConsumed = true;
			else positional.push(token);
		}
		if (positional.length > 1) return parseError("Usage: /docket load [id|last|w:<worker>] [--include-consumed]");
		const raw = positional[0];
		if (!raw) return { ok: true, intent: { kind: "load", ref: undefined, includeConsumed, refKind: "checkpoint" } };
		const { id, isWorker } = stripWorkerPrefix(raw);
		return { ok: true, intent: { kind: "load", ref: id, includeConsumed, refKind: isWorker ? "worker" : "checkpoint" } };
	}
	if (command === "unload") {
		if (rest.length !== 1) return parseError("Usage: /docket unload <id|w:<worker>|all>");
		const raw = rest[0]!;
		if (raw === "all") return { ok: true, intent: { kind: "unload", target: "all", targetKind: "all" } };
		const { id, isWorker } = stripWorkerPrefix(raw);
		return { ok: true, intent: { kind: "unload", target: id, targetKind: isWorker ? "worker" : "checkpoint" } };
	}
	if (command === "spawn") {
		let worktree = false;
		let fresh = false;
		let as: string | undefined;
		const taskParts: string[] = [];
		for (let i = 0; i < rest.length; i++) {
			const token = rest[i]!;
			if (token === "--worktree" || token === "-w") worktree = true;
			else if (token === "--fresh") fresh = true;
			else if (token === "--as" || token === "-a") {
				const value = rest[++i];
				if (!value) return parseError("Usage: /docket spawn [--fresh] [--as <kind>] <task>");
				as = value;
			} else if (token.startsWith("--as=")) {
				as = token.slice("--as=".length);
			} else {
				taskParts.push(token);
			}
		}
		if (taskParts.length === 0) return parseError("Usage: /docket spawn [--fresh] [--as <kind>] <task>");
		return { ok: true, intent: { kind: "spawn", task: taskParts.join(" "), ...(worktree ? { worktree } : {}), ...(fresh ? { fresh } : {}), ...(as ? { as } : {}) } };
	}
	if (command === "workers") {
		let allProjects = false;
		const extras: string[] = [];
		for (const token of rest) {
			if (token === "--all") allProjects = true;
			else extras.push(token);
		}
		if (extras.length > 0) return parseError("Usage: /docket workers [--all]");
		return { ok: true, intent: { kind: "workers", ...(allProjects ? { allProjects } : {}) } };
	}
	if (command === "verdict") {
		if (rest.length > 1) return parseError("Usage: /docket verdict [w<N>]");
		return { ok: true, intent: { kind: "verdict", ...(rest[0] ? { worker: rest[0] } : {}) } };
	}
	if (command === "kinds") {
		if (rest.length > 0) return parseError("Usage: /docket kinds");
		return { ok: true, intent: { kind: "kinds" } };
	}
	if (command === "respawn") {
		if (rest.length !== 1) return parseError("Usage: /docket respawn <w<N>|all>");
		return { ok: true, intent: { kind: "respawn", target: rest[0]! } };
	}
	if (command === "tell") {
		if (rest.length < 1) return parseError("Usage: /docket tell w<N> [text]");
		return { ok: true, intent: { kind: "tell", worker: rest[0]!, text: rest.length > 1 ? rest.slice(1).join(" ") : undefined } };
	}
	if (command === "attach") {
		if (rest.length === 0) return { ok: true, intent: { kind: "attach" } };
		if (rest.length > 1) return parseError("Usage: /docket attach [w<N>]");
		return { ok: true, intent: { kind: "attach", worker: rest[0]! } };
	}
	if (command === "wait") {
		if (rest.length === 0) return parseError("Usage: /docket wait <question>");
		return { ok: true, intent: { kind: "worker-state", state: "needs_input", text: rest.join(" ") } };
	}
	if (command === "done") {
		return { ok: true, intent: { kind: "worker-state", state: "ready", text: rest.length ? rest.join(" ") : undefined } };
	}
	if (command === "fail") {
		if (rest.length === 0) return parseError("Usage: /docket fail <reason>");
		return { ok: true, intent: { kind: "worker-state", state: "failed", text: rest.join(" ") } };
	}
	if (command === "answers") {
		return { ok: true, intent: { kind: "answers", query: rest.length ? rest.join(" ") : undefined } };
	}
	if (command === "clear") {
		if (rest.length > 0) return parseError("Usage: /docket clear");
		return { ok: true, intent: { kind: "clear" } };
	}
	if (command === "search") {
		if (rest.length === 0) return parseError("Usage: /docket search <query>");
		return { ok: true, intent: { kind: "search", query: rest.join(" ") } };
	}
	if (command === "ref" || command === "inject-full" || command === "copy") return requireArtifactArg(command, rest);
	return parseError(`Unknown Docket command: ${command}`);
}
