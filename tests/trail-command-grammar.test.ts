import test from "node:test";
import assert from "node:assert/strict";
import { parseTrailCommand, parseTrailWorkerShellCommand, TRAIL_COMMANDS, trailUsage } from "../extensions/trail-command-grammar.js";

test("Trail grammar parses checkpoint delete commands", () => {
	assert.deepEqual(parseTrailCommand("delete"), { ok: true, intent: { kind: "delete", target: undefined, targetKind: "checkpoint" } });
	assert.deepEqual(parseTrailCommand("delete last"), { ok: true, intent: { kind: "delete", target: "last", targetKind: "checkpoint" } });
	assert.deepEqual(parseTrailCommand("delete ck-123"), { ok: true, intent: { kind: "delete", target: "ck-123", targetKind: "checkpoint" } });

	const invalid = parseTrailCommand("delete one two");
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.message, /Usage: \/trail delete \[id\|last\|w:<worker>\]/);
});

test("Trail grammar parses worker delete via w: prefix", () => {
	assert.deepEqual(parseTrailCommand("delete w:auth-bug-a3b1"), { ok: true, intent: { kind: "delete", target: "auth-bug-a3b1", targetKind: "worker" } });
});

test("Trail grammar parses bare wN as worker reference", () => {
	assert.deepEqual(parseTrailCommand("load w1"), { ok: true, intent: { kind: "load", ref: "w1", includeConsumed: false, refKind: "worker" } });
	assert.deepEqual(parseTrailCommand("unload w12"), { ok: true, intent: { kind: "unload", target: "w12", targetKind: "worker" } });
	assert.deepEqual(parseTrailCommand("delete w3"), { ok: true, intent: { kind: "delete", target: "w3", targetKind: "worker" } });
});

test("Trail grammar advertises checkpoint and worker delete", () => {
	assert.ok(TRAIL_COMMANDS.includes("delete"));
	assert.ok(TRAIL_COMMANDS.includes("spawn"));
	assert.match(trailUsage(true), /\/trail delete \[id\|last\|w<N>\]/);
});

test("Trail grammar parses load and unload commands", () => {
	assert.deepEqual(parseTrailCommand("load"), { ok: true, intent: { kind: "load", ref: undefined, includeConsumed: false, refKind: "checkpoint" } });
	assert.deepEqual(parseTrailCommand("load last"), { ok: true, intent: { kind: "load", ref: "last", includeConsumed: false, refKind: "checkpoint" } });
	assert.deepEqual(parseTrailCommand("load ck-1 --include-consumed"), { ok: true, intent: { kind: "load", ref: "ck-1", includeConsumed: true, refKind: "checkpoint" } });
	assert.deepEqual(parseTrailCommand("load w:auth-bug-a3b1"), { ok: true, intent: { kind: "load", ref: "auth-bug-a3b1", includeConsumed: false, refKind: "worker" } });

	assert.deepEqual(parseTrailCommand("unload all"), { ok: true, intent: { kind: "unload", target: "all", targetKind: "all" } });
	assert.deepEqual(parseTrailCommand("unload ck-9"), { ok: true, intent: { kind: "unload", target: "ck-9", targetKind: "checkpoint" } });
	assert.deepEqual(parseTrailCommand("unload w:auth-bug-a3b1"), { ok: true, intent: { kind: "unload", target: "auth-bug-a3b1", targetKind: "worker" } });

	const invalid = parseTrailCommand("unload");
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.message, /Usage: \/trail unload/);
});

test("Trail grammar parses list with --include-consumed and --workers", () => {
	assert.deepEqual(parseTrailCommand("list"), { ok: true, intent: { kind: "list", includeConsumed: false, workers: false } });
	assert.deepEqual(parseTrailCommand("list --include-consumed"), { ok: true, intent: { kind: "list", includeConsumed: true, workers: false } });
	assert.deepEqual(parseTrailCommand("list --workers"), { ok: true, intent: { kind: "list", includeConsumed: false, workers: true } });
});

test("Trail grammar parses spawn", () => {
	assert.deepEqual(parseTrailCommand("spawn investigate auth bug"), { ok: true, intent: { kind: "spawn", task: "investigate auth bug" } });
	assert.deepEqual(parseTrailCommand("spawn --worktree edit auth bug"), { ok: true, intent: { kind: "spawn", task: "edit auth bug", worktree: true } });
	assert.deepEqual(parseTrailCommand("spawn -w edit auth bug"), { ok: true, intent: { kind: "spawn", task: "edit auth bug", worktree: true } });
	const invalid = parseTrailCommand("spawn");
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.message, /Usage: \/trail spawn .* <task>/);
});

test("Trail grammar parses workers dashboard", () => {
	assert.deepEqual(parseTrailCommand("workers"), { ok: true, intent: { kind: "workers" } });
	assert.ok(TRAIL_COMMANDS.includes("workers"));
	assert.match(trailUsage(true), /\/trail workers/);
	const invalid = parseTrailCommand("workers extra");
	assert.equal(invalid.ok, false);
});

test("Trail grammar parses spawn --as <kind>", () => {
	assert.deepEqual(parseTrailCommand("spawn --as scout grep for auth refs"), { ok: true, intent: { kind: "spawn", task: "grep for auth refs", as: "scout" } });
	assert.deepEqual(parseTrailCommand("spawn -a patcher edit foo.ts"), { ok: true, intent: { kind: "spawn", task: "edit foo.ts", as: "patcher" } });
	assert.deepEqual(parseTrailCommand("spawn --as=scout look around"), { ok: true, intent: { kind: "spawn", task: "look around", as: "scout" } });
	const missing = parseTrailCommand("spawn --as");
	assert.equal(missing.ok, false);
});

test("Trail grammar parses kinds + respawn", () => {
	assert.deepEqual(parseTrailCommand("kinds"), { ok: true, intent: { kind: "kinds" } });
	assert.deepEqual(parseTrailCommand("respawn w2"), { ok: true, intent: { kind: "respawn", target: "w2" } });
	assert.deepEqual(parseTrailCommand("respawn all"), { ok: true, intent: { kind: "respawn", target: "all" } });
	const invalid = parseTrailCommand("respawn");
	assert.equal(invalid.ok, false);
});

test("Trail grammar parses worker tell and attention commands", () => {
	assert.deepEqual(parseTrailCommand("tell w1 please include prompt chips"), { ok: true, intent: { kind: "tell", worker: "w1", text: "please include prompt chips" } });
	assert.deepEqual(parseTrailCommand("tell w1"), { ok: true, intent: { kind: "tell", worker: "w1", text: undefined } });
	assert.deepEqual(parseTrailCommand("ask w1 nope"), { ok: true, intent: { kind: "tell", worker: "w1", text: "nope" } });
	assert.deepEqual(parseTrailCommand("wait should I include checkpoints?"), { ok: true, intent: { kind: "worker-state", state: "needs_input", text: "should I include checkpoints?" } });
	assert.deepEqual(parseTrailCommand("done summary ready"), { ok: true, intent: { kind: "worker-state", state: "ready", text: "summary ready" } });
	assert.deepEqual(parseTrailCommand("done"), { ok: true, intent: { kind: "worker-state", state: "ready", text: undefined } });
	assert.deepEqual(parseTrailCommand("fail model timed out"), { ok: true, intent: { kind: "worker-state", state: "failed", text: "model timed out" } });
	assert.ok(TRAIL_COMMANDS.includes("tell"));
	assert.match(trailUsage(), /\/trail tell w<N> \[text\]/);
	assert.match(trailUsage(true), /\/trail tell w<N> \[text\]/);
	assert.equal(parseTrailCommand("reply w1 nope").ok, false);
});

test("Trail grammar parses worker result commands", () => {
	assert.deepEqual(parseTrailCommand("w1"), { ok: true, intent: { kind: "worker-result", worker: "w1", action: "show" } });
	assert.deepEqual(parseTrailCommand("result w1"), { ok: true, intent: { kind: "worker-result", worker: "w1", action: "show" } });
	assert.deepEqual(parseTrailCommand("use w:auth-bug-a3b1"), { ok: true, intent: { kind: "worker-result", worker: "auth-bug-a3b1", action: "use" } });
	assert.ok(TRAIL_COMMANDS.includes("result"));
	assert.ok(TRAIL_COMMANDS.includes("use"));
	assert.match(trailUsage(true), /\/trail use w<N>/);
});

test("Trail grammar recognizes accidental worker protocol in bash", () => {
	assert.deepEqual(parseTrailWorkerShellCommand("/trail wait should I include checkpoints?"), { kind: "worker-state", state: "needs_input", text: "should I include checkpoints?" });
	assert.deepEqual(parseTrailWorkerShellCommand("trail done summary ready"), { kind: "worker-state", state: "ready", text: "summary ready" });
	assert.deepEqual(parseTrailWorkerShellCommand("/trail fail model timed out"), { kind: "worker-state", state: "failed", text: "model timed out" });
	assert.equal(parseTrailWorkerShellCommand("/trail workers"), undefined);
	assert.equal(parseTrailWorkerShellCommand("echo before\n/trail wait hidden"), undefined);
});

test("Trail grammar parses answers, log, and remaining short aliases", () => {
	assert.deepEqual(parseTrailCommand("review"), { ok: true, intent: { kind: "browse", mode: "review" } });
	assert.deepEqual(parseTrailCommand("log"), { ok: true, intent: { kind: "browse", mode: "log" } });
	assert.equal(parseTrailCommand("all").ok, false);
	assert.deepEqual(parseTrailCommand("answers"), { ok: true, intent: { kind: "answers", query: undefined } });
	assert.deepEqual(parseTrailCommand("answers worker auth plan"), { ok: true, intent: { kind: "answers", query: "worker auth plan" } });
	assert.deepEqual(parseTrailCommand("s worker auth plan"), { ok: true, intent: { kind: "search", query: "worker auth plan" } });
	assert.deepEqual(parseTrailCommand("ckpt --raw note"), { ok: true, intent: { kind: "checkpoint", options: { mode: "handoff", note: "note", consumeOnUse: false, raw: true, model: undefined, maxOutputTokens: undefined } } });
	assert.deepEqual(parseTrailCommand("r last"), { ok: true, intent: { kind: "continue", idOrLast: "last" } });
	assert.equal(parseTrailCommand("memory").ok, false);
	assert.equal(parseTrailCommand("m worker auth plan").ok, false);
	assert.equal(parseTrailCommand("catalog").ok, false);
	assert.equal(parseTrailCommand("cat").ok, false);
	assert.ok(TRAIL_COMMANDS.includes("answers"));
	assert.match(trailUsage(true), /\/trail answers \[query\]/);
});
