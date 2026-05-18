import test from "node:test";
import assert from "node:assert/strict";
import { isSharedSessionTarget, SHARED_TMUX_SESSION, workerWindowTarget } from "../extensions/worker-store.js";
import { buildAttachCommand } from "../extensions/trail-command-router.js";
import { parseTrailCommand, trailUsage } from "../extensions/trail-command-grammar.js";

test("workerWindowTarget formats as <session>:w<index>", () => {
	assert.equal(workerWindowTarget(1), `${SHARED_TMUX_SESSION}:w1`);
	assert.equal(workerWindowTarget(42), `${SHARED_TMUX_SESSION}:w42`);
});

test("isSharedSessionTarget detects shared-session targets", () => {
	assert.equal(isSharedSessionTarget(workerWindowTarget(3)), true);
	assert.equal(isSharedSessionTarget("trail-worker-foo"), false);
	assert.equal(isSharedSessionTarget(undefined), false);
});

test("buildAttachCommand emits select-window form for shared targets", () => {
	const target = workerWindowTarget(2);
	const cmd = buildAttachCommand(target);
	assert.match(cmd, new RegExp(`tmux attach -t ${SHARED_TMUX_SESSION}`));
	assert.match(cmd, /select-window -t w2/);
});

test("buildAttachCommand falls back to plain attach for legacy targets", () => {
	const cmd = buildAttachCommand("trail-worker-legacy");
	assert.equal(cmd, "tmux attach -t trail-worker-legacy");
});

test("parseTrailCommand recognizes attach with and without worker", () => {
	const bare = parseTrailCommand("attach");
	assert.equal(bare.ok, true);
	if (!bare.ok) return;
	assert.equal(bare.intent.kind, "attach");
	if (bare.intent.kind !== "attach") return;
	assert.equal(bare.intent.worker, undefined);

	const w = parseTrailCommand("attach w2");
	assert.equal(w.ok, true);
	if (!w.ok) return;
	assert.equal(w.intent.kind, "attach");
	if (w.intent.kind !== "attach") return;
	assert.equal(w.intent.worker, "w2");
});

test("trailUsage mentions attach in primary view", () => {
	assert.match(trailUsage(), /\/trail attach \[w<N>\]/);
});
