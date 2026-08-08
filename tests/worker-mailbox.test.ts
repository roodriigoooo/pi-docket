import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	buildWorkerMessage,
	claimPendingWorkerMessages,
	collapseWorkerMessageBody,
	formatWorkerMessageForSession,
	listWorkerMessages,
	markWorkerMessagesRead,
	newWorkerMessageId,
	parseWorkerMessage,
	pendingWorkerMessageLine,
	projectWorkerMessageDelivery,
	readWorkerMessageSync,
	sentWorkerMessageStateLabel,
	sentWorkerMessageTimeline,
	workerInboxDir,
	writeWorkerMessage,
	type WorkerMessage,
} from "../extensions/worker-mailbox.js";

async function tempRoot(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "docket-mailbox-"));
}

test("buildWorkerMessage normalizes the body and defaults to a steering directive", () => {
	const message = buildWorkerMessage({ body: "\n\nfocus on src/auth  \r\n\n" });

	assert.equal(message?.body, "focus on src/auth");
	assert.equal(message?.kind, "directive");
	assert.equal(message?.from, "human");
	assert.equal(message?.deliverAs, "steer");
	assert.equal(message?.delivery, "queued");
});

test("buildWorkerMessage refuses an empty body", () => {
	assert.equal(buildWorkerMessage({ body: "   \n\t " }), undefined);
});

test("a replyTo turns a directive into an answer", () => {
	const message = buildWorkerMessage({ body: "yes", replyTo: "q2", replyToText: "Update the tests too?" });

	assert.equal(message?.kind, "answer");
	assert.equal(message?.replyTo, "q2");
});

test("message ids sort chronologically as plain strings", () => {
	const ids = [
		newWorkerMessageId(1_700_000_000_000, "aaa"),
		newWorkerMessageId(999_000_000_000, "bbb"),
		newWorkerMessageId(1_700_000_000_001, "ccc"),
	];

	assert.deepEqual([...ids].sort(), [ids[1], ids[0], ids[2]]);
});

test("ids written in the same millisecond keep the order they were written in", () => {
	// Random suffixes alone would order these arbitrarily, which would let a follow-up be
	// delivered ahead of the message it follows up on.
	const ids = [
		newWorkerMessageId(1_700_000_000_000, "fff"),
		newWorkerMessageId(1_700_000_000_000, "aaa"),
		newWorkerMessageId(1_700_000_000_000, "zzz"),
	];

	assert.deepEqual([...ids].sort(), ids);
});

test("parseWorkerMessage survives anything the inbox scan can hand it", () => {
	assert.equal(parseWorkerMessage("not json"), undefined);
	assert.equal(parseWorkerMessage("null"), undefined);
	assert.equal(parseWorkerMessage(JSON.stringify({ id: "m1" })), undefined);
	assert.equal(parseWorkerMessage(JSON.stringify({ body: "hi" })), undefined);

	const recovered = parseWorkerMessage(JSON.stringify({ id: "m1", body: "hi", delivery: "nonsense", deliverAs: "nonsense" }));
	assert.equal(recovered?.delivery, "queued");
	assert.equal(recovered?.deliverAs, "steer");
});

test("the worker-facing frame states the author before the content", () => {
	const human = buildWorkerMessage({ body: "carry on" })!;
	assert.equal(formatWorkerMessageForSession(human), "[docket · from you]\ncarry on");

	const agent = buildWorkerMessage({ body: "http/retry.ts", from: "parent-agent" })!;
	assert.match(formatWorkerMessageForSession(agent), /^\[docket · from parent agent\]/);
});

test("the frame carries the question an answer resolves, clipped", () => {
	const message = buildWorkerMessage({ body: "yes", replyTo: "q1", replyToText: `${"x".repeat(200)}` })!;
	const framed = formatWorkerMessageForSession(message, { maxQuestion: 20 });

	assert.match(framed, /re: x{19}…\]/);
});

test("write, list, and claim move a message through observed states", async () => {
	const root = await tempRoot();
	try {
		const first = buildWorkerMessage({ body: "one" })!;
		const second = buildWorkerMessage({ body: "two", replyTo: "q1" })!;
		await writeWorkerMessage(root, "w1", first);
		await writeWorkerMessage(root, "w1", second);

		assert.equal((await listWorkerMessages(root, "w1")).length, 2);
		assert.deepEqual((await listWorkerMessages(root, "w1")).map((m) => m.delivery), ["queued", "queued"]);

		const claimed = await claimPendingWorkerMessages(root, "w1", "2026-01-01T00:00:00.000Z");
		assert.deepEqual(claimed.map((m) => m.body), ["one", "two"]);
		assert.deepEqual(claimed.map((m) => m.delivery), ["delivered", "delivered"]);

		// Claiming is what makes delivery observed, so a second sweep must find nothing.
		assert.deepEqual(await claimPendingWorkerMessages(root, "w1"), []);

		await markWorkerMessagesRead(root, "w1", claimed.map((m) => m.id), "2026-01-01T00:00:05.000Z");
		const after = await listWorkerMessages(root, "w1");
		assert.deepEqual(after.map((m) => m.delivery), ["read", "read"]);
		assert.equal(after[0]?.readAt, "2026-01-01T00:00:05.000Z");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("read never advances a message the worker has not taken", async () => {
	const root = await tempRoot();
	try {
		const message = buildWorkerMessage({ body: "one" })!;
		await writeWorkerMessage(root, "w1", message);

		await markWorkerMessagesRead(root, "w1", [message.id]);

		assert.equal((await listWorkerMessages(root, "w1"))[0]?.delivery, "queued");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the inbox scan ignores files it did not write", async () => {
	const root = await tempRoot();
	try {
		await mkdir(workerInboxDir(root, "w1"), { recursive: true });
		await writeFile(path.join(workerInboxDir(root, "w1"), "notes.txt"), "unrelated", "utf8");
		await writeFile(path.join(workerInboxDir(root, "w1"), "msg-bad.json"), "{ broken", "utf8");
		await writeWorkerMessage(root, "w1", buildWorkerMessage({ body: "real" })!);

		const messages = await listWorkerMessages(root, "w1");
		assert.deepEqual(messages.map((m) => m.body), ["real"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a missing inbox reads as empty rather than throwing", async () => {
	const root = await tempRoot();
	try {
		assert.deepEqual(await listWorkerMessages(root, "never-spoken-to"), []);
		assert.equal(readWorkerMessageSync(root, "never-spoken-to", "msg-1"), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("stored messages are readable synchronously for live chip rendering", async () => {
	const root = await tempRoot();
	try {
		const message = buildWorkerMessage({ body: "one" })!;
		await writeWorkerMessage(root, "w1", message);
		await claimPendingWorkerMessages(root, "w1");

		assert.equal(readWorkerMessageSync(root, "w1", message.id)?.delivery, "delivered");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("queued messages held by a stopped worker project as undeliverable", () => {
	const queued = buildWorkerMessage({ body: "one" })!;

	assert.equal(projectWorkerMessageDelivery(queued, false), "queued");
	assert.equal(projectWorkerMessageDelivery(queued, true), "undeliverable");
	assert.equal(projectWorkerMessageDelivery({ ...queued, delivery: "read" }, true), "read");
});

test("the dock stays silent while delivery is proceeding normally", () => {
	const delivered: WorkerMessage = { ...buildWorkerMessage({ body: "one" })!, delivery: "delivered" };

	assert.equal(pendingWorkerMessageLine([], false), undefined);
	assert.equal(pendingWorkerMessageLine([delivered], false), undefined);
	assert.match(pendingWorkerMessageLine([buildWorkerMessage({ body: "one" })!], false)!, /^1 message queued/);
	assert.match(pendingWorkerMessageLine([buildWorkerMessage({ body: "one" })!], true)!, /undeliverable/);
});

test("a chip reports the transport it actually used", () => {
	const message = buildWorkerMessage({ body: "one" })!;

	assert.equal(sentWorkerMessageStateLabel("inbox", undefined), "queued");
	assert.equal(sentWorkerMessageStateLabel("inbox", { ...message, delivery: "read" }), "read");
	assert.equal(sentWorkerMessageStateLabel("tmux", undefined), "sent to terminal · receipt unconfirmed");
	assert.match(sentWorkerMessageTimeline("tmux", undefined)!, /cannot confirm receipt/);
	assert.match(sentWorkerMessageTimeline("inbox", message)!, /^queued /);
	assert.equal(sentWorkerMessageTimeline("inbox", undefined), undefined);
});

test("a collapsed body stays one line and admits there is more", () => {
	assert.equal(collapseWorkerMessageBody("one line"), "one line");
	assert.equal(collapseWorkerMessageBody("first\nsecond"), "first …");
	assert.equal(collapseWorkerMessageBody("x".repeat(200), 10), `${"x".repeat(9)}…`);
});

test("a message survives on disk exactly as it was written", async () => {
	const root = await tempRoot();
	try {
		const message = buildWorkerMessage({ body: "line one\nline two", replyTo: "q1", replyToText: "Which?" })!;
		await writeWorkerMessage(root, "w1", message);

		const raw = await readFile(path.join(workerInboxDir(root, "w1"), `${message.id}.json`), "utf8");
		assert.deepEqual(parseWorkerMessage(raw), message);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
