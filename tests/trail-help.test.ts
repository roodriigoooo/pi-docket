import test from "node:test";
import assert from "node:assert/strict";
import { parseTrailCommand, trailUsage } from "../extensions/trail-command-grammar.js";

test("trailUsage primary view exposes the 6 core commands and a hint", () => {
	const text = trailUsage();
	for (const cmd of ["/trail ", "/trail spawn", "/trail tell w<N>", "/trail w<N>", "/trail checkpoint", "/trail continue"]) {
		assert.equal(text.includes(cmd), true, `missing ${cmd}`);
	}
	assert.match(text, /more: \/trail help advanced/);
	assert.equal(text.includes("/trail load"), false);
	assert.equal(text.includes("/trail ref"), false);
	assert.equal(text.includes("/trail search"), false);
});

test("trailUsage advanced view includes secondary commands", () => {
	const text = trailUsage(true);
	for (const cmd of ["/trail search", "/trail load", "/trail ref", "/trail workers", "/trail answers", "/trail log"]) {
		assert.equal(text.includes(cmd), true, `missing ${cmd}`);
	}
});

test("parseTrailCommand recognizes 'help advanced'", () => {
	const parsed = parseTrailCommand("help advanced");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.intent.kind, "help");
	assert.equal(parsed.intent.kind === "help" && parsed.intent.advanced, true);
});

test("parseTrailCommand recognizes plain 'help'", () => {
	const parsed = parseTrailCommand("help");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.intent.kind, "help");
	assert.equal(parsed.intent.kind === "help" && parsed.intent.advanced, undefined);
});

test("parseTrailCommand parses spawn --fresh", () => {
	const parsed = parseTrailCommand("spawn --fresh investigate auth bug");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.intent.kind, "spawn");
	if (parsed.intent.kind !== "spawn") return;
	assert.equal(parsed.intent.task, "investigate auth bug");
	assert.equal(parsed.intent.fresh, true);
});
