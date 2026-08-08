import { randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Durable parent → worker channel (ADR-0008).
 *
 * The parent writes one JSON file per message into the worker's inbox; the worker's runtime
 * claims it, hands the body to its own session, and rewrites the file with what it observed.
 * Both sides append `message` events, so every live surface reads delivery state from the
 * stream it already watches.
 *
 * The transport this replaces — `tmux send-keys` — could only report that keystrokes were
 * accepted by a terminal. Nothing above it could tell a delivered message from a lost one, so
 * every layer inherited a claim no layer had verified. Delivery state here is only ever
 * written by the side that observed it.
 */

export const WORKER_INBOX_DIR = "inbox";
const MESSAGE_FILE_PREFIX = "msg-";
const MESSAGE_FILE_SUFFIX = ".json";

/** `directive` is an unprompted instruction; `answer` resolves a specific worker question. */
export type WorkerMessageKind = "directive" | "answer";

/**
 * Where the message lands in the worker's agent loop. Pi owns this timing, which is the
 * reason the mailbox exists: keystrokes raced the worker's editor state, `deliverAs` does not.
 * P2 adds `nextTurn` for broadcasts, which must not interrupt at all.
 */
export type WorkerMessageDeliverAs = "steer" | "followUp";

/** Author, and therefore how much authority the body carries. Never inferred, never omitted. */
export type WorkerMessageAuthor = "human" | "parent-agent";

export type WorkerMessageDelivery = "queued" | "delivered" | "read" | "undeliverable";

/**
 * `inbox` is the observed channel. `tmux` is the legacy keystroke path, kept for workers whose
 * runtime predates the mailbox; nothing downstream can observe receipt on it, and every surface
 * that reports it says so rather than borrowing the language of a delivered message.
 */
export type WorkerMessageTransport = "inbox" | "tmux";

export type WorkerMessage = {
	id: string;
	kind: WorkerMessageKind;
	from: WorkerMessageAuthor;
	body: string;
	/** Question id this answers. Resolves that question alone; others stay open. */
	replyTo?: string;
	/** Question text as it stood when the answer was written, for the worker-facing header. */
	replyToText?: string;
	deliverAs: WorkerMessageDeliverAs;
	createdAt: string;
	delivery: WorkerMessageDelivery;
	deliveredAt?: string;
	readAt?: string;
};

export type WorkerMessageInput = {
	body: string;
	kind?: WorkerMessageKind;
	from?: WorkerMessageAuthor;
	replyTo?: string;
	replyToText?: string;
	deliverAs?: WorkerMessageDeliverAs;
};

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

let messageSequence = 0;

/**
 * Sortable id: fixed-width epoch millis keep lexicographic filename order equal to
 * chronological order, so the worker drains its inbox in the order the parent wrote it
 * without parsing or stat-ing anything.
 *
 * The sequence counter breaks same-millisecond ties. Without it two messages written in one
 * tick would be ordered by their random suffix, which is how a follow-up could be delivered
 * ahead of the message it follows up on.
 */
export function newWorkerMessageId(now = Date.now(), entropy = randomBytes(3).toString("hex")): string {
	const sequence = String(messageSequence++ % 1_000_000).padStart(6, "0");
	return `${MESSAGE_FILE_PREFIX}${String(now).padStart(13, "0")}-${sequence}-${entropy}`;
}

export function isWorkerMessageFile(name: string): boolean {
	return name.startsWith(MESSAGE_FILE_PREFIX) && name.endsWith(MESSAGE_FILE_SUFFIX);
}

export function buildWorkerMessage(input: WorkerMessageInput, options: { now?: number; id?: string } = {}): WorkerMessage | undefined {
	const body = input.body.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, "");
	if (!body) return undefined;
	const now = options.now ?? Date.now();
	return {
		id: options.id ?? newWorkerMessageId(now),
		kind: input.kind ?? (input.replyTo ? "answer" : "directive"),
		from: input.from ?? "human",
		body,
		...(input.replyTo ? { replyTo: input.replyTo } : {}),
		...(input.replyToText ? { replyToText: input.replyToText } : {}),
		deliverAs: input.deliverAs ?? "steer",
		createdAt: new Date(now).toISOString(),
		delivery: "queued",
	};
}

/** Defensive parse: the inbox is scanned, so an unrelated or half-written file must not throw. */
export function parseWorkerMessage(raw: string): WorkerMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id : undefined;
	const body = typeof record.body === "string" ? record.body : undefined;
	if (!id || !body) return undefined;
	const delivery = record.delivery;
	return {
		id,
		body,
		kind: record.kind === "answer" ? "answer" : "directive",
		from: record.from === "parent-agent" ? "parent-agent" : "human",
		...(typeof record.replyTo === "string" ? { replyTo: record.replyTo } : {}),
		...(typeof record.replyToText === "string" ? { replyToText: record.replyToText } : {}),
		deliverAs: record.deliverAs === "followUp" ? "followUp" : "steer",
		createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
		delivery: delivery === "delivered" || delivery === "read" || delivery === "undeliverable" ? delivery : "queued",
		...(typeof record.deliveredAt === "string" ? { deliveredAt: record.deliveredAt } : {}),
		...(typeof record.readAt === "string" ? { readAt: record.readAt } : {}),
	};
}

export function isPendingWorkerMessage(message: WorkerMessage): boolean {
	return message.delivery === "queued";
}

export function markWorkerMessageDelivered(message: WorkerMessage, at = new Date().toISOString()): WorkerMessage {
	return { ...message, delivery: "delivered", deliveredAt: at };
}

export function markWorkerMessageRead(message: WorkerMessage, at = new Date().toISOString()): WorkerMessage {
	return { ...message, delivery: "read", readAt: at };
}

export function workerMessageAuthorLabel(from: WorkerMessageAuthor): string {
	return from === "parent-agent" ? "parent agent" : "you";
}

/**
 * The frame the worker actually reads. Authority is stated before content, every time: a worker
 * that mistakes a parent-agent guess for a human decision will build on it with authority the
 * decision never had.
 */
export function formatWorkerMessageForSession(message: WorkerMessage, options: { maxQuestion?: number } = {}): string {
	const maxQuestion = options.maxQuestion ?? 90;
	const question = message.replyToText?.replace(/\s+/g, " ").trim();
	const context = question
		? ` · re: ${question.length > maxQuestion ? `${question.slice(0, maxQuestion - 1)}…` : question}`
		: "";
	return `[docket · from ${workerMessageAuthorLabel(message.from)}${context}]\n${message.body}`;
}

/**
 * Queued messages held by a worker that will never run again are undeliverable. Projected at
 * read time rather than written, so no surface has to keep a terminal worker's inbox in sync.
 */
export function projectWorkerMessageDelivery(message: WorkerMessage, workerIsTerminal: boolean): WorkerMessageDelivery {
	if (workerIsTerminal && message.delivery === "queued") return "undeliverable";
	return message.delivery;
}

export function workerMessageDeliveryLabel(delivery: WorkerMessageDelivery): string {
	if (delivery === "queued") return "queued";
	if (delivery === "delivered") return "delivered";
	if (delivery === "read") return "read";
	return "undeliverable";
}

function clockLabel(iso: string): string {
	const at = new Date(iso);
	return Number.isNaN(at.getTime()) ? "?" : at.toLocaleTimeString();
}

/**
 * What the parent's chip says about one sent message. `live` is the message re-read from disk,
 * so this reports the current fact rather than the one that held when the chip was created.
 */
export function sentWorkerMessageStateLabel(transport: WorkerMessageTransport, live: WorkerMessage | undefined): string {
	if (transport === "tmux") return "sent to terminal · receipt unconfirmed";
	if (!live) return "queued";
	return workerMessageDeliveryLabel(live.delivery);
}

export function sentWorkerMessageTimeline(transport: WorkerMessageTransport, live: WorkerMessage | undefined): string | undefined {
	if (transport === "tmux") return "legacy worker · tmux keystrokes cannot confirm receipt";
	if (!live) return undefined;
	const parts = [`queued ${clockLabel(live.createdAt)}`];
	if (live.deliveredAt) parts.push(`delivered ${clockLabel(live.deliveredAt)}`);
	if (live.readAt) parts.push(`read ${clockLabel(live.readAt)}`);
	return parts.join(" · ");
}

/** Collapsed body: one line that is true on its own, marked when there is more behind it. */
export function collapseWorkerMessageBody(body: string, max = 96): string {
	const lines = body.split("\n");
	const first = (lines[0] ?? "").trim();
	const clipped = first.length > max ? `${first.slice(0, max - 1)}…` : first;
	return lines.length > 1 && !clipped.endsWith("…") ? `${clipped} …` : clipped;
}

/** Dock sub-line for messages a worker has not taken. Silent when delivery is proceeding normally. */
export function pendingWorkerMessageLine(messages: WorkerMessage[], workerIsTerminal: boolean): string | undefined {
	const pending = messages.filter((message) => message.delivery === "queued");
	if (pending.length === 0) return undefined;
	const count = `${pending.length} message${pending.length === 1 ? "" : "s"}`;
	return workerIsTerminal ? `${count} undeliverable · worker is not running` : `${count} queued · not taken yet`;
}

// ---------------------------------------------------------------------------
// Filesystem adapter
// ---------------------------------------------------------------------------

export function workerInboxDir(root: string, workerId: string): string {
	return path.join(root, workerId, WORKER_INBOX_DIR);
}

export function workerMessageFile(root: string, workerId: string, messageId: string): string {
	return path.join(workerInboxDir(root, workerId), `${messageId}${MESSAGE_FILE_SUFFIX}`);
}

async function writeMessageFile(file: string, message: WorkerMessage): Promise<void> {
	const temp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(temp, `${JSON.stringify(message, null, 2)}\n`, "utf8");
	await fs.rename(temp, file);
}

export async function writeWorkerMessage(root: string, workerId: string, message: WorkerMessage): Promise<WorkerMessage> {
	await fs.mkdir(workerInboxDir(root, workerId), { recursive: true });
	await writeMessageFile(workerMessageFile(root, workerId, message.id), message);
	return message;
}

export async function listWorkerMessages(root: string, workerId: string): Promise<WorkerMessage[]> {
	let names: string[];
	try {
		names = await fs.readdir(workerInboxDir(root, workerId));
	} catch {
		return [];
	}
	const messages: WorkerMessage[] = [];
	for (const name of names.filter(isWorkerMessageFile).sort()) {
		try {
			const parsed = parseWorkerMessage(await fs.readFile(path.join(workerInboxDir(root, workerId), name), "utf8"));
			if (parsed) messages.push(parsed);
		} catch {
			// A message being written right now reads as absent; the next sweep picks it up.
		}
	}
	return messages;
}

export function readWorkerMessageSync(root: string, workerId: string, messageId: string): WorkerMessage | undefined {
	try {
		return parseWorkerMessage(fsSync.readFileSync(workerMessageFile(root, workerId, messageId), "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Worker side. Claims every queued message and records delivery before handing anything to the
 * session, so a crash between the two loses a message rather than silently replaying it into a
 * later turn with no trace.
 */
export async function claimPendingWorkerMessages(root: string, workerId: string, at = new Date().toISOString()): Promise<WorkerMessage[]> {
	const claimed: WorkerMessage[] = [];
	for (const message of await listWorkerMessages(root, workerId)) {
		if (!isPendingWorkerMessage(message)) continue;
		const delivered = markWorkerMessageDelivered(message, at);
		try {
			await writeMessageFile(workerMessageFile(root, workerId, message.id), delivered);
			claimed.push(delivered);
		} catch {
			// Leave it queued; it is retried on the next sweep.
		}
	}
	return claimed;
}

export async function markWorkerMessagesRead(root: string, workerId: string, messageIds: string[], at = new Date().toISOString()): Promise<void> {
	for (const messageId of messageIds) {
		try {
			const file = workerMessageFile(root, workerId, messageId);
			const current = parseWorkerMessage(await fs.readFile(file, "utf8"));
			if (!current || current.delivery !== "delivered") continue;
			await writeMessageFile(file, markWorkerMessageRead(current, at));
		} catch {
			// best-effort: read state is an observation, never a gate
		}
	}
}
