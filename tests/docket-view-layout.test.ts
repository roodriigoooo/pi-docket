import test from "node:test";
import assert from "node:assert/strict";
import { DocketView, renderArtifactPreviewLines } from "../extensions/docket.js";
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
	return { id, displayId: id, ref: `error:${id}`, kind: "error", title, subtitle: "", body, timestamp: Date.now() };
}

function reviewView(artifacts: Artifact[]): DocketView {
	return new DocketView(tui as never, theme, artifacts, new Set(), new Set(), "review", (artifact) => artifact.body, () => {});
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
