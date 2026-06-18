import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerKindRegistry, parseWorkerKindMarkdown, workerKindGuardrailsAppendix, DEFAULT_KIND_NAME } from "../extensions/worker-kinds.js";

test("parseWorkerKindMarkdown reads frontmatter + body", () => {
	const md = [
		"---",
		"name: scout",
		"description: Fast read-only recon",
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
	assert.equal(kind?.name, "scout");
	assert.equal(kind?.description, "Fast read-only recon");
	assert.equal(kind?.readOnly, true);
	assert.equal(kind?.defaultWorktree, false);
	assert.equal(kind?.parentSeedPolicy, "full");
	assert.equal(kind?.maxArtifacts, 50);
	assert.deepEqual(kind?.canSpawn, ["researcher", "writer"]);
	assert.equal(kind?.layout, "split-events");
	assert.equal(kind?.planGate, true);
	assert.deepEqual(kind?.decisionRights, ["May edit docs after approval", "May run npm test"]);
	assert.equal(kind?.systemPrompt, "You are a scout.");
	assert.equal(kind?.source, "user");
	assert.equal(kind?.sourcePath, "/path/scout.md");
});

test("parseWorkerKindMarkdown rejects missing name or 'default'", () => {
	assert.equal(parseWorkerKindMarkdown("---\ndescription: nope\n---\n", "user"), undefined);
	assert.equal(parseWorkerKindMarkdown("---\nname: default\n---\n", "user"), undefined);
});

test("parseWorkerKindMarkdown normalises name to safe slug", () => {
	const md = "---\nname: My Helper Bot!\n---\n";
	const kind = parseWorkerKindMarkdown(md, "user");
	assert.equal(kind?.name, "my-helper-bot");
});

test("default kind and unset parent_seed default to fresh (none)", () => {
	const reg = createWorkerKindRegistry();
	assert.equal(reg.get(undefined).parentSeedPolicy, "none");
	const unset = parseWorkerKindMarkdown("---\nname: probe\n---\n", "user");
	assert.equal(unset?.parentSeedPolicy, "none");
	const explicitFull = parseWorkerKindMarkdown("---\nname: probe\nparent_seed: full\n---\n", "user");
	assert.equal(explicitFull?.parentSeedPolicy, "full");
});

test("registry returns the builtin default for unknown names", () => {
	const reg = createWorkerKindRegistry();
	assert.equal(reg.get(undefined).name, DEFAULT_KIND_NAME);
	assert.equal(reg.get("nonexistent").name, DEFAULT_KIND_NAME);
});

test("registry.register + unregister round-trip works", () => {
	const reg = createWorkerKindRegistry();
	const unregister = reg.register({
		name: "researcher",
		readOnly: true,
		defaultWorktree: false,
		parentSeedPolicy: "full",
		canSpawn: [],
		layout: "single",
		source: "runtime",
	});
	assert.equal(reg.get("researcher").name, "researcher");
	assert.ok(reg.names().includes("researcher"));
	unregister();
	assert.equal(reg.get("researcher").name, DEFAULT_KIND_NAME);
});

test("registry refuses to overwrite 'default'", () => {
	const reg = createWorkerKindRegistry();
	assert.throws(() => reg.register({
		name: "default",
		readOnly: true,
		defaultWorktree: false,
		parentSeedPolicy: "full",
		canSpawn: [],
		layout: "single",
		source: "runtime",
	}));
});

test("registry.list sorts default first", () => {
	const reg = createWorkerKindRegistry();
	reg.register({ name: "zzzz", readOnly: false, defaultWorktree: true, parentSeedPolicy: "full", canSpawn: [], layout: "single", source: "runtime" });
	reg.register({ name: "aaaa", readOnly: false, defaultWorktree: true, parentSeedPolicy: "full", canSpawn: [], layout: "single", source: "runtime" });
	const names = reg.list().map((k) => k.name);
	assert.equal(names[0], DEFAULT_KIND_NAME);
	assert.deepEqual(names.slice(1), ["aaaa", "zzzz"]);
});

test("workerKindGuardrailsAppendix only emits sections when kind has bespoke rules", () => {
	const empty = workerKindGuardrailsAppendix({ name: "default", readOnly: false, defaultWorktree: true, parentSeedPolicy: "full", canSpawn: [], layout: "single", source: "builtin" });
	assert.equal(empty, "");
	const rich = workerKindGuardrailsAppendix({ name: "scout", readOnly: true, defaultWorktree: false, parentSeedPolicy: "full", canSpawn: ["researcher"], planGate: true, decisionRights: ["May run read-only shell commands"], maxArtifacts: 50, maxDurationSec: 60, layout: "single", source: "user", systemPrompt: "Be brief." });
	assert.match(rich, /read-only/);
	assert.match(rich, /Decision rights/);
	assert.match(rich, /May run read-only shell commands/);
	assert.match(rich, /Plan gate required/);
	assert.match(rich, /Artifact cap for this kind: 50/);
	assert.match(rich, /time budget for this kind: 60s/);
	assert.match(rich, /docket_spawn_child/);
	assert.match(rich, /researcher/);
	assert.match(rich, /Be brief\./);
});
