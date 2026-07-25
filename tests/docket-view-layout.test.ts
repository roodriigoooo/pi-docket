import test from "node:test";
import assert from "node:assert/strict";
import { DocketParallelWorkView, DocketView, renderArtifactPreviewLines } from "../extensions/docket.js";
import { normalizeWorkerTodos, type WorkerStatus } from "../extensions/background-work.js";
import type { Artifact } from "../extensions/types.js";

const theme = {
	fg: (_token: string, s: string) => s,
	bg: (_token: string, s: string) => s,
	bold: (s: string) => s,
};

const tui = { requestRender() {} };

const colorTheme = {
	fg: (token: string, s: string) => `<${token}:${s}>`,
	bg: (_token: string, s: string) => s,
	bold: (s: string) => s,
};

function errorArtifact(id: string, title: string, body: string): Artifact {
	return { id, displayId: id, ref: `error:${id}`, kind: "error", title, subtitle: "", body, timestamp: 0 };
}

function reviewView(artifacts: Artifact[]): DocketView {
	return new DocketView(tui as never, theme, artifacts, new Set(), new Set(), "review", (artifact) => artifact.body, () => {});
}

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 1,
		tmuxSession: "docket-workers:w1",
		task: "ship worker progress lens",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:02:00.000Z",
		state: "active",
		...partial,
	};
}

test("Docket review splits into two panes on wide terminals", () => {
	const artifacts = [
		errorArtifact("e1", "TypeError: boom in auth.ts", "stack frame one\nstack frame two\nstack frame three"),
		errorArtifact("e2", "Command failed: npm test", "exit code 1"),
	];
	const wide = reviewView(artifacts).render(140).join("\n");

	assert.match(wide, /│/, "wide layout draws the vertical pane divider");
	assert.match(wide, /stack frame one/, "right pane shows the selection's evidence preview");
	assert.match(wide, /Failed \/ blocked/, "category headers stay in the list pane");
});

test("Docket review stays single-column under the breakpoint", () => {
	const artifacts = [errorArtifact("e1", "TypeError: boom in auth.ts", "stack frame one")];
	const narrow = reviewView(artifacts).render(90).join("\n");

	assert.doesNotMatch(narrow, /│/, "no vertical divider in stacked layout");
	assert.match(narrow, /TypeError: boom in auth\.ts/);
});

test("Docket worker progress lens renders compact and expanded todo boards", () => {
	const fresh = new Date().toISOString();
	const w = worker({
		createdAt: fresh,
		updatedAt: fresh,
		todos: normalizeWorkerTodos([
			{ text: "Map dock state", state: "completed" },
			{ text: "Add progress bar", state: "completed" },
			{ text: "Wire shortcut", state: "in_progress" },
			{ text: "Update docs", state: "pending" },
			{ text: "Run smoke", state: "pending" },
		]),
	});
	const view = new DocketParallelWorkView(tui as never, theme, [w], new Map(), () => {}, false, new Set());
	const compact = view.render(120).join("\n");

	assert.match(compact, /work\s+status\s+task\s+result/);
	assert.doesNotMatch(compact, /result\s+action/);
	assert.match(compact, /▌ w1\s+\[active\]/);
	assert.match(compact, /Esc\/q\/Ctrl\+C close[\s\S]*r tell[\s\S]*x stop/);
	assert.doesNotMatch(compact, /a attach/);
	assert.match(compact, /progress 2\/5/);
	assert.match(compact, /Progress/);
	assert.match(compact, /▰▰▱▱▱ · 1 active · 2 pending/);
	assert.doesNotMatch(compact, /2\/5 ▰/);
	assert.match(compact, /└ … 2 more/);
	assert.doesNotMatch(compact, /Run smoke/);

	view.handleInput("t");
	const expanded = view.render(120).join("\n");
	assert.match(expanded, /Run smoke/);
	assert.doesNotMatch(expanded, /└ … 2 more/);
});

test("Docket worker dashboard stays useful across compact widths", () => {
	const states: WorkerStatus[] = [
		worker({ id: "active", index: 1, state: "active", task: "map auth call sites" }),
		worker({ id: "waiting", index: 2, state: "needs_input", task: "choose migration path", question: "Which path?" }),
		worker({ id: "ready", index: 3, state: "ready", task: "fix auth flake", summary: "done" }),
	];
	for (const width of [64, 96, 120]) {
		const view = new DocketParallelWorkView(tui as never, theme, states, new Map(), () => {}, false, new Set(["ready"]));
		const rendered = view.render(width).join("\n");
		assert.match(rendered, /map auth call sites/);
		assert.match(rendered, /choose migration path/);
		assert.match(rendered, /fix auth flake/);
		assert.doesNotMatch(rendered, /tool:/);
	}
});

test("Docket worker progress lens routes Enter to verdict for decision rows", () => {
	const w = worker({ state: "ready", summary: "done" });
	let action: unknown;
	const view = new DocketParallelWorkView(tui as never, theme, [w], new Map(), (result) => { action = result; }, false, new Set());

	view.handleInput("\r");

	assert.deepEqual(action, { action: "verdict", worker: w });
});

test("Docket worker progress lens routes failed rows to verdict and hides load after loading", () => {
	const failed = worker({ state: "failed", lastError: "boom" });
	let failedAction: unknown;
	const failedView = new DocketParallelWorkView(tui as never, theme, [failed], new Map(), (result) => { failedAction = result; }, false, new Set());
	failedView.handleInput("\r");
	assert.deepEqual(failedAction, { action: "verdict", worker: failed });

	const ready = worker({ state: "ready", summary: "done" });
	let loadedAction: unknown;
	const loadedView = new DocketParallelWorkView(tui as never, theme, [ready], new Map(), (result) => { loadedAction = result; }, false, new Set([ready.id]));
	const rendered = loadedView.render(96).join("\n");
	assert.doesNotMatch(rendered, /Enter verdict\/details/);
	assert.doesNotMatch(rendered, /l load/);
	loadedView.handleInput("l");
	assert.equal(loadedAction, undefined);
});

test("artifact preview colors file diff stats and diff body", () => {
	const artifact: Artifact = {
		id: "f1",
		displayId: "f1",
		ref: "file:1:0",
		kind: "file",
		title: "edit src/app.ts",
		subtitle: "1 edit(s) · +1/-1",
		body: "",
		meta: { tool: "edit", diff: "@@ -1 +1 @@\n-old\n+new" },
	};
	const rendered = renderArtifactPreviewLines(colorTheme, artifact, ["meta: 1 edit(s) · +1/-1", "--- diff ---", "@@ -1 +1 @@", "-old", "+new"]);

	assert.deepEqual(rendered, [
		"<dim:meta: 1 edit(s) · ><toolDiffAdded:+1><dim:/><toolDiffRemoved:-1>",
		"<muted:--- diff --->",
		"<accent:@@ -1 +1 @@>",
		"<toolDiffRemoved:-old>",
		"<toolDiffAdded:+new>",
	]);
});

test("artifact preview colors worker change-set stats before patch body", () => {
	const artifact: Artifact = {
		id: "changes",
		displayId: "changes",
		ref: "worker-changes:1:0",
		kind: "response",
		title: "w1 change set",
		subtitle: "task",
		body: "",
		meta: { workerChangeSet: true },
	};
	const rendered = renderArtifactPreviewLines(colorTheme, artifact, ["src/app.ts +2/-1", "Patch:", "diff --git a/src/app.ts b/src/app.ts", "+new"]);

	assert.deepEqual(rendered, [
		"<dim:src/app.ts ><toolDiffAdded:+2><dim:/><toolDiffRemoved:-1>",
		"<muted:Patch:>",
		"<muted:diff --git a/src/app.ts b/src/app.ts>",
		"<toolDiffAdded:+new>",
	]);
});
