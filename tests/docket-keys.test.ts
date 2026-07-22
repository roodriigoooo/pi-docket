import test from "node:test";
import assert from "node:assert/strict";
import { navigatorKeyIntent, verdictOptionForDigit, verdictVerbs } from "../extensions/docket.js";

test("navigatorKeyIntent splits reply and save off the old c key", () => {
	assert.deepEqual(navigatorKeyIntent("r"), { kind: "runAction", action: "tellWorker" });
	assert.deepEqual(navigatorKeyIntent("b"), { kind: "save" });
});

test("navigatorKeyIntent keeps a as the single attach key and drops the duplicate aliases", () => {
	assert.deepEqual(navigatorKeyIntent("a"), { kind: "runAction", action: "attachReference" });
	// c (overloaded), t (tell alias), and i (attach alias) are all gone after the cleanup.
	assert.equal(navigatorKeyIntent("c"), undefined);
	assert.equal(navigatorKeyIntent("t"), undefined);
	assert.equal(navigatorKeyIntent("i"), undefined);
});

test("navigatorKeyIntent maps modes, movement, and core actions", () => {
	assert.deepEqual(navigatorKeyIntent("1"), { kind: "setMode", mode: "review" });
	assert.deepEqual(navigatorKeyIntent("2"), { kind: "setMode", mode: "answers" });
	assert.deepEqual(navigatorKeyIntent("3"), { kind: "setMode", mode: "log" });
	assert.deepEqual(navigatorKeyIntent("j"), { kind: "move", by: 1 });
	assert.deepEqual(navigatorKeyIntent("k"), { kind: "move", by: -1 });
	assert.deepEqual(navigatorKeyIntent("y"), { kind: "runAction", action: "copyArtifact" });
	assert.deepEqual(navigatorKeyIntent("P"), { kind: "runAction", action: "promoteWorker" });
	assert.deepEqual(navigatorKeyIntent("q"), { kind: "close" });
	assert.equal(navigatorKeyIntent("Z"), undefined);
});

test("verdictOptionForDigit reaches only the offered options, never destructive verbs", () => {
	const verbs = verdictVerbs("needs_input", false, ["Proceed as proposed", "Use migration-safe path"]);
	// verbs = [send, send, reject(Steer), rejectStop, chat]
	assert.equal(verdictOptionForDigit(verbs, "1")?.send, "Proceed as proposed");
	assert.equal(verdictOptionForDigit(verbs, "2")?.send, "Use migration-safe path");
	// 3 = Steer (reject), 4 = Reject & stop — not send verbs, so unreachable by number.
	assert.equal(verdictOptionForDigit(verbs, "3"), undefined);
	assert.equal(verdictOptionForDigit(verbs, "4"), undefined);
	assert.equal(verdictOptionForDigit(verbs, "9"), undefined);
	assert.equal(verdictOptionForDigit(verbs, "0"), undefined);
	assert.equal(verdictOptionForDigit(verbs, "x"), undefined);
});

test("verdictOptionForDigit returns nothing when there are no options", () => {
	const verbs = verdictVerbs("needs_input", false);
	assert.equal(verdictOptionForDigit(verbs, "1"), undefined);
});
