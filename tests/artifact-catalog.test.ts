import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildReferenceList, createArtifactCatalog } from "../extensions/artifact-catalog.js";

function text(text: string) {
	return [{ type: "text", text }];
}

function entry(id: string, timestamp: string, message: unknown) {
	return { id, type: "message", timestamp, message };
}

async function fixtureCatalog() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "trail-catalog-test-"));
	await fs.mkdir(path.join(cwd, "src"), { recursive: true });
	await fs.writeFile(path.join(cwd, "src/a.ts"), "export const current = true;\n", "utf8");
	const longFailure = "boom ".repeat(260);
	const branch = [
		entry("u1", "2026-01-01T00:00:00.000Z", { role: "user", content: text("please fix failing tests") }),
		entry("a1", "2026-01-01T00:01:00.000Z", {
			role: "assistant",
			provider: "openai",
			model: "gpt-test",
			content: text("Plan made\n```ts\nconst ok = true;\n```")
		}),
		entry("a2", "2026-01-01T00:02:00.000Z", {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-bash-ok", name: "bash", arguments: { command: "npm run check" } }]
		}),
		entry("t1", "2026-01-01T00:03:00.000Z", {
			role: "toolResult",
			toolCallId: "call-bash-ok",
			toolName: "bash",
			isError: false,
			content: text("tsc --noEmit passed")
		}),
		entry("a3", "2026-01-01T00:04:00.000Z", {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/a.ts", limit: 20 } }]
		}),
		entry("t2", "2026-01-01T00:05:00.000Z", {
			role: "toolResult",
			toolCallId: "call-read",
			toolName: "read",
			isError: false,
			content: text("export const old = false;")
		}),
		entry("a5", "2026-01-01T00:05:30.000Z", {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-edit", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "old", newText: "current" }] } }]
		}),
		entry("t4", "2026-01-01T00:05:45.000Z", {
			role: "toolResult",
			toolCallId: "call-edit",
			toolName: "edit",
			isError: false,
			content: text("Applied edit"),
			details: { diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-export const old = false;\n+export const current = true;", firstChangedLine: 1 }
		}),
		entry("a4", "2026-01-01T00:06:00.000Z", {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-bash-fail", name: "bash", arguments: { command: "npm test" } }]
		}),
		entry("t3", "2026-01-01T00:07:00.000Z", {
			role: "toolResult",
			toolCallId: "call-bash-fail",
			toolName: "bash",
			isError: true,
			content: text(longFailure)
		}),
		{
			id: "ck1",
			type: "custom",
			customType: "trail:checkpoint",
			timestamp: "2026-01-01T00:08:00.000Z",
			data: { id: "checkpoint-1", mode: "handoff", file: "/tmp/checkpoint-1.md", note: "carry on" }
		},
	];
	const ctx = { cwd, sessionManager: { getBranch: () => branch } };
	return { cwd, catalog: createArtifactCatalog(ctx, { maxArtifacts: 50, maxBodyChars: 2000 }) };
}

test("Artifact Catalog extracts artifacts and supports stable lookup/reference/search", async () => {
	const { catalog } = await fixtureCatalog();
	const artifacts = catalog.list();
	assert.deepEqual(new Set(artifacts.map((artifact) => artifact.kind)), new Set(["prompt", "response", "code", "command", "file", "error", "checkpoint"]));

	const error = artifacts.find((artifact) => artifact.kind === "error");
	assert.ok(error);
	assert.equal(error.title, "bash failed");
	assert.equal(catalog.find(error.displayId), error);
	assert.equal(catalog.find(error.ref), error);
	assert.match(catalog.reference(error), /Avoid repeating this failure/);
	assert.match(catalog.fullText(error), /# Trail artifact/);

	const matches = await catalog.search("boom");
	assert.ok(matches.some((artifact) => artifact.ref === error.ref));
});

test("Artifact Catalog inspects read file artifacts from current disk contents", async () => {
	const { cwd, catalog } = await fixtureCatalog();
	const file = catalog.list().find((artifact) => artifact.kind === "file" && artifact.meta?.tool === "read");
	assert.ok(file);
	assert.match(catalog.reference(file), /src\/a\.ts/);

	const inspected = await catalog.inspect(file);
	assert.equal(inspected.title, path.join(cwd, "src/a.ts"));
	assert.match(inspected.text, /viewing: current file contents/);
	assert.match(inspected.text, /export const current = true/);
});

test("Artifact Catalog inspects edit file artifacts as diffs", async () => {
	const { catalog } = await fixtureCatalog();
	const file = catalog.list().find((artifact) => artifact.kind === "file" && artifact.meta?.tool === "edit");
	assert.ok(file);
	assert.match(file.subtitle, /\+1\/-1/);

	const inspected = await catalog.inspect(file);
	assert.match(inspected.title, /diff/);
	assert.match(inspected.text, /Trail diff view/);
	assert.match(inspected.text, /\+export const current = true/);
});

test("Artifact Catalog selects restart-oriented artifacts and shapes checkpoint payloads", async () => {
	const { catalog } = await fixtureCatalog();
	const selected = catalog.selectForCheckpoint(3);
	// One ordering: errors first (avoid repeats), then files, then the rest.
	assert.deepEqual(selected.map((artifact) => artifact.kind), ["error", "file", "file"]);

	const payload = catalog.checkpointPayload(selected);
	assert.equal(payload[0]?.kind, "error");
	assert.match(String(payload[0]?.body), /boom/);
});

test("Artifact Catalog accepts explicit Trail producer metadata on custom messages", () => {
	const branch = [
		entry("m1", "2026-01-01T00:00:00.000Z", {
			role: "custom",
			customType: "pi-subagents",
			content: text("# fallback heading\nworker answer body"),
			details: { trail: { title: "Worker: auth plan", subtitle: "pi-subagents worker", kind: "response" } }
		}),
	];
	const catalog = createArtifactCatalog({ cwd: "/tmp/project", sessionManager: { getBranch: () => branch } }, { maxArtifacts: 10, maxBodyChars: 2000 });
	const artifact = catalog.list()[0];
	assert.ok(artifact);
	assert.equal(artifact.kind, "response");
	assert.equal(artifact.title, "Worker: auth plan");
	assert.equal(artifact.subtitle, "pi-subagents worker");
});

test("Reference lists keep file guidance once", async () => {
	const { cwd, catalog } = await fixtureCatalog();
	const files = catalog.list().filter((artifact) => artifact.kind === "file" && artifact.meta?.tool === "read");
	const refs = buildReferenceList([...files, ...files], cwd);
	assert.equal((refs.match(/Use current file contents/g) ?? []).length, 0);
	assert.equal((refs.match(/File refs point to current disk paths/g) ?? []).length, 1);
	assert.equal((refs.match(/Reference Trail/g) ?? []).length, 2);
});
