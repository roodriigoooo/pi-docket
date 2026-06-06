import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildWorkerLaunchCommand, seedWorkerSession } from "../extensions/worker-store.js";

async function createParentSession(cwd: string): Promise<string> {
	const dir = path.join(cwd, ".session");
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, "parent.jsonl");
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "parent-id", timestamp: "2026-05-01T00:00:00.000Z", cwd }),
		JSON.stringify({ type: "custom", id: "e1", parentId: null, timestamp: "2026-05-01T00:00:01.000Z", customType: "docket:test", data: { hello: "world" } }),
		JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: "2026-05-01T00:00:02.000Z", message: { role: "user", content: "hello" } }),
		JSON.stringify({ type: "message", id: "e3", parentId: "e2", timestamp: "2026-05-01T00:00:03.000Z", message: { role: "assistant", content: "hi" } }),
	];
	await writeFile(file, `${lines.join("\n")}\n`, "utf8");
	return file;
}

test("seedWorkerSession copies parent JSONL into worker session dir", async () => {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "docket-seed-"));
	try {
		const parentCwd = path.join(tmp, "parent");
		await mkdir(parentCwd, { recursive: true });
		const parentFile = await createParentSession(parentCwd);

		const workerCwd = path.join(tmp, "worker");
		const workerSessionDir = path.join(workerCwd, "session");
		await mkdir(workerCwd, { recursive: true });

		const ok = seedWorkerSession(parentFile, workerCwd, workerSessionDir);
		assert.equal(ok, true);

		const entries = await readdir(workerSessionDir);
		const sessionFiles = entries.filter((e) => e.endsWith(".jsonl"));
		assert.equal(sessionFiles.length, 1);

		const seeded = await readFile(path.join(workerSessionDir, sessionFiles[0]!), "utf8");
		const lines = seeded.split("\n").filter(Boolean).map((l) => JSON.parse(l));
		assert.equal(lines[0]!.type, "session");
		assert.equal(lines[0]!.cwd, workerCwd);
		assert.equal(lines[0]!.parentSession, parentFile);
		assert.equal(lines.some((entry) => entry.type === "custom" && entry.customType === "docket:test"), true);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});

test("seedWorkerSession returns false when parent missing", () => {
	const ok = seedWorkerSession("/nonexistent/parent.jsonl", "/tmp/worker", "/tmp/worker/session");
	assert.equal(ok, false);
});

test("buildWorkerLaunchCommand inserts --continue when seeded", () => {
	const seeded = buildWorkerLaunchCommand({
		id: "abc",
		sessionDir: "/tmp/session",
		statusFile: "/tmp/status.json",
		initialPrompt: "do thing",
		piCommandParts: ["pi"],
		resumeSeeded: true,
	});
	assert.match(seeded, /--continue/);

	const fresh = buildWorkerLaunchCommand({
		id: "abc",
		sessionDir: "/tmp/session",
		statusFile: "/tmp/status.json",
		initialPrompt: "do thing",
		piCommandParts: ["pi"],
		resumeSeeded: false,
	});
	assert.equal(fresh.includes("--continue"), false);
});
