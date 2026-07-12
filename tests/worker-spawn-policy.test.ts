import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerKindRegistry } from "../extensions/worker-kinds.js";
import { qualifiedModelRef, resolveWorkerSpawnPolicy, workerKindLaunchArgs } from "../extensions/worker-spawn-policy.js";

function registerPlanner() {
	const kinds = createWorkerKindRegistry();
	kinds.register({
		name: "planner",
		model: "anthropic/claude-opus-4-7",
		thinking: "xhigh",
		readOnly: true,
		defaultWorktree: false,
		parentSeedPolicy: "full",
		canSpawn: [],
		layout: "split-events",
		source: "runtime",
	});
	return kinds;
}

test("resolveWorkerSpawnPolicy honors configured default kind", () => {
	const policy = resolveWorkerSpawnPolicy({
		kinds: registerPlanner(),
		configuredDefaultKind: "planner",
		parentSession: "/parent/session.json",
	});

	assert.equal(policy.kind.name, "planner");
	assert.equal(policy.seedSource, "/parent/session.json");
	assert.equal(policy.freshLaunch, false);
	assert.equal(policy.useWorktree, false);
	assert.equal(policy.layout, "split-events");
	assert.deepEqual(policy.launchArgs, ["--model", "anthropic/claude-opus-4-7", "--thinking", "xhigh"]);
});

test("resolveWorkerSpawnPolicy keeps --fresh above configured seed policy", () => {
	const policy = resolveWorkerSpawnPolicy({
		kinds: registerPlanner(),
		options: { as: "planner", fresh: true, seed: true },
		configuredParentSeedPolicy: "full",
		parentSession: "/parent/session.json",
	});

	assert.equal(policy.kind.name, "planner");
	assert.equal(policy.seedSource, undefined);
	assert.equal(policy.freshLaunch, true);
});

test("resolveWorkerSpawnPolicy reports unknown requested and default kinds", () => {
	const kinds = createWorkerKindRegistry();
	const requested = resolveWorkerSpawnPolicy({ kinds, options: { as: "ghost" }, configuredDefaultKind: "planner" });
	const configured = resolveWorkerSpawnPolicy({ kinds, configuredDefaultKind: "planner" });

	assert.equal(requested.kind.name, "default");
	assert.equal(requested.unknownRequestedKind, "ghost");
	assert.equal(configured.kind.name, "default");
	assert.equal(configured.unknownDefaultKind, "planner");
});

test("workerKindLaunchArgs only emits configured launch flags", () => {
	assert.deepEqual(workerKindLaunchArgs({ model: "openai/gpt-5.2" }), ["--model", "openai/gpt-5.2"]);
	assert.deepEqual(workerKindLaunchArgs({ thinking: "minimal" }), ["--thinking", "minimal"]);
	assert.deepEqual(workerKindLaunchArgs({}, { model: "google/gemini-3-pro" }), ["--model", "google/gemini-3-pro"]);
	assert.deepEqual(workerKindLaunchArgs({}), []);
});

test("qualifiedModelRef preserves provider identity for ambiguous model ids", () => {
	assert.equal(qualifiedModelRef({ provider: "openai-codex", id: "gpt-5.6-sol" }), "openai-codex/gpt-5.6-sol");
	assert.equal(qualifiedModelRef({ provider: "azure-openai-responses", id: "gpt-5.6-sol" }), "azure-openai-responses/gpt-5.6-sol");
	assert.equal(qualifiedModelRef(undefined), undefined);
});
