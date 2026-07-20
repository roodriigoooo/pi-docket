import test from "node:test";
import assert from "node:assert/strict";
import {
	createWorkerKindRegistry,
	parseWorkerKindMarkdown,
	workerKindCompatibility,
	workerKindGuardrailsAppendix,
	DEFAULT_KIND_NAME,
} from "../extensions/worker-kinds.js";

test("parseWorkerKindMarkdown exposes intent-only kind and keeps legacy execution internal", () => {
	const md = [
		"---",
		"name: scout",
		"description: Fast read-only recon",
		"model: openai/gpt/review",
		"thinking: high",
		"read_only: true",
		"default_worktree: false",
		"parent_seed: full",
		"max_artifacts: 50",
		"can_spawn: researcher, writer",
		"layout: split-events",
		"plan_gate: true",
		"decision_rights:",
		"  - May edit docs after approval",
		"  - May run npm test",
		"---",
		"",
		"You are a scout.",
		"",
	].join("\n");
	const kind = parseWorkerKindMarkdown(md, "user", "/path/scout.md");
	assert.ok(kind);
	assert.deepEqual(kind, {
		name: "scout",
		description: "Fast read-only recon",
		readOnly: true,
		planGate: true,
		decisionRights: ["May edit docs after approval", "May run npm test"],
		maxArtifacts: 50,
		systemPrompt: "You are a scout.",
		source: "user",
		sourcePath: "/path/scout.md",
	});
	assert.deepEqual(workerKindCompatibility(kind!), {
		legacyExecution: {
			model: "openai/gpt/review",
			thinking: "high",
			parentSeedPolicy: "full",
			defaultWorktree: false,
			layout: "split-events",
		},
		legacyExecutionFields: ["model", "thinking", "parent_seed", "default_worktree", "layout"],
		diagnostics: [
			"deprecated execution frontmatter (model, thinking, parent_seed, default_worktree, layout); move execution choices to /docket spawn flags or worker config before the next major release.",
			"can_spawn ignored; worker creation is human-only.",
		],
	});
});

test("can_spawn is ignored immediately and diagnosed", () => {
	const kind = parseWorkerKindMarkdown("---\nname: dispatcher\ncan_spawn: scout\n---\n", "user");
	assert.ok(kind);
	assert.equal("canSpawn" in kind!, false);
	assert.deepEqual(workerKindCompatibility(kind!)?.legacyExecution, undefined);
	assert.match(workerKindCompatibility(kind!)?.diagnostics.join("\n") ?? "", /can_spawn ignored; worker creation is human-only/);
});

test("invalid legacy thinking remains visible for execution validation", () => {
	const kind = parseWorkerKindMarkdown("---\nname: old\nthinking: turbo\n---\n", "user");
	assert.equal(workerKindCompatibility(kind!)?.legacyExecution?.thinking, "turbo");
});

test("parseWorkerKindMarkdown rejects missing name or default and normalizes names", () => {
	assert.equal(parseWorkerKindMarkdown("---\ndescription: nope\n---\n", "user"), undefined);
	assert.equal(parseWorkerKindMarkdown("---\nname: default\n---\n", "user"), undefined);
	assert.equal(parseWorkerKindMarkdown("---\nname: My Helper Bot!\n---\n", "user")?.name, "my-helper-bot");
});

test("builtin default contains authority intent only", () => {
	const kind = createWorkerKindRegistry().get(undefined);
	assert.deepEqual(kind, {
		name: "default",
		description: "General work: inspect freely; ask before the first mutation.",
		readOnly: false,
		planGate: true,
		source: "builtin",
	});
	assert.equal(workerKindCompatibility(kind), undefined);
});

test("registry returns builtin default for unknown names", () => {
	const registry = createWorkerKindRegistry();
	assert.equal(registry.get(undefined).name, DEFAULT_KIND_NAME);
	assert.equal(registry.get("nonexistent").name, DEFAULT_KIND_NAME);
});

test("registry intent-only registration round-trips", () => {
	const registry = createWorkerKindRegistry();
	const unregister = registry.register({ name: "researcher", readOnly: true, source: "runtime" });
	assert.deepEqual(registry.get("researcher"), { name: "researcher", readOnly: true, source: "runtime" });
	unregister();
	assert.equal(registry.get("researcher").name, DEFAULT_KIND_NAME);
});

test("registry normalizes legacy runtime shape without presenting execution fields", () => {
	const registry = createWorkerKindRegistry();
	registry.register({
		name: "legacy-runtime",
		readOnly: false,
		model: "anthropic/claude",
		thinking: "high",
		parentSeedPolicy: "full",
		defaultWorktree: false,
		layout: "split-events",
		canSpawn: ["scout"],
	});
	const kind = registry.get("legacy-runtime");
	assert.deepEqual(kind, { name: "legacy-runtime", readOnly: false, source: "runtime" });
	assert.deepEqual(workerKindCompatibility(kind)?.legacyExecution, {
		model: "anthropic/claude",
		thinking: "high",
		parentSeedPolicy: "full",
		defaultWorktree: false,
		layout: "split-events",
	});
	assert.match(workerKindCompatibility(kind)?.diagnostics.join("\n") ?? "", /can_spawn ignored/);
});

test("registry refuses default overwrite and sorts default first", () => {
	const registry = createWorkerKindRegistry();
	assert.throws(() => registry.register({ name: "default", readOnly: true }));
	registry.register({ name: "zzzz", readOnly: false });
	registry.register({ name: "aaaa", readOnly: false });
	assert.deepEqual(registry.list().map((kind) => kind.name), ["default", "aaaa", "zzzz"]);
});

test("workerKindGuardrailsAppendix emits authority rules without child dispatch", () => {
	assert.equal(workerKindGuardrailsAppendix({ name: "default", readOnly: false, source: "builtin" }), "");
	const rich = workerKindGuardrailsAppendix({
		name: "scout",
		readOnly: true,
		planGate: true,
		decisionRights: ["May run read-only shell commands"],
		maxArtifacts: 50,
		maxDurationSec: 60,
		source: "user",
		systemPrompt: "Be brief.",
	});
	assert.match(rich, /read-only/);
	assert.match(rich, /Decision rights/);
	assert.match(rich, /Plan gate required/);
	assert.match(rich, /Artifact cap for this kind: 50/);
	assert.match(rich, /time budget for this kind: 60s/);
	assert.doesNotMatch(rich, /docket_spawn_child|dispatch child/i);
	assert.match(rich, /Be brief\./);
});
