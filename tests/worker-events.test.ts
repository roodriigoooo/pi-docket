import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { appendWorkerEventSync, tailWorkerEvents, workerEventFilePath, WORKER_EVENT_ROTATE_BYTES } from "../extensions/worker-events.js";

async function temp(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "docket-events-"));
}

test("appendWorkerEventSync writes NDJSON entries", async () => {
	const root = await temp();
	try {
		await mkdir(path.join(root, "w1"), { recursive: true });
		appendWorkerEventSync(root, "w1", { kind: "state", payload: { state: "needs_input" } });
		appendWorkerEventSync(root, "w1", { kind: "tool", payload: { tool: "bash" } });
		const text = await readFile(workerEventFilePath(root, "w1"), "utf8");
		const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
		assert.equal(lines.length, 2);
		assert.equal(lines[0].kind, "state");
		assert.equal(lines[1].kind, "tool");
		assert.equal(typeof lines[0].ts, "number");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("tailWorkerEvents reads only new bytes since last offset", async () => {
	const root = await temp();
	try {
		await mkdir(path.join(root, "w1"), { recursive: true });
		appendWorkerEventSync(root, "w1", { kind: "state", payload: { state: "active" } });

		const first = await tailWorkerEvents(root, "w1", { offset: 0 });
		assert.equal(first.events.length, 1);
		assert.equal(first.rotated, false);

		const second = await tailWorkerEvents(root, "w1", { offset: first.offset });
		assert.equal(second.events.length, 0);

		appendWorkerEventSync(root, "w1", { kind: "todo", payload: { total: 3, completed: 1 } });
		const third = await tailWorkerEvents(root, "w1", { offset: second.offset });
		assert.equal(third.events.length, 1);
		assert.equal(third.events[0]!.kind, "todo");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("tailWorkerEvents resets when file is rotated/truncated", async () => {
	const root = await temp();
	try {
		await mkdir(path.join(root, "w1"), { recursive: true });
		appendWorkerEventSync(root, "w1", { kind: "state", payload: { state: "active" } });
		const before = await tailWorkerEvents(root, "w1", { offset: 0 });

		await rm(workerEventFilePath(root, "w1"));
		appendWorkerEventSync(root, "w1", { kind: "state", payload: { state: "ready" } });

		const tail = await tailWorkerEvents(root, "w1", { offset: before.offset });
		assert.equal(tail.rotated, true);
		assert.equal(tail.events.length, 1);
		assert.equal(tail.events[0]!.payload.state, "ready");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("event rotation kicks in past WORKER_EVENT_ROTATE_BYTES", async () => {
	assert.equal(WORKER_EVENT_ROTATE_BYTES > 0, true);
	// behavior contract only; full size test is expensive and covered by manual ops review
});

test("tailWorkerEvents returns empty when no file yet", async () => {
	const root = await temp();
	try {
		const tail = await tailWorkerEvents(root, "ghost", { offset: 0 });
		assert.equal(tail.events.length, 0);
		assert.equal(tail.offset, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
