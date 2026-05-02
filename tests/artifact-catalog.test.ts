import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createArtifactCatalog } from "../extensions/artifact-catalog.js";

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

test("Artifact Catalog inspects file artifacts from current disk contents", async () => {
	const { cwd, catalog } = await fixtureCatalog();
	const file = catalog.list().find((artifact) => artifact.kind === "file");
	assert.ok(file);
	assert.match(catalog.reference(file), /src\/a\.ts/);

	const inspected = await catalog.inspect(file);
	assert.equal(inspected.title, path.join(cwd, "src/a.ts"));
	assert.match(inspected.text, /viewing: current file contents/);
	assert.match(inspected.text, /export const current = true/);
});

test("Artifact Catalog selects and truncates checkpoint payloads by mode", async () => {
	const { catalog } = await fixtureCatalog();
	const selected = catalog.selectForCheckpoint("debug", 3);
	assert.deepEqual(selected.map((artifact) => artifact.kind), ["error", "command", "command"]);

	const payload = catalog.checkpointPayload(selected, "compact");
	assert.equal(payload[0]?.kind, "error");
	assert.match(String(payload[0]?.body), /Trail truncated/);
});
