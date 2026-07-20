import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createWorkerKindRegistry, workerKindCompatibility } from "../extensions/worker-kinds.js";
import { installDocketExtensionSurface, getDocketExtensionSurface } from "../extensions/docket-extension-surface.js";

test("installDocketExtensionSurface exposes globalThis.__docket", () => {
	const registry = createWorkerKindRegistry();
	const surface = installDocketExtensionSurface(registry);
	assert.equal(getDocketExtensionSurface(), surface);
	assert.equal(typeof surface.registerWorkerKind, "function");
	assert.equal(typeof surface.listWorkerKinds, "function");
	assert.equal(typeof surface.onWorkerEvent, "function");
});

test("registerWorkerKind round-trips through the surface", () => {
	const registry = createWorkerKindRegistry();
	const surface = installDocketExtensionSurface(registry);
	const unregister = surface.registerWorkerKind({
		name: "ext-kind",
		description: "Intent-only extension kind",
		readOnly: true,
	});
	assert.ok(surface.listWorkerKinds().some((k) => k.name === "ext-kind" && k.source === "runtime"));
	unregister();
	assert.equal(surface.listWorkerKinds().some((k) => k.name === "ext-kind"), false);
});

test("legacy runtime registration remains readable but returns narrow kind", () => {
	const registry = createWorkerKindRegistry();
	const surface = installDocketExtensionSurface(registry);
	surface.registerWorkerKind({
		name: "legacy-ext",
		readOnly: false,
		model: "openai/gpt",
		thinking: "high",
		parentSeedPolicy: "full",
		defaultWorktree: false,
		layout: "split-events",
		canSpawn: ["scout"],
	});
	const kind = surface.listWorkerKinds().find((entry) => entry.name === "legacy-ext");
	assert.deepEqual(kind, { name: "legacy-ext", readOnly: false, source: "runtime" });
	assert.equal(workerKindCompatibility(kind!)?.legacyExecution?.model, "openai/gpt");
	assert.match(workerKindCompatibility(kind!)?.diagnostics.join("\n") ?? "", /can_spawn ignored/);
});

test("worker extension source exposes no autonomous spawn tool", async () => {
	const source = await readFile(path.join(process.cwd(), "extensions", "docket.ts"), "utf8");
	assert.doesNotMatch(source, /docket_spawn_child/);
	assert.doesNotMatch(source, /\.spawn\(\{/);
});

test("bundled kinds contain intent-only frontmatter", async () => {
	for (const name of ["scout", "patcher"]) {
		const source = await readFile(path.join(process.cwd(), "extensions", "worker-kinds", `${name}.md`), "utf8");
		assert.doesNotMatch(source, /^(model|thinking|parent_seed|default_worktree|can_spawn|layout):/m);
	}
});

test("onWorkerEvent receives emitted events and unsubscribes cleanly", () => {
	const registry = createWorkerKindRegistry();
	const surface = installDocketExtensionSurface(registry);
	const received: Array<{ workerId: string; kind: string }> = [];
	const unsubscribe = surface.onWorkerEvent(({ workerId, event }) => received.push({ workerId, kind: event.kind }));
	surface.emitWorkerEvent("w1", { ts: 1, kind: "state", payload: {} });
	surface.emitWorkerEvent("w2", { ts: 2, kind: "tool", payload: {} });
	unsubscribe();
	surface.emitWorkerEvent("w3", { ts: 3, kind: "todo", payload: {} });
	assert.deepEqual(received, [{ workerId: "w1", kind: "state" }, { workerId: "w2", kind: "tool" }]);
});

test("a misbehaving subscriber never breaks the surface", () => {
	const registry = createWorkerKindRegistry();
	const surface = installDocketExtensionSurface(registry);
	surface.onWorkerEvent(() => { throw new Error("boom"); });
	const calls: string[] = [];
	surface.onWorkerEvent(({ event }) => calls.push(event.kind));
	surface.emitWorkerEvent("w1", { ts: 1, kind: "state", payload: {} });
	assert.deepEqual(calls, ["state"]);
});
