import test from "node:test";
import assert from "node:assert/strict";
import { isMultilineInput, normalizeMultilineInput, sanitizeSingleLineInput } from "../extensions/worker-store.js";

test("isMultilineInput detects real line breaks, not surrounding whitespace", () => {
	assert.equal(isMultilineInput("one line"), false);
	assert.equal(isMultilineInput("  padded one-liner  "), false);
	assert.equal(isMultilineInput("\n trailing-only newline trimmed away \n"), false);
	assert.equal(isMultilineInput("first\nsecond"), true);
	assert.equal(isMultilineInput("crlf\r\nsecond"), true);
});

test("sanitizeSingleLineInput collapses whitespace and trims", () => {
	assert.equal(sanitizeSingleLineInput("  hello   world  "), "hello world");
	assert.equal(sanitizeSingleLineInput("tabs\tand\tspaces"), "tabs and spaces");
	assert.equal(sanitizeSingleLineInput("   "), "");
});

test("normalizeMultilineInput keeps structure but tidies edges", () => {
	assert.equal(normalizeMultilineInput("line one\r\nline two"), "line one\nline two");
	assert.equal(normalizeMultilineInput("\n\nfirst\nsecond  \n\n"), "first\nsecond");
	assert.equal(normalizeMultilineInput("keep\n  indented body"), "keep\n  indented body");
});

test("the two paths agree that a normalized multiline payload still has newlines", () => {
	const payload = "step 1: do thing\nstep 2: do other thing";
	assert.equal(isMultilineInput(payload), true);
	assert.equal(normalizeMultilineInput(payload).includes("\n"), true);
	// and a flattened single-liner never sneaks a newline through
	assert.equal(sanitizeSingleLineInput("a b c").includes("\n"), false);
});
