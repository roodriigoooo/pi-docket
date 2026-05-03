import test from "node:test";
import assert from "node:assert/strict";
import { parseTrailCommand, TRAIL_COMMANDS, trailUsage } from "../extensions/trail-command-grammar.js";

test("Trail grammar parses checkpoint delete commands", () => {
	assert.deepEqual(parseTrailCommand("delete"), { ok: true, intent: { kind: "delete" } });
	assert.deepEqual(parseTrailCommand("delete last"), { ok: true, intent: { kind: "delete", idOrLast: "last" } });
	assert.deepEqual(parseTrailCommand("delete ck-123"), { ok: true, intent: { kind: "delete", idOrLast: "ck-123" } });

	const invalid = parseTrailCommand("delete one two");
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.message, /Usage: \/trail delete \[id\|last\]/);
});

test("Trail grammar advertises checkpoint delete", () => {
	assert.ok(TRAIL_COMMANDS.includes("delete"));
	assert.match(trailUsage(), /\/trail delete \[id\|last\]/);
});

test("Trail grammar parses load and unload commands", () => {
	assert.deepEqual(parseTrailCommand("load"), { ok: true, intent: { kind: "load", idOrLast: undefined, includeConsumed: false } });
	assert.deepEqual(parseTrailCommand("load last"), { ok: true, intent: { kind: "load", idOrLast: "last", includeConsumed: false } });
	assert.deepEqual(parseTrailCommand("load ck-1 --include-consumed"), { ok: true, intent: { kind: "load", idOrLast: "ck-1", includeConsumed: true } });
	assert.deepEqual(parseTrailCommand("unload all"), { ok: true, intent: { kind: "unload", idOrAll: "all" } });
	assert.deepEqual(parseTrailCommand("unload ck-9"), { ok: true, intent: { kind: "unload", idOrAll: "ck-9" } });

	const invalid = parseTrailCommand("unload");
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.message, /Usage: \/trail unload <id\|all>/);
});

test("Trail grammar parses list with --include-consumed", () => {
	assert.deepEqual(parseTrailCommand("list"), { ok: true, intent: { kind: "list", includeConsumed: false } });
	assert.deepEqual(parseTrailCommand("list --include-consumed"), { ok: true, intent: { kind: "list", includeConsumed: true } });
});
