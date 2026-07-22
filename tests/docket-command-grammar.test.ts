import test from "node:test";
import assert from "node:assert/strict";
import { parseDocketCommand, parseDocketWorkerShellCommand, DOCKET_COMMANDS, docketUsage } from "../extensions/docket-command-grammar.js";

test("Docket grammar parses bundle and worker delete", () => {
	assert.deepEqual(parseDocketCommand("delete"), { ok: true, intent: { kind: "delete", target: undefined, targetKind: "checkpoint" } });
	assert.deepEqual(parseDocketCommand("delete last"), { ok: true, intent: { kind: "delete", target: "last", targetKind: "checkpoint" } });
	assert.deepEqual(parseDocketCommand("delete w:auth-bug-a3b1"), { ok: true, intent: { kind: "delete", target: "auth-bug-a3b1", targetKind: "worker" } });
	assert.deepEqual(parseDocketCommand("delete w3"), { ok: true, intent: { kind: "delete", target: "w3", targetKind: "worker" } });
	assert.deepEqual(parseDocketCommand("delete deliverable:parent-20260721-abc123:1"), { ok: true, intent: { kind: "delete", target: "deliverable:parent-20260721-abc123:1", targetKind: "deliverable" } });

	const invalid = parseDocketCommand("delete one two");
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.message, /Usage: \/docket delete \[id\|last\|w:<worker>\|deliverable/);
});

test("Docket grammar parses save", () => {
	assert.deepEqual(parseDocketCommand("save"), { ok: true, intent: { kind: "save" } });
	assert.deepEqual(parseDocketCommand("save --from w:auth-bug-a3b1"), { ok: true, intent: { kind: "save", source: { kind: "worker", ref: "auth-bug-a3b1" } } });
	assert.deepEqual(parseDocketCommand("save --from artifact:file-1"), { ok: true, intent: { kind: "save", source: { kind: "artifact", ref: "artifact:file-1" } } });
	for (const flag of ["--once", "--delete-on-use", "--summarize", "--model", "--max-output"]) {
		const removed = parseDocketCommand(`save ${flag}`);
		assert.equal(removed.ok, false);
		if (!removed.ok) assert.match(removed.message, new RegExp(`${flag} was removed`));
	}
	assert.equal(parseDocketCommand("checkpoint note").ok, false);
	assert.equal(parseDocketCommand("ckpt note").ok, false);
});

test("Docket grammar parses load and unload commands", () => {
	assert.deepEqual(parseDocketCommand("load"), { ok: true, intent: { kind: "load", ref: undefined, includeConsumed: false, refKind: "checkpoint" } });
	assert.deepEqual(parseDocketCommand("load last"), { ok: true, intent: { kind: "load", ref: "last", includeConsumed: false, refKind: "checkpoint" } });
	assert.deepEqual(parseDocketCommand("load ck-1 --include-consumed"), { ok: true, intent: { kind: "load", ref: "ck-1", includeConsumed: true, refKind: "checkpoint" } });
	assert.deepEqual(parseDocketCommand("load w1"), { ok: true, intent: { kind: "load", ref: "w1", includeConsumed: false, refKind: "worker" } });
	assert.deepEqual(parseDocketCommand("load w:auth-bug-a3b1"), { ok: true, intent: { kind: "load", ref: "auth-bug-a3b1", includeConsumed: false, refKind: "worker" } });
	assert.deepEqual(parseDocketCommand("load deliverable:parent-20260721-abc123:1"), { ok: true, intent: { kind: "load", ref: "deliverable:parent-20260721-abc123:1", includeConsumed: false, refKind: "deliverable" } });

	assert.deepEqual(parseDocketCommand("unload all"), { ok: true, intent: { kind: "unload", target: "all", targetKind: "all" } });
	assert.deepEqual(parseDocketCommand("unload ck-9"), { ok: true, intent: { kind: "unload", target: "ck-9", targetKind: "checkpoint" } });
	assert.deepEqual(parseDocketCommand("unload w12"), { ok: true, intent: { kind: "unload", target: "w12", targetKind: "worker" } });
	assert.deepEqual(parseDocketCommand("unload deliverable:parent-20260721-abc123:1"), { ok: true, intent: { kind: "unload", target: "deliverable:parent-20260721-abc123:1", targetKind: "deliverable" } });

	const invalid = parseDocketCommand("unload");
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.message, /Usage: \/docket unload/);
});

test("Docket grammar parses list with --include-consumed, --workers, and --all", () => {
	assert.deepEqual(parseDocketCommand("list"), { ok: true, intent: { kind: "list", includeConsumed: false, workers: false } });
	assert.deepEqual(parseDocketCommand("list --include-consumed"), { ok: true, intent: { kind: "list", includeConsumed: true, workers: false } });
	assert.deepEqual(parseDocketCommand("list --workers"), { ok: true, intent: { kind: "list", includeConsumed: false, workers: true } });
	assert.deepEqual(parseDocketCommand("list --all"), { ok: true, intent: { kind: "list", includeConsumed: false, workers: true, allProjects: true } });
});

test("Docket grammar parses spawn flags in either value form and order", () => {
	assert.deepEqual(parseDocketCommand("spawn investigate auth bug"), { ok: true, intent: { kind: "spawn", task: "investigate auth bug" } });
	assert.deepEqual(parseDocketCommand("spawn --worktree edit auth bug"), { ok: true, intent: { kind: "spawn", task: "edit auth bug", worktree: true } });
	assert.deepEqual(parseDocketCommand("spawn -w edit auth bug"), { ok: true, intent: { kind: "spawn", task: "edit auth bug", worktree: true } });
	assert.deepEqual(parseDocketCommand("spawn --model openai/gpt/review audit auth --thinking high"), {
		ok: true,
		intent: { kind: "spawn", task: "audit auth", model: "openai/gpt/review", thinking: "high" },
	});
	assert.deepEqual(parseDocketCommand("spawn task first --thinking=low --model=anthropic/claude"), {
		ok: true,
		intent: { kind: "spawn", task: "task first", model: "anthropic/claude", thinking: "low" },
	});
	assert.deepEqual(parseDocketCommand("spawn --thinking max deep audit"), {
		ok: true,
		intent: { kind: "spawn", task: "deep audit", thinking: "max" },
	});
	const invalid = parseDocketCommand("spawn");
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.usage, /\/docket spawn .* <task>/);
});

test("Docket grammar parses workers, kinds, and respawn", () => {
	assert.deepEqual(parseDocketCommand("workers"), { ok: true, intent: { kind: "workers" } });
	assert.deepEqual(parseDocketCommand("workers --all"), { ok: true, intent: { kind: "workers", allProjects: true } });
	assert.deepEqual(parseDocketCommand("kinds"), { ok: true, intent: { kind: "kinds" } });
	assert.deepEqual(parseDocketCommand("respawn w2"), { ok: true, intent: { kind: "respawn", target: "w2" } });
	assert.deepEqual(parseDocketCommand("respawn all"), { ok: true, intent: { kind: "respawn", target: "all" } });
	assert.ok(DOCKET_COMMANDS.includes("workers"));
	assert.match(docketUsage(true), /\/docket workers \[--all\]/);
});

test("Docket grammar parses spawn --as <kind>", () => {
	assert.deepEqual(parseDocketCommand("spawn --as scout grep for auth refs"), { ok: true, intent: { kind: "spawn", task: "grep for auth refs", as: "scout" } });
	assert.deepEqual(parseDocketCommand("spawn -a patcher edit foo.ts"), { ok: true, intent: { kind: "spawn", task: "edit foo.ts", as: "patcher" } });
	assert.deepEqual(parseDocketCommand("spawn --as=scout look around"), { ok: true, intent: { kind: "spawn", task: "look around", as: "scout" } });
	assert.equal(parseDocketCommand("spawn --as").ok, false);
});

test("Docket grammar parses context flags, quotes, and task delimiter", () => {
	assert.deepEqual(parseDocketCommand("spawn --seed inspect parent"), { ok: true, intent: { kind: "spawn", task: "inspect parent", seed: true } });
	assert.deepEqual(parseDocketCommand("spawn --fresh inspect parent"), { ok: true, intent: { kind: "spawn", task: "inspect parent", fresh: true } });
	assert.deepEqual(parseDocketCommand("spawn --model 'openai/gpt/review' \"audit auth flow\""), { ok: true, intent: { kind: "spawn", task: "audit auth flow", model: "openai/gpt/review" } });
	assert.deepEqual(parseDocketCommand("spawn --model openai/gpt -- --thinking turbo -x"), { ok: true, intent: { kind: "spawn", task: "--thinking turbo -x", model: "openai/gpt" } });
	assert.match(docketUsage(), /--model <provider\/model> --thinking <level>/);
});

test("Docket grammar rejects malformed spawn flags before task delimiter", () => {
	for (const input of ["spawn --model task", "spawn --thinking task", "spawn --as task"]) {
		const parsed = parseDocketCommand(input);
		assert.equal(parsed.ok, false, input);
	}
	const invalidThinking = parseDocketCommand("spawn --thinking turbo task");
	assert.equal(invalidThinking.ok, false);
	if (!invalidThinking.ok) assert.match(invalidThinking.message, /Invalid thinking level/);
	const unknown = parseDocketCommand("spawn --think high task");
	assert.equal(unknown.ok, false);
	if (!unknown.ok) assert.match(unknown.message, /Unknown spawn flag: --think/);
	assert.equal(parseDocketCommand("spawn -x task").ok, false);
	assert.equal(parseDocketCommand("spawn --model= task").ok, false);
	assert.equal(parseDocketCommand("spawn --thinking= task").ok, false);
});

test("Docket grammar parses worker tell, verdict, and protocol fallbacks", () => {
	assert.deepEqual(parseDocketCommand("tell w1 please include prompt chips"), { ok: true, intent: { kind: "tell", worker: "w1", text: "please include prompt chips" } });
	assert.deepEqual(parseDocketCommand("tell w1"), { ok: true, intent: { kind: "tell", worker: "w1", text: undefined } });
	assert.equal(parseDocketCommand("ask w1 nope").ok, false);
	assert.deepEqual(parseDocketCommand("verdict"), { ok: true, intent: { kind: "verdict" } });
	assert.deepEqual(parseDocketCommand("verdict w1"), { ok: true, intent: { kind: "verdict", worker: "w1" } });
	assert.equal(parseDocketCommand("v w1").ok, false);
	assert.deepEqual(parseDocketCommand("wait should I include bundles?"), { ok: true, intent: { kind: "worker-state", state: "needs_input", text: "should I include bundles?" } });
	assert.deepEqual(parseDocketCommand("done summary ready"), { ok: true, intent: { kind: "worker-state", state: "ready", text: "summary ready" } });
	assert.deepEqual(parseDocketCommand("done"), { ok: true, intent: { kind: "worker-state", state: "ready", text: undefined } });
	assert.deepEqual(parseDocketCommand("fail model timed out"), { ok: true, intent: { kind: "worker-state", state: "failed", text: "model timed out" } });
});

test("Docket grammar rejects removed aliases", () => {
	for (const input of ["w1", "result w1", "use w1", "review", "s worker auth plan", "r last", "resume last", "continue last", "inject a1"]) {
		assert.equal(parseDocketCommand(input).ok, false, input);
	}
	assert.equal(DOCKET_COMMANDS.includes("save"), true);
	assert.equal(DOCKET_COMMANDS.includes("checkpoint" as never), false);
	assert.equal(DOCKET_COMMANDS.includes("continue" as never), false);
	assert.equal(DOCKET_COMMANDS.includes("inject" as never), false);
});

test("Docket grammar recognizes accidental worker protocol in bash", () => {
	assert.deepEqual(parseDocketWorkerShellCommand("/docket wait should I include bundles?"), { kind: "worker-state", state: "needs_input", text: "should I include bundles?" });
	assert.deepEqual(parseDocketWorkerShellCommand("docket done summary ready"), { kind: "worker-state", state: "ready", text: "summary ready" });
	assert.deepEqual(parseDocketWorkerShellCommand("/docket fail model timed out"), { kind: "worker-state", state: "failed", text: "model timed out" });
	assert.equal(parseDocketWorkerShellCommand("/docket workers"), undefined);
	assert.equal(parseDocketWorkerShellCommand("/trail wait old command"), undefined);
	assert.equal(parseDocketWorkerShellCommand("echo before\n/docket wait hidden"), undefined);
});

test("Docket grammar parses answers, log, and search", () => {
	assert.deepEqual(parseDocketCommand(""), { ok: true, intent: { kind: "browse", mode: "review" } });
	assert.deepEqual(parseDocketCommand("log"), { ok: true, intent: { kind: "browse", mode: "log" } });
	assert.deepEqual(parseDocketCommand("answers"), { ok: true, intent: { kind: "answers", query: undefined } });
	assert.deepEqual(parseDocketCommand("answers worker auth plan"), { ok: true, intent: { kind: "answers", query: "worker auth plan" } });
	assert.deepEqual(parseDocketCommand("search worker auth plan"), { ok: true, intent: { kind: "search", query: "worker auth plan" } });
	assert.ok(DOCKET_COMMANDS.includes("answers"));
	assert.match(docketUsage(true), /\/docket answers \[query\]/);
});

test("Docket grammar parses the decisions lens via decisions and log decisions", () => {
	assert.deepEqual(parseDocketCommand("decisions"), { ok: true, intent: { kind: "decisions" } });
	assert.deepEqual(parseDocketCommand("log decisions"), { ok: true, intent: { kind: "decisions" } });
	assert.ok(DOCKET_COMMANDS.includes("decisions"));
	assert.match(docketUsage(true), /\/docket log decisions/);

	const badLog = parseDocketCommand("log bogus");
	assert.equal(badLog.ok, false);
	if (!badLog.ok) assert.match(badLog.message, /Usage: \/docket log \[decisions\]/);

	const badDecisions = parseDocketCommand("decisions extra");
	assert.equal(badDecisions.ok, false);
	if (!badDecisions.ok) assert.match(badDecisions.message, /Usage: \/docket decisions/);
});
