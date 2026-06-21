import test from "node:test";
import assert from "node:assert/strict";
import { isSharedSessionTarget, SHARED_TMUX_SESSION, workerWindowTarget } from "../extensions/worker-store.js";
import { buildAttachCommand, buildTmuxNavigation } from "../extensions/docket-command-router.js";
import { parseDocketCommand, docketUsage } from "../extensions/docket-command-grammar.js";

test("workerWindowTarget formats as <session>:w<index>", () => {
	assert.equal(workerWindowTarget(1), `${SHARED_TMUX_SESSION}:w1`);
	assert.equal(workerWindowTarget(42), `${SHARED_TMUX_SESSION}:w42`);
});

test("isSharedSessionTarget detects shared-session targets", () => {
	assert.equal(isSharedSessionTarget(workerWindowTarget(3)), true);
	assert.equal(isSharedSessionTarget("docket-worker-foo"), false);
	assert.equal(isSharedSessionTarget(undefined), false);
});

test("buildAttachCommand emits select-window form for shared targets", () => {
	const target = workerWindowTarget(2);
	const cmd = buildAttachCommand(target, { insideTmux: false });
	assert.match(cmd, new RegExp(`tmux attach -t ${SHARED_TMUX_SESSION}`));
	assert.match(cmd, /select-window -t w2/);
});

test("buildAttachCommand falls back to plain attach for legacy targets", () => {
	const cmd = buildAttachCommand("docket-worker-legacy", { insideTmux: false });
	assert.equal(cmd, "tmux attach -t docket-worker-legacy");
});

test("parseDocketCommand recognizes attach with and without worker", () => {
	const bare = parseDocketCommand("attach");
	assert.equal(bare.ok, true);
	if (!bare.ok) return;
	assert.equal(bare.intent.kind, "attach");
	if (bare.intent.kind !== "attach") return;
	assert.equal(bare.intent.worker, undefined);

	const w = parseDocketCommand("attach w2");
	assert.equal(w.ok, true);
	if (!w.ok) return;
	assert.equal(w.intent.kind, "attach");
	if (w.intent.kind !== "attach") return;
	assert.equal(w.intent.worker, "w2");
});

test("buildTmuxNavigation switches clients when already inside tmux", () => {
	const nav = buildTmuxNavigation(workerWindowTarget(2), { insideTmux: true });
	assert.equal(nav.mode, "switch");
	assert.equal(nav.command, `tmux switch-client -t ${SHARED_TMUX_SESSION}:w2`);
	assert.deepEqual(nav.args, ["switch-client", "-t", `${SHARED_TMUX_SESSION}:w2`]);
});

test("buildTmuxNavigation switches to shared session without worker", () => {
	const nav = buildTmuxNavigation(`${SHARED_TMUX_SESSION}:`, { insideTmux: true });
	assert.equal(nav.command, `tmux switch-client -t ${SHARED_TMUX_SESSION}`);
});

test("docketUsage keeps attach in advanced view", () => {
	assert.doesNotMatch(docketUsage(), /\/docket attach \[w<N>\]/);
	assert.match(docketUsage(true), /\/docket attach \[w<N>\]/);
});
