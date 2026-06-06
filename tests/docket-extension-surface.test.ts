import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerKindRegistry } from "../extensions/worker-kinds.js";
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
		readOnly: true,
		defaultWorktree: false,
		parentSeedPolicy: "full",
		canSpawn: [],
		layout: "single",
	});
	assert.ok(surface.listWorkerKinds().some((k) => k.name === "ext-kind" && k.source === "runtime"));
	unregister();
	assert.equal(surface.listWorkerKinds().some((k) => k.name === "ext-kind"), false);
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
