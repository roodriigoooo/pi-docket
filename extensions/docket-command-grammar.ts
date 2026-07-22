import { isWorkerThinking, type WorkerThinking } from "./worker-spawn-policy.js";

export type DeliverableSaveSource = { kind: "worker" | "artifact"; ref: string };

export type DocketIntent =
	| { kind: "help"; advanced?: boolean }
	| { kind: "browse"; mode?: "review" | "answers" | "log" }
	| { kind: "decisions" }
	| { kind: "clear" }
	| { kind: "save"; source?: DeliverableSaveSource }
	| { kind: "delete"; target: string | undefined; targetKind: "deliverable" | "checkpoint" | "worker" }
	| { kind: "list"; includeConsumed?: boolean; workers?: boolean; allProjects?: boolean }
	| { kind: "load"; ref?: string; includeConsumed?: boolean; refKind: "deliverable" | "checkpoint" | "worker" }
	| { kind: "unload"; target: string; targetKind: "deliverable" | "checkpoint" | "worker" | "all" }
	| { kind: "spawn"; task: string; worktree?: boolean; fresh?: boolean; seed?: boolean; as?: string; model?: string; thinking?: WorkerThinking }
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

export const DOCKET_COMMANDS = ["answers", "attach", "clear", "copy", "decisions", "delete", "done", "fail", "help", "inject-full", "kinds", "list", "load", "log", "ref", "respawn", "save", "search", "spawn", "tell", "unload", "verdict", "wait", "workers"] as const;
export const DOCKET_SPAWN_FLAGS = ["--as", "--model", "--thinking", "--seed", "--fresh", "--worktree", "--"] as const;

const WORKER_PREFIX = "w:";
const WORKER_SHORT = /^w(\d+)$/i;

function stripWorkerPrefix(value: string): { id: string; isWorker: boolean } {
	if (value.startsWith(WORKER_PREFIX)) return { id: value.slice(WORKER_PREFIX.length), isWorker: true };
	if (WORKER_SHORT.test(value)) return { id: value, isWorker: true };
	return { id: value, isWorker: false };
}

const SAVE_USAGE = "/docket save [--from <artifact-ref|w<N>>]";
const SPAWN_USAGE = "/docket spawn [--model <provider/model>] [--thinking <level>] [--seed|--fresh] [--as <kind>] [--worktree] [--] <task>";

export function docketUsage(advanced = false): string {
	const primary = [
		"Docket · delegate safely without losing control:",
		"/docket                         open decision docket",
		"f8                              open worker progress lens",
		"/docket spawn [flags] <task>     start explicit background worker",
		"  flags: --model <provider/model> --thinking <level> --seed|--fresh --as <kind> --worktree",
		"  e.g. /docket spawn --as scout map auth call sites",
		"  e.g. /docket spawn --model anthropic/claude-sonnet-4-6 --thinking high audit auth",
		"/docket tell w<N> [text]        reply to a worker",
		"/docket save [--from ref|w<N>] save an immutable deliverable",
		"/docket load [ref|last|w<N>]     mount deliverable/legacy bundle without model tokens",
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
		"/docket log decisions           verdict ledger + workers evicted unreviewed",
		"/docket search <query>          ranked artifact search",
		"/docket workers [--all]         worker progress lens/dashboard",
		"/docket kinds                   list registered worker kinds",
		"/docket verdict [w<N>]          resolve the top worker decision (accept/reject/chat)",
		"/docket attach [parent|w<N>]    switch to parent/worker tmux when inside tmux; otherwise copy attach command",
		"/docket respawn <w<N>|all>      relaunch a worker whose tmux window died",
		SAVE_USAGE,
		"/docket load [ref|last|w<N>] [--include-consumed]   mount deliverable or legacy bundle (no model tokens)",
		"/docket unload <id|w<N>|all>    drop a loaded slot",
		"/docket delete [id|last|w<N>]",
		"/docket list [--include-consumed] [--workers|--all]",
		"/docket ref <artifact-id>       attach compact chip (@id) above editor",
		"/docket inject-full <artifact-id>  attach full chip (@id*) above editor",
		"/docket copy <artifact-id>      copy artifact to clipboard",
		"/docket clear                   drop all pending chips",
		"",
		"Docket · worker fallback (run inside a worker only):",
		"/docket wait <question>         ask parent for input and pause",
		"/docket done [summary]          mark output ready for review",
		"/docket fail <reason>           mark work failed",
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
	if (rest.length > 1) return parseError("Usage: /docket delete [id|last|w:<worker>|deliverable:<id>:<version>]");
	if (rest[0]!.startsWith("deliverable:")) return { ok: true, intent: { kind: "delete", target: rest[0], targetKind: "deliverable" } };
	const { id, isWorker } = stripWorkerPrefix(rest[0]!);
	return { ok: true, intent: { kind: "delete", target: id, targetKind: isWorker ? "worker" : "checkpoint" } };
}

function requireArtifactArg(action: "ref" | "inject-full" | "copy", rest: string[]): ParseResult {
	if (rest.length !== 1) return parseError(`Usage: /docket ${action} <artifact-id>`);
	return { ok: true, intent: { kind: "artifact", action, idOrRef: rest[0]! } };
}

function parseSave(tokens: string[]): ParseResult {
	let from: string | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--from") {
			const value = tokens[++i];
			if (!value || value.startsWith("-")) return parseError("Missing value for --from", SAVE_USAGE);
			from = value;
			continue;
		}
		if (token.startsWith("--from=")) {
			from = token.slice("--from=".length);
			if (!from) return parseError("Missing value for --from", SAVE_USAGE);
			continue;
		}
		const removedFlag = ["--once", "--delete-on-use", "--summarize", "--model", "--max-output"].find((flag) => token === flag || token.startsWith(`${flag}=`));
		if (removedFlag) {
			return parseError(`${removedFlag} was removed; save an approved worker with --from w<N> or author a deliverable interactively.`, SAVE_USAGE);
		}
		if (token.startsWith("--")) return parseError(`Unknown save flag: ${token}`, SAVE_USAGE);
		return parseError(`Unexpected save argument: ${token}`, SAVE_USAGE);
	}
	if (!from) return { ok: true, intent: { kind: "save" } };
	const isWorker = /^w\d+$/i.test(from) || from.startsWith("w:");
	return { ok: true, intent: { kind: "save", source: { kind: isWorker ? "worker" : "artifact", ref: from.startsWith("w:") ? from.slice(2) : from } } };
}

function parseSpawn(tokens: string[]): ParseResult {
	let worktree = false;
	let fresh = false;
	let seed = false;
	let as: string | undefined;
	let model: string | undefined;
	let thinking: WorkerThinking | undefined;
	const taskParts: string[] = [];

	const takeValue = (tokens: string[], index: number, flag: string): { value?: string; next: number; error?: ParseResult } => {
		const value = tokens[index + 1];
		if (!value || value.startsWith("-")) return { next: index, error: parseError(`Missing value for ${flag}`, SPAWN_USAGE) };
		return { value, next: index + 1 };
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--") {
			taskParts.push(...tokens.slice(i + 1));
			break;
		}
		if (token === "--worktree" || token === "-w") {
			worktree = true;
			continue;
		}
		if (token === "--fresh") {
			fresh = true;
			continue;
		}
		if (token === "--seed") {
			seed = true;
			continue;
		}
		if (token === "--as" || token === "-a" || token === "--model" || token === "--thinking") {
			const result = takeValue(tokens, i, token);
			if (result.error) return result.error;
			i = result.next;
			if (token === "--as" || token === "-a") as = result.value;
			else if (token === "--model") model = result.value;
			else if (isWorkerThinking(result.value)) thinking = result.value;
			else return parseError(`Invalid thinking level "${result.value}"`, SPAWN_USAGE);
			continue;
		}
		if (token.startsWith("--as=") || token.startsWith("--model=") || token.startsWith("--thinking=")) {
			const split = token.indexOf("=");
			const flag = token.slice(0, split);
			const value = token.slice(split + 1);
			if (!value) return parseError(`Missing value for ${flag}`, SPAWN_USAGE);
			if (flag === "--as") as = value;
			else if (flag === "--model") model = value;
			else if (isWorkerThinking(value)) thinking = value;
			else return parseError(`Invalid thinking level "${value}"`, SPAWN_USAGE);
			continue;
		}
		if (token.startsWith("-")) return parseError(`Unknown spawn flag: ${token}`, SPAWN_USAGE);
		taskParts.push(token);
	}

	if (taskParts.length === 0) return parseError("Missing spawn task", SPAWN_USAGE);
	return {
		ok: true,
		intent: {
			kind: "spawn",
			task: taskParts.join(" "),
			...(worktree ? { worktree } : {}),
			...(fresh ? { fresh } : {}),
			...(seed ? { seed } : {}),
			...(as ? { as } : {}),
			...(model ? { model } : {}),
			...(thinking ? { thinking } : {}),
		},
	};
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
	if (command === "log") {
		if (rest[0] === "decisions") return { ok: true, intent: { kind: "decisions" } };
		if (rest.length > 0) return parseError("Usage: /docket log [decisions]");
		return { ok: true, intent: { kind: "browse", mode: "log" } };
	}
	if (command === "decisions") {
		if (rest.length > 0) return parseError("Usage: /docket decisions");
		return { ok: true, intent: { kind: "decisions" } };
	}
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
		if (positional.length > 1) return parseError("Usage: /docket load [ref|last|w:<worker>] [--include-consumed]");
		const raw = positional[0];
		if (!raw) return { ok: true, intent: { kind: "load", ref: undefined, includeConsumed, refKind: "checkpoint" } };
		if (raw.startsWith("deliverable:")) return { ok: true, intent: { kind: "load", ref: raw, includeConsumed, refKind: "deliverable" } };
		const { id, isWorker } = stripWorkerPrefix(raw);
		return { ok: true, intent: { kind: "load", ref: id, includeConsumed, refKind: isWorker ? "worker" : "checkpoint" } };
	}
	if (command === "unload") {
		if (rest.length !== 1) return parseError("Usage: /docket unload <ref|w:<worker>|all>");
		const raw = rest[0]!;
		if (raw === "all") return { ok: true, intent: { kind: "unload", target: "all", targetKind: "all" } };
		if (raw.startsWith("deliverable:")) return { ok: true, intent: { kind: "unload", target: raw, targetKind: "deliverable" } };
		const { id, isWorker } = stripWorkerPrefix(raw);
		return { ok: true, intent: { kind: "unload", target: id, targetKind: isWorker ? "worker" : "checkpoint" } };
	}
	if (command === "spawn") return parseSpawn(rest);
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
		if (rest.length > 1) return parseError("Usage: /docket attach [parent|w<N>]");
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
