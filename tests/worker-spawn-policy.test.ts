import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerKindRegistry } from "../extensions/worker-kinds.js";
import {
	formatWorkerLaunchSummary,
	qualifiedModelRef,
	resolveWorkerSpawnPolicy,
	type WorkerExecutionModel,
} from "../extensions/worker-spawn-policy.js";

const MODELS: WorkerExecutionModel[] = [
	{ provider: "anthropic", id: "claude-sonnet", reasoning: true },
	{ provider: "openai", id: "gpt/review", reasoning: true },
	{ provider: "google", id: "flash", reasoning: false },
];

function intentKinds() {
	const kinds = createWorkerKindRegistry();
	kinds.register({ name: "scout", readOnly: true, source: "runtime" });
	kinds.register({ name: "patcher", readOnly: false, planGate: true, source: "runtime" });
	return kinds;
}

function legacyKinds() {
	const kinds = intentKinds();
	kinds.register({
		name: "legacy",
		readOnly: true,
		model: "openai/gpt/review",
		thinking: "xhigh",
		parentSeedPolicy: "full",
		defaultWorktree: true,
		layout: "split-events",
		canSpawn: ["scout"],
		source: "runtime",
	});
	return kinds;
}

function resolve(overrides: Partial<Parameters<typeof resolveWorkerSpawnPolicy>[0]> = {}) {
	return resolveWorkerSpawnPolicy({
		kinds: intentKinds(),
		availableModels: MODELS,
		parentModel: "anthropic/claude-sonnet",
		parentThinking: "high",
		parentSession: "/parent/session.json",
		...overrides,
	});
}

test("resolveWorkerSpawnPolicy attributes kind precedence", () => {
	const kinds = intentKinds();
	assert.equal(resolve({ kinds, options: { as: "scout" }, configuredDefaultKind: "patcher" }).kindSource, "--as");
	assert.equal(resolve({ kinds, configuredDefaultKind: "patcher" }).kindSource, "worker.defaultKind");
	assert.equal(resolve({ kinds }).kindSource, "builtin default");

	const unknownRequested = resolve({ kinds, options: { as: "ghost" }, configuredDefaultKind: "patcher" });
	assert.equal(unknownRequested.kind.name, "patcher");
	assert.equal(unknownRequested.unknownRequestedKind, "ghost");
	const unknownDefault = resolve({ kinds, configuredDefaultKind: "ghost" });
	assert.equal(unknownDefault.kind.name, "default");
	assert.equal(unknownDefault.unknownDefaultKind, "ghost");
});

test("model and thinking precedence is spawn/handoff, legacy kind, then parent", () => {
	const kinds = legacyKinds();
	const parent = resolve({ kinds, options: { as: "scout" } });
	assert.equal(parent.model, "anthropic/claude-sonnet");
	assert.equal(parent.modelSource, "parent");
	assert.equal(parent.thinking, "high");
	assert.equal(parent.thinkingSource, "parent");

	const legacy = resolve({ kinds, options: { as: "legacy" } });
	assert.equal(legacy.model, "openai/gpt/review");
	assert.equal(legacy.modelSource, "deprecated kind model");
	assert.equal(legacy.thinking, "xhigh");
	assert.equal(legacy.thinkingSource, "deprecated kind thinking");

	const explicit = resolve({ kinds, options: { as: "legacy", model: "anthropic/claude-sonnet", thinking: "low" } });
	assert.equal(explicit.modelSource, "--model");
	assert.equal(explicit.thinkingSource, "--thinking");
	assert.deepEqual(explicit.launchArgs, ["--model", "anthropic/claude-sonnet", "--thinking", "low"]);

	const handoff = resolve({ kinds, options: { as: "legacy", handoff: true, model: "anthropic/claude-sonnet", thinking: "medium", seed: true } });
	assert.equal(handoff.modelSource, "handoff choice");
	assert.equal(handoff.thinkingSource, "handoff choice");
	assert.equal(handoff.contextSource, "handoff forced-fresh");
	assert.equal(handoff.context, "fresh");
});

test("context precedence keeps --fresh above --seed, config, and legacy", () => {
	const kinds = legacyKinds();
	assert.equal(resolve({ kinds, options: { as: "legacy", fresh: true, seed: true }, configuredParentSeedPolicy: "full" }).contextSource, "--fresh");
	assert.equal(resolve({ kinds, options: { as: "legacy", seed: true }, configuredParentSeedPolicy: "none" }).contextSource, "--seed");
	assert.equal(resolve({ kinds, options: { as: "legacy" }, configuredParentSeedPolicy: "none" }).contextSource, "worker.parentSeedPolicy");
	const legacy = resolve({ kinds, options: { as: "legacy" } });
	assert.equal(legacy.contextSource, "deprecated kind parent_seed");
	assert.equal(legacy.seedSource, "/parent/session.json");
	assert.equal(resolve({ options: { as: "scout" } }).contextSource, "fresh default");
});

test("missing seed source degrades visibly to fresh", () => {
	const policy = resolve({ options: { seed: true }, parentSession: undefined });
	assert.equal(policy.context, "fresh");
	assert.equal(policy.freshLaunch, true);
	assert.match(policy.warnings.join("\n"), /no parent session is available/);
});

test("workspace derives from intent while legacy operator layout metadata is ignored", () => {
	assert.equal(resolve({ options: { as: "scout" } }).useWorktree, false);
	assert.equal(resolve({ options: { as: "patcher" } }).useWorktree, true);
	assert.equal(resolve({ options: { as: "scout", worktree: true } }).workspaceSource, "--worktree");
	const legacy = resolve({ kinds: legacyKinds(), options: { as: "legacy" } });
	assert.equal(legacy.useWorktree, true);
	assert.equal(legacy.workspaceSource, "deprecated kind default_worktree");
	assert.equal("layout" in legacy, false);
	assert.equal("layoutSource" in legacy, false);
});

test("model validation requires exact available provider/model and splits only first slash", () => {
	assert.equal(resolve({ options: { model: "openai/gpt/review" } }).model, "openai/gpt/review");
	assert.throws(() => resolve({ options: { model: "gpt/review" } }), /not available/);
	assert.throws(() => resolve({ options: { model: "openai" } }), /exact provider\/model/);
	assert.throws(() => resolve({ options: { model: "openai/missing" } }), /not available/);
	assert.throws(() => resolve({ parentModel: undefined }), /No worker model resolved/);
});

test("invalid legacy execution aborts instead of falling back", () => {
	const badModel = intentKinds();
	badModel.register({ name: "bad-model", readOnly: true, model: "gpt/review" });
	assert.throws(() => resolve({ kinds: badModel, options: { as: "bad-model" } }), /not available/);

	const badThinking = intentKinds();
	badThinking.register({ name: "bad-thinking", readOnly: true, thinking: "turbo" });
	assert.throws(() => resolve({ kinds: badThinking, options: { as: "bad-thinking" } }), /thinking level "turbo" is invalid/);

	const costlyNonReasoning = intentKinds();
	costlyNonReasoning.register({ name: "bad-spend", readOnly: true, model: "google/flash", thinking: "high" });
	assert.throws(() => resolve({ kinds: costlyNonReasoning, options: { as: "bad-spend" } }), /does not support thinking level "high"/);
});

test("thinking validation supports current levels and rejects invalid or non-reasoning spend", () => {
	assert.equal(resolve({ options: { thinking: "max" } }).thinking, "max");
	assert.throws(() => resolve({ options: { thinking: "turbo" } }), /thinking level "turbo" is invalid/);
	assert.throws(() => resolve({ options: { model: "google/flash", thinking: "high" } }), /does not support thinking level "high"/);

	const inherited = resolve({ options: { model: "google/flash" } });
	assert.equal(inherited.thinking, "off");
	assert.equal(inherited.thinkingSource, "parent");
	assert.equal(inherited.thinkingAdjustedFrom, "high");
	assert.match(formatWorkerLaunchSummary(inherited), /Thinking: off[\s\S]*inherited high resolved to off/);
});

test("confirmation is conditional, while handoff and contributing legacy defaults always confirm", () => {
	assert.equal(resolve().requiresConfirmation, false);
	assert.equal(resolve({ options: { model: "anthropic/claude-sonnet", thinking: "high" } }).requiresConfirmation, false);
	assert.equal(resolve({ options: { thinking: "low" } }).requiresConfirmation, true);
	assert.equal(resolve({ kinds: legacyKinds(), options: { as: "legacy", model: "anthropic/claude-sonnet", thinking: "high", fresh: true, worktree: true } }).requiresConfirmation, false);
	assert.equal(resolve({ options: { handoff: true, model: "anthropic/claude-sonnet", thinking: "high" } }).requiresConfirmation, true);
});

test("launch summary presents resolved execution", () => {
	assert.equal(formatWorkerLaunchSummary(resolve({ options: { as: "scout" } })), [
		"Kind: scout · read-only",
		"Model: anthropic/claude-sonnet",
		"Thinking: high",
		"Context: fresh",
		"Workspace: parent directory",
	].join("\n"));
});

test("qualifiedModelRef preserves provider identity", () => {
	assert.equal(qualifiedModelRef({ provider: "openai-codex", id: "gpt/review" }), "openai-codex/gpt/review");
	assert.equal(qualifiedModelRef(undefined), undefined);
});
