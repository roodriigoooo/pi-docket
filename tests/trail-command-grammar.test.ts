import test from "node:test";
import assert from "node:assert/strict";
import { parseTrailCommand, TRAIL_COMMANDS, trailUsage } from "../extensions/trail-command-grammar.js";

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
	assert.match(trailUsage(), /\/trail delete \[id\|last\|w<N>\]/);
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
	const invalid = parseTrailCommand("spawn");
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.message, /Usage: \/trail spawn <task>/);
});

test("Trail grammar parses workers dashboard", () => {
	assert.deepEqual(parseTrailCommand("workers"), { ok: true, intent: { kind: "workers" } });
	assert.ok(TRAIL_COMMANDS.includes("workers"));
	assert.match(trailUsage(), /\/trail workers/);
	const invalid = parseTrailCommand("workers extra");
	assert.equal(invalid.ok, false);
});

test("Trail grammar parses worker attention commands", () => {
	assert.deepEqual(parseTrailCommand("ask w1 please include prompt chips"), { ok: true, intent: { kind: "ask", worker: "w1", text: "please include prompt chips" } });
	assert.deepEqual(parseTrailCommand("wait should I include checkpoints?"), { ok: true, intent: { kind: "worker-state", state: "needs_input", text: "should I include checkpoints?" } });
	assert.deepEqual(parseTrailCommand("done summary ready"), { ok: true, intent: { kind: "worker-state", state: "ready", text: "summary ready" } });
	assert.deepEqual(parseTrailCommand("done"), { ok: true, intent: { kind: "worker-state", state: "ready", text: undefined } });
	assert.deepEqual(parseTrailCommand("fail model timed out"), { ok: true, intent: { kind: "worker-state", state: "failed", text: "model timed out" } });
	assert.ok(TRAIL_COMMANDS.includes("ask"));
	assert.match(trailUsage(), /\/trail ask w<N> <reply>/);
});

test("Trail grammar parses review, memory, and catalog", () => {
	assert.deepEqual(parseTrailCommand("review"), { ok: true, intent: { kind: "browse", mode: "work" } });
	assert.deepEqual(parseTrailCommand("catalog"), { ok: true, intent: { kind: "browse", mode: "all" } });
	assert.deepEqual(parseTrailCommand("memory"), { ok: true, intent: { kind: "recall", query: undefined } });
	assert.deepEqual(parseTrailCommand("memory worker auth plan"), { ok: true, intent: { kind: "recall", query: "worker auth plan" } });
	assert.deepEqual(parseTrailCommand("recall"), { ok: true, intent: { kind: "recall", query: undefined } });
	assert.ok(TRAIL_COMMANDS.includes("memory"));
	assert.match(trailUsage(), /\/trail memory \[query\]/);
});
