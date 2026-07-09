import test from "node:test";
import assert from "node:assert/strict";
import { createParentRuntime } from "../extensions/parent-runtime.js";
import { createSharedSessionRuntime } from "../extensions/shared-session-runtime.js";
import { createWorkerRuntime } from "../extensions/worker-runtime.js";

test("parent runtime starts dock behavior without worker protocol", () => {
	const calls: string[] = [];
	const runtime = createParentRuntime({
		startWorkerWatchAndDock: () => calls.push("start-watch"),
		stopWorkerWatchAndDock: () => calls.push("stop-watch"),
	});

	runtime.onSessionStart();
	runtime.onSessionShutdown();

	assert.deepEqual(calls, ["start-watch", "stop-watch"]);
});

test("worker runtime registers protocol behavior without parent watch", async () => {
	const calls: string[] = [];
	const runtime = createWorkerRuntime({
		workerId: "worker-1",
		registerGuardrailsAndProtocol: () => calls.push("guardrails-and-tools"),
		startHeartbeat: () => calls.push("start-heartbeat"),
		stopHeartbeat: () => { calls.push("stop-heartbeat"); },
	});

	runtime.register();
	runtime.onSessionStart();
	await runtime.onSessionShutdown();

	assert.deepEqual(calls, ["guardrails-and-tools", "start-heartbeat", "stop-heartbeat"]);
});

test("non-worker runtime registers no protocol tools or timers", async () => {
	const calls: string[] = [];
	const runtime = createWorkerRuntime({
		registerGuardrailsAndProtocol: () => calls.push("guardrails"),
		startHeartbeat: () => calls.push("start"),
		stopHeartbeat: () => { calls.push("stop"); },
	});

	runtime.register();
	runtime.onSessionStart();
	await runtime.onSessionShutdown();

	assert.equal(runtime.isWorker, false);
	assert.deepEqual(calls, []);
});

test("shared runtime remains available in both session modes", () => {
	const calls: string[] = [];
	const runtime = createSharedSessionRuntime({
		registerMessageRendering: () => calls.push("render"),
		registerCommandRouting: () => calls.push("commands"),
		registerSessionLifecycle: () => calls.push("lifecycle"),
		registerContextExpansion: () => calls.push("mounted-artifacts"),
	});

	runtime.register();

	assert.deepEqual(calls, ["render", "commands", "lifecycle", "mounted-artifacts"]);
});
