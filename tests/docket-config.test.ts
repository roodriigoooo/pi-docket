import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../extensions/docket-config.js";

test("loadConfig ignores removed bundle/tmux keys and emits bounded migration notices", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "docket-config-test-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
		await rm(root, { recursive: true, force: true });
	});
	await mkdir(path.join(cwd, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(path.join(agentDir, "docket.json"), `${JSON.stringify({
		maxArtifacts: 111,
		bundleArtifacts: 99,
		summarizer: { enabled: true },
		worker: { maxActive: 3, tmuxStatusLine: true, captureTerminal: true },
	})}\n`, "utf8");
	await writeFile(path.join(cwd, ".pi", "docket.json"), `${JSON.stringify({
		maxBodyChars: 222,
		consumedRetentionDays: 365,
		worker: { defaultKind: "scout", layout: "split-events" },
	})}\n`, "utf8");

	const config = await loadConfig(cwd);

	assert.equal(config.maxArtifacts, 111);
	assert.equal(config.maxBodyChars, 222);
	assert.equal(config.worker?.maxActive, 3);
	assert.equal(config.worker?.defaultKind, "scout");
	assert.equal("bundleArtifacts" in config, false);
	assert.equal("summarizer" in config, false);
	assert.equal("tmuxStatusLine" in (config.worker ?? {}), false);
	assert.equal("captureTerminal" in (config.worker ?? {}), false);
	assert.equal("layout" in (config.worker ?? {}), false);
	assert.deepEqual(config.migrationWarnings, [
		"obsolete worker tmux config ignored; operator layouts moved out of core.",
		"obsolete bundle and summarizer config ignored; /docket save now writes durable deliverables.",
	]);
});
