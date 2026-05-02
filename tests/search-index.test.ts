import test from "node:test";
import assert from "node:assert/strict";
import { buildArtifactSearchDocument, searchArtifacts, type ArtifactSearchDocument } from "../extensions/search-index.js";
import type { Artifact } from "../extensions/types.js";

function artifact(id: string, kind: Artifact["kind"], title: string, body: string, meta: Record<string, unknown> = {}): Artifact {
	return {
		id,
		displayId: id,
		ref: `${kind}:entry:${id}`,
		kind,
		title,
		subtitle: "subtitle",
		body,
		entryId: `entry-${id}`,
		timestamp: Date.parse("2026-01-01T00:00:00Z"),
		meta,
	};
}

const artifacts = [
	artifact("p1", "prompt", "issue 7", "please inspect issue 7"),
	artifact("r1", "response", "issue 7 notes", "transcript issue 7"),
	artifact("c1", "command", "$ npm test", "issue 7 failing command"),
	artifact("f1", "file", "edit src/search.ts", "issue 7 relevant file"),
	artifact("e1", "error", "bash failed", "issue 7 fatal error"),
];

test("Search Index returns ranked artifacts from ripgrep candidates", async () => {
	const matches = await searchArtifacts("issue 7", artifacts, {
		runRipgrep: async (_query, documents) => new Set(documents.map((document) => document.id)),
	});

	assert.deepEqual(matches.map((match) => match.kind), ["error", "file", "command", "prompt", "response"]);
});

test("Search Index ranks primary matches ahead within same kind", async () => {
	const first = artifact("c1", "command", "$ npm test", "needle in body");
	const second = artifact("c2", "command", "needle command", "body");
	const matches = await searchArtifacts("needle", [first, second], {
		runRipgrep: async (_query, documents) => new Set(documents.map((document) => document.id)),
	});

	assert.deepEqual(matches.map((match) => match.displayId), ["c2", "c1"]);
});

test("Search Index falls back to in-memory search when ripgrep fails", async () => {
	const matches = await searchArtifacts("fatal", artifacts, {
		runRipgrep: async () => { throw new Error("rg unavailable"); },
	});

	assert.deepEqual(matches.map((match) => match.displayId), ["e1"]);
});

test("Search Index treats ripgrep no-match as empty without fallback", async () => {
	const matches = await searchArtifacts("fatal", artifacts, {
		runRipgrep: async () => new Set(),
	});

	assert.deepEqual(matches, []);
});

test("Search Index documents include metadata with low-rank matching", async () => {
	const metaArtifact = artifact("c1", "command", "$ npm test", "plain body", { command: "npm run special-check" });
	const document = buildArtifactSearchDocument(metaArtifact);
	assert.match(document.rankText.metadata, /special-check/);
	assert.match(document.content, /metadata:/);

	const matches = await searchArtifacts("special-check", [metaArtifact], {
		runRipgrep: async (_query, documents: ArtifactSearchDocument[]) => new Set(documents.map((doc) => doc.id)),
	});
	assert.deepEqual(matches.map((match) => match.displayId), ["c1"]);
});

test("Search Index returns empty results for blank queries", async () => {
	const matches = await searchArtifacts("   ", artifacts, {
		runRipgrep: async () => { throw new Error("should not run"); },
	});
	assert.deepEqual(matches, []);
});
