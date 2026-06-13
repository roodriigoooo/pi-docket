import test from "node:test";
import assert from "node:assert/strict";
import { DocketView } from "../extensions/docket.js";
import type { Artifact } from "../extensions/types.js";

const theme = {
	fg: (_token: string, s: string) => s,
	bg: (_token: string, s: string) => s,
	bold: (s: string) => s,
};

const tui = { requestRender() {} };

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
