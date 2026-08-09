import test from "node:test";
import assert from "node:assert/strict";
import { browserCardButtons } from "../extensions/docket.js";
import { createPickerKeymap, createScrollingKeymap, createVerdictKeymap, createWorkerDashboardKeymap, defineKeymap, formatKeyHints } from "../extensions/docket-keymap.js";
import type { ReviewItem } from "../extensions/docket-navigator.js";

test("defineKeymap rejects duplicate canonical keys assigned to different actions", () => {
	assert.throws(
		() => defineKeymap("conflict", [
			{ keys: "Escape", action: "close", label: "close" },
			{ keys: "\u001b", action: "cancel", label: "cancel" },
		]),
		/Docket keymap "conflict" assigns "escape"/,
	);
});

test("defineKeymap resolves aliases but permits them for one action", () => {
	const keymap = defineKeymap("aliases", [{ keys: ["q", "Escape", "\u001b"], action: "close", label: "close", slots: ["footer"] }]);

	assert.equal(keymap.resolve("q"), "close");
	assert.equal(keymap.resolve("\u001b"), "close");
	assert.equal(keymap.resolve("unknown"), undefined);
	assert.equal(formatKeyHints(keymap, "footer"), "q/Esc/Esc close");
});

test("raw arrow sequences reach the same actions as their vim aliases", () => {
	// Terminals send bytes, not key names. The card advertises "j/down"; pressing Down must work.
	for (const keymap of [createScrollingKeymap(), createWorkerDashboardKeymap(), createPickerKeymap({ mode: "load" }), createVerdictKeymap({ hasChangeSet: false, optionCount: 0 })]) {
		assert.equal(keymap.resolve("\u001b[B"), keymap.resolve("j"), `${keymap.name}: CSI down`);
		assert.equal(keymap.resolve("\u001b[A"), keymap.resolve("k"), `${keymap.name}: CSI up`);
		// Application-cursor mode (keypad) sends SS3 instead of CSI for the same physical key.
		assert.equal(keymap.resolve("\u001bOB"), keymap.resolve("j"), `${keymap.name}: SS3 down`);
		assert.equal(keymap.resolve("\u001bOA"), keymap.resolve("k"), `${keymap.name}: SS3 up`);
	}
});

test("scrolling viewer resolves the full navigation set from raw sequences", () => {
	const keymap = createScrollingKeymap();

	assert.equal(keymap.resolve("\u001b[C"), "right");
	assert.equal(keymap.resolve("\u001b[D"), "left");
	assert.equal(keymap.resolve("\u001bOD"), "left");
	assert.equal(keymap.resolve("\u001b[5~"), "pageUp");
	assert.equal(keymap.resolve("\u001b[6~"), "pageDown");
});

test("worker dashboard keeps progress, reply, and hint bindings aligned", () => {
	const keymap = createWorkerDashboardKeymap();

	assert.equal(keymap.resolve("t"), "progress");
	assert.equal(keymap.resolve("r"), "tell");
	assert.equal(keymap.resolve("c"), undefined);
	assert.equal(keymap.resolve("\r"), "open");
	assert.equal(keymap.resolve("a"), "attach");
	assert.match(formatKeyHints(keymap, "footer"), /r tell/);
	assert.doesNotMatch(formatKeyHints(keymap, "footer"), /attach/);
	assert.match(formatKeyHints(keymap, "help"), /direct tmux control/);
});

test("picker only advertises available switch and preview actions", () => {
	const fixed = createPickerKeymap({ mode: "load", canSwitch: false, canPreview: false });
	const selectable = createPickerKeymap({ mode: "load", canSwitch: true, canPreview: true });

	assert.equal(fixed.resolve("\t"), undefined);
	assert.equal(fixed.resolve("p"), undefined);
	assert.doesNotMatch(formatKeyHints(fixed, "footer"), /switch|preview/);
	assert.equal(selectable.resolve("\t"), "switch");
	assert.equal(selectable.resolve("p"), "preview");
});

test("shared scrolling grammar resolves every visible footer binding", () => {
	const keymap = createScrollingKeymap();
	for (const hint of keymap.hints("footer")) {
		for (const key of hint.keys) assert.equal(keymap.resolve(key), hint.action);
	}
	assert.equal(keymap.resolve("d"), "pageDown");
	assert.equal(keymap.resolve("u"), "pageUp");
});

test("browser card calls d Review diff only for diff-like artifacts", () => {
	const item = (meta: Record<string, unknown>): ReviewItem => ({
		artifact: { id: "a", displayId: "a", ref: "a", kind: "file", title: "a.ts", subtitle: "", body: "", timestamp: 0, meta },
		primaryAction: "copyArtifact",
		actions: ["copyArtifact", "inspect"],
		headline: "a.ts",
		recommendations: [],
		provenance: "current",
	});

	assert.deepEqual(browserCardButtons(item({ diff: "@@ -1 +1 @@" }), false).find((button) => button.key === "d"), { key: "d", label: "Review diff" });
	assert.deepEqual(browserCardButtons(item({}), false).find((button) => button.key === "d"), { key: "d", label: "Inspect" });
});

test("verdict hints contain only contextually active review actions", () => {
	const noChangeSet = createVerdictKeymap({ hasChangeSet: false, optionCount: 0 });
	const withChangeSet = createVerdictKeymap({ hasChangeSet: true, optionCount: 2 });
	const readyReport = createVerdictKeymap({ hasChangeSet: false, optionCount: 0, canReport: true });

	assert.equal(noChangeSet.resolve("d"), undefined);
	assert.equal(noChangeSet.resolve("1"), undefined);
	assert.equal(noChangeSet.resolve("r"), undefined);
	assert.equal(withChangeSet.resolve("d"), "diff");
	assert.equal(withChangeSet.resolve("2"), "option2");
	assert.equal(readyReport.resolve("r"), "report");
	assert.match(formatKeyHints(readyReport, "footer"), /r Report/);
});

test("the overlap key appears only when another worker is contesting these lines", () => {
	const alone = createVerdictKeymap({ hasChangeSet: true, optionCount: 0 });
	const contested = createVerdictKeymap({ hasChangeSet: true, optionCount: 0, hasOverlap: true });
	// A worker with no diff cannot contest lines, so the key stays away even if something claims otherwise.
	const noChangeSet = createVerdictKeymap({ hasChangeSet: false, optionCount: 0, hasOverlap: true });

	assert.equal(alone.resolve("o"), undefined);
	assert.doesNotMatch(formatKeyHints(alone, "footer"), /both diffs/);
	assert.equal(contested.resolve("o"), "overlap");
	assert.match(formatKeyHints(contested, "footer"), /o both diffs/);
	assert.equal(noChangeSet.resolve("o"), undefined);
});
