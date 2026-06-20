import test from "node:test";
import assert from "node:assert/strict";
import { parseDocketCommand, docketUsage } from "../extensions/docket-command-grammar.js";

test("docketUsage primary view exposes core commands and a hint", () => {
	const text = docketUsage();
	for (const cmd of ["/docket ", "ctrl+shift+d", "/docket spawn", "/docket tell w<N>", "/docket save", "/docket load"]) {
		assert.equal(text.includes(cmd), true, `missing ${cmd}`);
	}
	assert.match(text, /more: \/docket help advanced/);
	assert.equal(text.includes("/docket checkpoint"), false);
	assert.equal(text.includes("/docket continue"), false);
	assert.equal(text.includes("/docket verdict"), false);
	assert.equal(text.includes("/docket attach"), false);
	assert.equal(text.includes("/docket ref"), false);
	assert.equal(text.includes("/docket search"), false);
});

test("docketUsage advanced view includes secondary commands", () => {
	const text = docketUsage(true);
	for (const cmd of ["/docket search", "/docket ref", "/docket workers", "/docket answers", "/docket log", "/docket verdict", "/docket attach"]) {
		assert.equal(text.includes(cmd), true, `missing ${cmd}`);
	}
	assert.equal(text.includes("alias"), false);
});

test("parseDocketCommand recognizes 'help advanced'", () => {
	const parsed = parseDocketCommand("help advanced");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.intent.kind, "help");
	assert.equal(parsed.intent.kind === "help" && parsed.intent.advanced, true);
});

test("parseDocketCommand recognizes plain 'help'", () => {
	const parsed = parseDocketCommand("help");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.intent.kind, "help");
	assert.equal(parsed.intent.kind === "help" && parsed.intent.advanced, undefined);
});

test("parseDocketCommand parses spawn --fresh", () => {
	const parsed = parseDocketCommand("spawn --fresh investigate auth bug");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.intent.kind, "spawn");
	if (parsed.intent.kind !== "spawn") return;
	assert.equal(parsed.intent.task, "investigate auth bug");
	assert.equal(parsed.intent.fresh, true);
});
