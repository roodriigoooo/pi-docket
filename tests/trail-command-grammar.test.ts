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
