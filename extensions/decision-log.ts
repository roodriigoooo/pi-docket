import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { WorkerDeliverablePointer } from "./worker-deliverable.js";

/**
 * Append-only ledger of worker decisions. Two things land here:
 *
 *  - `verdict_resolved` — every time a verdict card resolves (accept / reject /
 *    reject & stop / chat / option-send). Captures what the user saw at the moment
 *    of the call: the verb, the option text, any risk note, and the artifact refs
 *    that were on screen. This is the audit trail for "why did we do that".
 *  - `worker_evicted_unreviewed` — a terminal worker pruned with no verdict ever
 *    recorded for it. That is decision debt: work that aged out before anyone
 *    looked. Counting it keeps automation bias visible.
 *
 * Same NDJSON-under-docket pattern as event-log.ts, kept separate because the
 * checkpoint event log replays into an index and this one never does — it is a
 * pure history we summarize over.
 */

export type DecisionVerb = "accept" | "reject" | "rejectStop" | "chat" | "send";

export type VerdictResolvedEvent = {
	type: "verdict_resolved";
	/** Stable decision identity. Legacy rows may not have one. */
	id?: string;
	timestamp: string;
	workerId: string;
	workerLabel: string;
	/** Derived worker state when the verdict opened (needs_input / ready / failed / …). */
	state: string;
	verb: DecisionVerb;
	/** Option text for a send, the reply text for a chat/steer, otherwise omitted. */
	option?: string;
	/** Risk line shown on the card, if the worker surfaced one. */
	risk?: string;
	/** Artifact refs visible on the card at decision time (change set, status, …). */
	evidenceRefs: string[];
	/** Exact immutable generation judged by this verdict. Omitted on legacy rows. */
	deliverableId?: string;
	deliverableVersion?: number;
	deliverableRef?: string;
	/** Multiline revision note; never mutates deliverable body. */
	reviewNote?: string;
	task?: string;
};

export type WorkerEvictedUnreviewedEvent = {
	type: "worker_evicted_unreviewed";
	timestamp: string;
	workerId: string;
	workerLabel: string;
	state: string;
	reason: "pruned";
	task?: string;
};

export type DecisionEvent = VerdictResolvedEvent | WorkerEvictedUnreviewedEvent;

/** What callers hand us; the log stamps `type` and `timestamp`. */
export type DecisionRecord = Omit<VerdictResolvedEvent, "type" | "timestamp">;
export type EvictionRecord = Omit<WorkerEvictedUnreviewedEvent, "type" | "timestamp" | "reason">;

function sameDeliverable(event: VerdictResolvedEvent, pointer: WorkerDeliverablePointer): boolean {
	return event.deliverableId === pointer.id && event.deliverableVersion === pointer.version && event.deliverableRef === pointer.ref;
}

/** Latest terminal judgment for one immutable deliverable generation. */
export function latestDeliverableJudgment(events: DecisionEvent[], pointer: WorkerDeliverablePointer): VerdictResolvedEvent | undefined {
	let latest: VerdictResolvedEvent | undefined;
	let latestTimestamp = Number.NEGATIVE_INFINITY;
	for (const event of events) {
		if (event.type !== "verdict_resolved" || !sameDeliverable(event, pointer)) continue;
		if (event.verb !== "accept" && event.verb !== "reject" && event.verb !== "rejectStop") continue;
		const timestamp = Date.parse(event.timestamp);
		// Same-millisecond ledger rows retain append order: later row wins.
		if (!latest || !Number.isFinite(latestTimestamp) || !Number.isFinite(timestamp) || timestamp >= latestTimestamp) {
			latest = event;
			latestTimestamp = timestamp;
		}
	}
	return latest;
}

/** Approval is generation-bound; needs_input accepts and failed retries never qualify. */
export function isDeliverableApproved(events: DecisionEvent[], pointer: WorkerDeliverablePointer): boolean {
	const judgment = latestDeliverableJudgment(events, pointer);
	return judgment?.verb === "accept" && (judgment.state === "ready" || judgment.state === "ready_open_todos");
}

/** Alias named after review language used in Docket docs. */
export const latestJudgmentForDeliverable = latestDeliverableJudgment;

/** Deliverable refs with a recorded terminal judgment; useful for generation-aware pruning. */
export function reviewedDeliverableRefs(events: DecisionEvent[]): Set<string> {
	const refs = new Set<string>();
	for (const event of events) {
		if (event.type !== "verdict_resolved") continue;
		if (!event.deliverableRef) continue;
		if (event.verb === "accept" || event.verb === "reject" || event.verb === "rejectStop") refs.add(event.deliverableRef);
	}
	return refs;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const VERB_LABELS: Record<DecisionVerb, string> = {
	accept: "accept",
	reject: "reject",
	rejectStop: "reject & stop",
	chat: "chat",
	send: "option",
};

export function verbLabel(verb: DecisionVerb): string {
	return VERB_LABELS[verb] ?? verb;
}

/** Worker ids that have at least one recorded verdict — i.e. were reviewed. */
export function reviewedWorkerIds(events: DecisionEvent[]): Set<string> {
	const ids = new Set<string>();
	for (const event of events) {
		if (event.type === "verdict_resolved") ids.add(event.workerId);
	}
	return ids;
}

export type DecisionSummary = {
	/** Resolved verdicts within the window. */
	reviewed: number;
	/** Terminal workers pruned unreviewed within the window. */
	unreviewedEvictions: number;
	byVerb: Record<DecisionVerb, number>;
	windowDays: number;
};

function emptyVerbCounts(): Record<DecisionVerb, number> {
	return { accept: 0, reject: 0, rejectStop: 0, chat: 0, send: 0 };
}

function withinWindow(timestamp: string, since: number): boolean {
	const ts = Date.parse(timestamp);
	// Unparseable timestamps count as in-window so a malformed line never hides a decision.
	return !Number.isFinite(ts) || ts >= since;
}

export function summarizeDecisions(events: DecisionEvent[], now: number = Date.now(), windowMs: number = WEEK_MS): DecisionSummary {
	const since = now - windowMs;
	const byVerb = emptyVerbCounts();
	let reviewed = 0;
	let unreviewedEvictions = 0;
	for (const event of events) {
		if (!withinWindow(event.timestamp, since)) continue;
		if (event.type === "verdict_resolved") {
			byVerb[event.verb]++;
			reviewed++;
		} else if (event.type === "worker_evicted_unreviewed") {
			unreviewedEvictions++;
		}
	}
	return { reviewed, unreviewedEvictions, byVerb, windowDays: Math.max(1, Math.round(windowMs / DAY_MS)) };
}

/** One-line dock summary, or undefined when there is no decision debt worth flagging. */
export function decisionDebtLine(summary: DecisionSummary): string | undefined {
	if (summary.unreviewedEvictions <= 0) return undefined;
	const workers = summary.unreviewedEvictions === 1 ? "worker" : "workers";
	return `${summary.unreviewedEvictions} ${workers} evicted unreviewed this week`;
}

function relativeStamp(timestamp: string, now: number): string {
	const ts = Date.parse(timestamp);
	if (!Number.isFinite(ts)) return timestamp;
	const diff = Math.max(0, now - ts);
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / DAY_MS)}d ago`;
}

function formatEventLine(event: DecisionEvent, now: number): string {
	const when = relativeStamp(event.timestamp, now);
	if (event.type === "worker_evicted_unreviewed") {
		const task = event.task ? ` · ${event.task}` : "";
		return `${when}  ${event.workerLabel}  evicted unreviewed (${event.state})${task}`;
	}
	const option = event.option ? ` "${event.option}"` : "";
	const risk = event.risk ? `  ⚠ ${event.risk}` : "";
	const evidence = event.evidenceRefs.length > 0 ? `  [${event.evidenceRefs.join(", ")}]` : "";
	const version = event.deliverableRef ? `  [${event.deliverableRef}]` : "";
	return `${when}  ${event.workerLabel}  ${verbLabel(event.verb)}${option}  (${event.state})${risk}${version}${evidence}`;
}

/** Human-readable decisions audit for `/docket log decisions`. Pure: easy to test. */
export function renderDecisionLog(events: DecisionEvent[], now: number = Date.now(), recent = 25): string {
	const summary = summarizeDecisions(events, now);
	const lines: string[] = [];
	lines.push(`Decisions · last ${summary.windowDays} days`);
	lines.push(`  ${summary.reviewed} resolved · ${summary.unreviewedEvictions} evicted unreviewed`);
	const verbBits = (Object.keys(summary.byVerb) as DecisionVerb[])
		.filter((verb) => summary.byVerb[verb] > 0)
		.map((verb) => `${verbLabel(verb)} ${summary.byVerb[verb]}`);
	if (verbBits.length > 0) lines.push(`  ${verbBits.join(" · ")}`);
	const debt = decisionDebtLine(summary);
	if (debt) lines.push(`  decision debt: ${debt}`);
	lines.push("");
	if (events.length === 0) {
		lines.push("No decisions recorded yet. Resolve a worker with /docket verdict to start the ledger.");
		return lines.join("\n");
	}
	const ordered = [...events].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, recent);
	lines.push(`Recent (${ordered.length} of ${events.length}):`);
	for (const event of ordered) lines.push(`  ${formatEventLine(event, now)}`);
	return lines.join("\n");
}

export type DecisionLog = {
	path(): string;
	append(event: DecisionEvent): Promise<void>;
	read(): Promise<DecisionEvent[]>;
	recordVerdict(record: DecisionRecord): Promise<void>;
	recordEviction(record: EvictionRecord): Promise<void>;
};

function decisionLogFile(): string {
	return path.join(getAgentDir(), "docket", "decisions.ndjson");
}

async function ensureParent(file: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
}

async function fileExists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

function parseLine(line: string): DecisionEvent | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as Partial<DecisionEvent> & { type?: string };
		if (parsed.type !== "verdict_resolved" && parsed.type !== "worker_evicted_unreviewed") return undefined;
		return parsed as DecisionEvent;
	} catch {
		return undefined;
	}
}

export function createDecisionLog(): DecisionLog {
	const file = decisionLogFile();
	return {
		path() {
			return file;
		},
		async append(event: DecisionEvent): Promise<void> {
			await ensureParent(file);
			await fs.appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
		},
		async read(): Promise<DecisionEvent[]> {
			if (!(await fileExists(file))) return [];
			const raw = await fs.readFile(file, "utf8");
			const events: DecisionEvent[] = [];
			for (const line of raw.split("\n")) {
				const event = parseLine(line);
				if (event) events.push(event);
			}
			return events;
		},
		async recordVerdict(record: DecisionRecord): Promise<void> {
			await this.append({ type: "verdict_resolved", timestamp: new Date().toISOString(), ...record, id: record.id ?? randomUUID() });
		},
		async recordEviction(record: EvictionRecord): Promise<void> {
			await this.append({ type: "worker_evicted_unreviewed", timestamp: new Date().toISOString(), reason: "pruned", ...record });
		},
	};
}
