import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { isTerminalDecisionVerb, type DecisionEvent, type VerdictResolvedEvent } from "./decision-log.js";
import type { WorkerStatus } from "./background-work.js";
import {
	sameWorkerDeliverablePointer,
	workerDeliverablePointer,
	type WorkerDeliverable,
	type WorkerDeliverableChangeSet,
	type WorkerDeliverablePointer,
	type DeliverableHandoffProvenance,
} from "./worker-deliverable.js";
import type { ArtifactSummary, Artifact, GitSnapshot } from "./types.js";

export const STORED_DELIVERABLE_SCHEMA_VERSION = 1 as const;

export type StoredReviewNote = {
	text: string;
	createdAt: string;
	decisionId?: string;
};

export type StoredWorkerSource = {
	kind: "worker";
	workerDeliverable: WorkerDeliverablePointer;
	workerId: string;
	workerLabel: string;
	task: string;
	createdAt: string;
	workerGeneration: number;
	cwd?: string;
	model?: string;
	thinking?: WorkerStatus["thinking"];
	runToken?: string;
	sessionFile?: string;
	git?: GitSnapshot;
};

export type StoredParentSource = {
	kind: "parent";
	createdAt: string;
	sessionFile?: string;
	cwd: string;
	selectedArtifact: ArtifactSummary;
};

export type StoredDeliverableSource = StoredWorkerSource | StoredParentSource;

export type StoredWorkerApproval = {
	kind: "worker";
	decisionId: string;
	decidedAt: string;
	verdict: "accept";
	workerDeliverable: WorkerDeliverablePointer;
	/** Exact accepted ledger event when the lifecycle saved the record. */
	decision: VerdictResolvedEvent;
};

export type StoredHumanApproval = {
	kind: "human";
	decisionId: string;
	decidedAt: string;
	reason: "parent-authorship";
};

export type StoredDeliverableApproval = StoredWorkerApproval | StoredHumanApproval;

export type StoredDeliverable = {
	schemaVersion: typeof STORED_DELIVERABLE_SCHEMA_VERSION;
	id: string;
	version: number;
	ref: string;
	/** Source creation time. */
	createdAt: string;
	/** Time this durable copy was saved. */
	savedAt: string;
	body: string;
	summary: string;
	outcome: WorkerDeliverable["outcome"];
	evidence: string[];
	recommendations: string[];
	refs: ArtifactSummary[];
	changeSet?: WorkerDeliverableChangeSet;
	source: StoredDeliverableSource;
	reviewNotes: StoredReviewNote[];
	approval: StoredDeliverableApproval;
	handoffProvenance?: DeliverableHandoffProvenance;
};

export type DeliverableSaveResult = {
	deliverable: StoredDeliverable;
	idempotent: boolean;
};

export type WorkerDeliverableSaveInput = {
	deliverable: WorkerDeliverable;
	worker?: WorkerStatus;
	approval: StoredWorkerApproval;
	reviewNotes?: StoredReviewNote[];
	savedAt?: string;
};

export type ParentDeliverableSaveInput = {
	body: string;
	summary: string;
	outcome: WorkerDeliverable["outcome"];
	evidence?: string[];
	recommendations?: string[];
	refs?: ArtifactSummary[];
	changeSet?: WorkerDeliverableChangeSet;
	sessionFile?: string;
	cwd: string;
	selectedArtifact: ArtifactSummary;
	handoffProvenance?: DeliverableHandoffProvenance;
	createdAt?: string;
	savedAt?: string;
	id?: string;
};

export type DeliverableStore = {
	root(): string;
	dirFor(id: string): string;
	fileFor(id: string, version: number): string;
	read(idOrRef: string, version?: number): Promise<StoredDeliverable | undefined>;
	find(idOrRef: string): Promise<StoredDeliverable | undefined>;
	list(): Promise<StoredDeliverable[]>;
	/** Records this build cannot load — surfaced so a schema bump never orphans work silently. */
	listUnsupported(): Promise<UnsupportedDeliverable[]>;
	save(input: StoredDeliverable): Promise<DeliverableSaveResult>;
	saveWorker(input: WorkerDeliverableSaveInput): Promise<DeliverableSaveResult>;
	saveParent(input: ParentDeliverableSaveInput): Promise<DeliverableSaveResult>;
	delete(deliverable: StoredDeliverable): Promise<boolean>;
};

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,95}$/i;

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function defaultRoot(): string {
	return path.join(getAgentDir(), "docket", "deliverables");
}

function cleanIdPart(value: string, fallback = "deliverable"): string {
	const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
	return (cleaned || fallback).slice(0, 72);
}

function isSafeId(value: string): boolean {
	return SAFE_ID.test(value);
}

function parseDeliverableRef(value: string): { id: string; version: number } | undefined {
	const match = /^deliverable:([a-z0-9][a-z0-9_-]{0,95}):(\d+)$/i.exec(value);
	if (!match) return undefined;
	const version = Number(match[2]);
	return Number.isSafeInteger(version) && version > 0 ? { id: match[1]!, version } : undefined;
}

function assertSafeId(id: string): void {
	if (!isSafeId(id)) throw new Error(`Invalid deliverable id: ${id}`);
}

function assertVersion(version: number): void {
	if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Invalid deliverable version: ${version}`);
}

/** Stable, collision-resistant path id for a worker-backed durable copy. */
export function safeDeliverableIdFromWorker(workerId: string): string {
	const source = workerId.trim();
	const digest = createHash("sha256").update(source).digest("hex").slice(0, 10);
	return `worker-${cleanIdPart(source)}-${digest}`.slice(0, 96);
}

/** Parent ids are intentionally unique even when two saves happen in one millisecond. */
export function makeParentDeliverableId(now = new Date(), entropy = randomBytes(6).toString("hex")): string {
	const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
	return `parent-${stamp}-${cleanIdPart(entropy, "entropy")}`;
}

export function storedDeliverableRef(id: string, version: number): string {
	return `deliverable:${id}:${version}`;
}

function versionFromName(name: string): number | undefined {
	const match = /^v(\d+)\.json$/.exec(name);
	if (!match) return undefined;
	const version = Number(match[1]);
	return Number.isSafeInteger(version) && version > 0 ? version : undefined;
}

function cleanStrings(values: string[] | undefined): string[] {
	return (values ?? []).map((value) => String(value)).filter((value) => value.length > 0);
}

function cleanRefs(values: ArtifactSummary[] | undefined): ArtifactSummary[] {
	return (values ?? []).map((ref) => ({
		displayId: String(ref.displayId ?? ""),
		ref: String(ref.ref ?? ""),
		kind: ref.kind,
		title: String(ref.title ?? ""),
		subtitle: String(ref.subtitle ?? ""),
		...(ref.timestamp === undefined ? {} : { timestamp: ref.timestamp }),
	}));
}

function validArtifactSummary(value: unknown): value is ArtifactSummary {
	if (!value || typeof value !== "object") return false;
	const ref = value as Partial<ArtifactSummary>;
	return typeof ref.displayId === "string"
		&& typeof ref.ref === "string"
		&& ["command", "error", "file", "code", "prompt", "response", "checkpoint"].includes(ref.kind ?? "")
		&& typeof ref.title === "string"
		&& typeof ref.subtitle === "string"
		&& (ref.timestamp === undefined || typeof ref.timestamp === "number");
}

function validGitSnapshot(value: unknown): value is GitSnapshot {
	if (value === undefined) return true;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const git = value as GitSnapshot;
	return (git.branch === undefined || typeof git.branch === "string")
		&& (git.head === undefined || typeof git.head === "string")
		&& [git.dirty, git.staged, git.unstaged, git.untracked].every((count) => count === undefined || (Number.isSafeInteger(count) && count >= 0));
}

function validPointer(value: unknown): value is WorkerDeliverablePointer {
	if (!value || typeof value !== "object") return false;
	const pointer = value as Partial<WorkerDeliverablePointer>;
	return typeof pointer.id === "string" && pointer.id.startsWith("worker-deliverable:") && !/[\\/]/.test(pointer.id)
		&& typeof pointer.version === "number" && Number.isSafeInteger(pointer.version) && pointer.version > 0
		&& typeof pointer.ref === "string" && pointer.ref === `${pointer.id}:${pointer.version}`;
}

function validChangeSet(value: unknown): value is WorkerDeliverableChangeSet {
	if (value === undefined) return true;
	if (!value || typeof value !== "object") return false;
	const changeSet = value as Partial<WorkerDeliverableChangeSet>;
	return typeof changeSet.ref === "string"
		&& typeof changeSet.stat === "string"
		&& typeof changeSet.patch === "string"
		&& typeof changeSet.hunkCount === "number" && Number.isSafeInteger(changeSet.hunkCount) && changeSet.hunkCount >= 0
		&& Array.isArray(changeSet.files)
		&& changeSet.files.every((file) => file
			&& typeof file.path === "string"
			&& (file.additions === undefined || (Number.isSafeInteger(file.additions) && file.additions >= 0))
			&& (file.deletions === undefined || (Number.isSafeInteger(file.deletions) && file.deletions >= 0)));
}

function validHandoff(value: unknown): value is DeliverableHandoffProvenance {
	if (value === undefined) return true;
	if (!value || typeof value !== "object") return false;
	const provenance = value as Partial<DeliverableHandoffProvenance>;
	return typeof provenance.sourceDeliverableId === "string"
		&& typeof provenance.sourceVersion === "number" && Number.isSafeInteger(provenance.sourceVersion) && provenance.sourceVersion > 0
		&& typeof provenance.sourceRef === "string"
		&& (provenance.sourceKind === undefined || provenance.sourceKind === "worker" || provenance.sourceKind === "parent")
		&& (provenance.sourceWorkerId === undefined || typeof provenance.sourceWorkerId === "string")
		&& (provenance.sourceWorkerLabel === undefined || typeof provenance.sourceWorkerLabel === "string")
		&& (provenance.sourceSessionFile === undefined || typeof provenance.sourceSessionFile === "string")
		&& (provenance.sourceCwd === undefined || typeof provenance.sourceCwd === "string")
		&& typeof provenance.approvingDecisionId === "string"
		&& typeof provenance.approvedAt === "string"
		&& typeof provenance.sidecarPath === "string";
}

const DELIVERABLE_OUTCOMES: string[] = ["completed", "findings", "proposal", "no_evidence"];
const APPROVED_VERDICT_STATES: string[] = ["ready", "ready_open_todos"];

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function validReviewNote(value: unknown): value is StoredReviewNote {
	if (!value || typeof value !== "object") return false;
	const note = value as Partial<StoredReviewNote>;
	return typeof note.text === "string" && typeof note.createdAt === "string" && optionalString(note.decisionId);
}

/** Field shape of a worker source, independent of the record carrying it. */
function workerSourceIssues(source: Partial<StoredWorkerSource>): string[] {
	const issues: string[] = [];
	if (!validPointer(source.workerDeliverable)) issues.push("source.workerDeliverable");
	if (typeof source.workerId !== "string") issues.push("source.workerId");
	if (typeof source.workerLabel !== "string") issues.push("source.workerLabel");
	if (typeof source.task !== "string") issues.push("source.task");
	if (!Number.isSafeInteger(source.workerGeneration) || Number(source.workerGeneration) < 1) issues.push("source.workerGeneration");
	for (const field of ["cwd", "model", "thinking", "runToken", "sessionFile"] as const) {
		if (!optionalString(source[field])) issues.push(`source.${field}`);
	}
	if (!validGitSnapshot(source.git)) issues.push("source.git");
	return issues;
}

function parentSourceIssues(source: Partial<StoredParentSource>): string[] {
	const issues: string[] = [];
	if (typeof source.cwd !== "string") issues.push("source.cwd");
	if (!optionalString(source.sessionFile)) issues.push("source.sessionFile");
	if (!validArtifactSummary(source.selectedArtifact)) issues.push("source.selectedArtifact");
	return issues;
}

/** A worker approval carries the exact accepted ledger event for the generation it names. */
function validWorkerApproval(approval: Partial<StoredWorkerApproval>): string[] {
	const issues: string[] = [];
	if (typeof approval.decisionId !== "string") issues.push("approval.decisionId");
	if (typeof approval.decidedAt !== "string") issues.push("approval.decidedAt");
	if (approval.verdict !== "accept") issues.push("approval.verdict");
	const pointer = validPointer(approval.workerDeliverable) ? approval.workerDeliverable : undefined;
	if (!pointer) issues.push("approval.workerDeliverable");
	const decision = approval.decision as Partial<VerdictResolvedEvent> | undefined;
	if (!decision || typeof decision !== "object") return [...issues, "approval.decision"];
	if (decision.type !== "verdict_resolved") issues.push("approval.decision.type");
	if (!APPROVED_VERDICT_STATES.includes(decision.state ?? "")) issues.push("approval.decision.state");
	if (decision.verb !== "accept") issues.push("approval.decision.verb");
	const idMatches = decision.id === undefined
		? typeof approval.decisionId === "string" && approval.decisionId.startsWith("legacy-approval:")
		: decision.id === approval.decisionId;
	if (!idMatches) issues.push("approval.decision.id");
	if (decision.timestamp !== approval.decidedAt) issues.push("approval.decision.timestamp");
	if (pointer) {
		if (decision.deliverableId !== pointer.id) issues.push("approval.decision.deliverableId");
		if (decision.deliverableVersion !== pointer.version) issues.push("approval.decision.deliverableVersion");
		if (decision.deliverableRef !== pointer.ref) issues.push("approval.decision.deliverableRef");
	}
	if (typeof decision.workerId !== "string") issues.push("approval.decision.workerId");
	if (typeof decision.workerLabel !== "string") issues.push("approval.decision.workerLabel");
	if (typeof decision.task !== "string") issues.push("approval.decision.task");
	if (!optionalString(decision.reviewNote)) issues.push("approval.decision.reviewNote");
	if (!Array.isArray(decision.evidenceRefs) || !decision.evidenceRefs.every((ref) => typeof ref === "string")) issues.push("approval.decision.evidenceRefs");
	return issues;
}

function validHumanApproval(approval: Partial<StoredHumanApproval>, item: Partial<StoredDeliverable>): string[] {
	const issues: string[] = [];
	if (approval.reason !== "parent-authorship") issues.push("approval.reason");
	if (typeof approval.decisionId !== "string" || approval.decisionId !== `human-authorship:${item.id}`) issues.push("approval.decisionId");
	if (typeof approval.decidedAt !== "string" || approval.decidedAt !== item.savedAt) issues.push("approval.decidedAt");
	return issues;
}

/** Approval is never widened from one worker generation — or one authorship kind — to another. */
function approvalMatchesSource(source: StoredDeliverableSource, approval: StoredDeliverableApproval): string[] {
	if (source.kind === "parent") return approval.kind === "human" ? [] : ["approval.kind"];
	if (approval.kind !== "worker") return ["approval.kind"];
	const issues: string[] = [];
	if (!sameWorkerDeliverablePointer(source.workerDeliverable, approval.workerDeliverable)) issues.push("approval.workerDeliverable-matches-source");
	if (approval.decision?.workerId !== source.workerId) issues.push("approval.decision.workerId-matches-source");
	if (approval.decision?.workerLabel !== source.workerLabel) issues.push("approval.decision.workerLabel-matches-source");
	if (approval.decision?.task !== source.task) issues.push("approval.decision.task-matches-source");
	return issues;
}

/** Names every failing invariant so save errors and skipped scans stay debuggable. */
export function storedDeliverableIssues(value: unknown): string[] {
	if (!value || typeof value !== "object") return ["not-an-object"];
	const item = value as Partial<StoredDeliverable>;
	const issues: string[] = [];
	if (item.schemaVersion !== STORED_DELIVERABLE_SCHEMA_VERSION) issues.push("schemaVersion");
	if (typeof item.id !== "string" || !isSafeId(item.id)) issues.push("id");
	if (!Number.isSafeInteger(item.version) || Number(item.version) < 1) issues.push("version");
	if (typeof item.id !== "string" || typeof item.version !== "number" || item.ref !== storedDeliverableRef(item.id, item.version)) issues.push("ref");
	if (typeof item.createdAt !== "string") issues.push("createdAt");
	if (typeof item.savedAt !== "string") issues.push("savedAt");
	if (typeof item.body !== "string" || item.body.trim().length === 0) issues.push("body");
	if (typeof item.summary !== "string") issues.push("summary");
	if (!DELIVERABLE_OUTCOMES.includes(item.outcome ?? "")) issues.push("outcome");
	if (!Array.isArray(item.evidence) || !item.evidence.every((entry) => typeof entry === "string")) issues.push("evidence");
	if (!Array.isArray(item.recommendations) || !item.recommendations.every((entry) => typeof entry === "string")) issues.push("recommendations");
	if (!Array.isArray(item.refs) || !item.refs.every(validArtifactSummary)) issues.push("refs");
	if (!validChangeSet(item.changeSet)) issues.push("changeSet");
	if (!Array.isArray(item.reviewNotes) || !item.reviewNotes.every(validReviewNote)) issues.push("reviewNotes");
	if (!validHandoff(item.handoffProvenance)) issues.push("handoffProvenance");

	const source = item.source;
	const approval = item.approval;
	if (!source || typeof source !== "object" || (source.kind !== "worker" && source.kind !== "parent")) return [...issues, "source.kind"];
	if (source.createdAt !== item.createdAt) issues.push("source.createdAt");
	switch (source.kind) {
		case "worker": {
			issues.push(...workerSourceIssues(source));
			if (typeof source.workerId === "string") {
				if (item.id !== safeDeliverableIdFromWorker(source.workerId)) issues.push("id-matches-worker");
				if (source.workerDeliverable?.id !== `worker-deliverable:${source.workerId}`) issues.push("source.workerDeliverable-matches-worker");
			}
			if (source.workerGeneration !== source.workerDeliverable?.version) issues.push("source.workerGeneration-matches-pointer");
			break;
		}
		case "parent": {
			issues.push(...parentSourceIssues(source));
			if (item.version !== 1) issues.push("version-for-parent-source");
			break;
		}
	}

	if (!approval || typeof approval !== "object" || (approval.kind !== "worker" && approval.kind !== "human")) return [...issues, "approval.kind"];
	issues.push(...(approval.kind === "worker" ? validWorkerApproval(approval) : validHumanApproval(approval, item)));
	issues.push(...approvalMatchesSource(source, approval));
	return issues;
}

function isStoredDeliverable(value: unknown): value is StoredDeliverable {
	return storedDeliverableIssues(value).length === 0;
}

/**
 * Read-time upgrades. Entry `n` turns a v`n` record into a v`n+1` record, including its
 * `schemaVersion` field; the chain runs until the record reaches the current version.
 * A record whose version has no registered upgrade is surfaced, never silently dropped.
 */
const STORED_DELIVERABLE_UPGRADES: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {};

function upgradeToCurrentSchema(raw: Record<string, unknown>, schemaVersion: number): Record<string, unknown> | undefined {
	let record = raw;
	let version = schemaVersion;
	while (version < STORED_DELIVERABLE_SCHEMA_VERSION) {
		const upgrade = STORED_DELIVERABLE_UPGRADES[version];
		if (!upgrade) return undefined;
		record = upgrade(record);
		version += 1;
	}
	return version === STORED_DELIVERABLE_SCHEMA_VERSION ? record : undefined;
}

/** A record on disk whose schema this build cannot load, kept visible instead of dropped. */
export type UnsupportedDeliverable = {
	id: string;
	version: number;
	ref: string;
	file: string;
	schemaVersion: number;
	reason: "newer-schema" | "no-upgrade-path";
};

type DeliverableReadResult =
	| { status: "ok"; record: StoredDeliverable }
	| { status: "unsupported"; entry: UnsupportedDeliverable }
	| { status: "skip" };

async function readFileResult(file: string, expectedId: string, expectedVersion: number): Promise<DeliverableReadResult> {
	let raw: unknown;
	try {
		raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
	} catch {
		return { status: "skip" };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: "skip" };
	const schemaVersion = (raw as { schemaVersion?: unknown }).schemaVersion;
	if (!Number.isSafeInteger(schemaVersion) || Number(schemaVersion) < 1) return { status: "skip" };
	const version = Number(schemaVersion);
	const upgraded = upgradeToCurrentSchema(raw as Record<string, unknown>, version);
	if (!upgraded) {
		return {
			status: "unsupported",
			entry: {
				id: expectedId,
				version: expectedVersion,
				ref: storedDeliverableRef(expectedId, expectedVersion),
				file,
				schemaVersion: version,
				reason: version > STORED_DELIVERABLE_SCHEMA_VERSION ? "newer-schema" : "no-upgrade-path",
			},
		};
	}
	if (!isStoredDeliverable(upgraded)) return { status: "skip" };
	if (upgraded.id !== expectedId || upgraded.version !== expectedVersion) return { status: "skip" };
	return { status: "ok", record: upgraded };
}

async function readFileRecord(file: string, expectedId: string, expectedVersion: number): Promise<StoredDeliverable | undefined> {
	const result = await readFileResult(file, expectedId, expectedVersion);
	return result.status === "ok" ? result.record : undefined;
}

export function describeUnsupportedDeliverable(entry: UnsupportedDeliverable): string {
	return entry.reason === "newer-schema"
		? `written by a newer Docket (schema ${entry.schemaVersion} > ${STORED_DELIVERABLE_SCHEMA_VERSION})`
		: `no upgrade path from schema ${entry.schemaVersion}`;
}

async function withDeliverableLock<T>(dir: string, run: () => Promise<T>): Promise<T> {
	const lock = path.join(dir, ".lock");
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	await fs.mkdir(dir, { recursive: true });
	while (true) {
		try {
			await fs.mkdir(lock);
			break;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			try {
				const stat = await fs.stat(lock);
				if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
					await fs.rm(lock, { recursive: true, force: true });
					continue;
				}
			} catch (statErr: any) {
				if (statErr?.code !== "ENOENT") throw statErr;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out acquiring deliverable lock for ${path.basename(dir)}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	try {
		return await run();
	} finally {
		await fs.rm(lock, { recursive: true, force: true });
	}
}

async function pathExists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch (err: any) {
		if (err?.code === "ENOENT") return false;
		throw err;
	}
}

/** Claim a version with a no-replace hard-link after writing its temp file. */
async function writeExclusiveJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await fs.link(temp, file);
	} catch (err: any) {
		if (err?.code === "EEXIST") throw new Error(`Deliverable version already claimed: ${path.basename(file)}`);
		throw err;
	} finally {
		await fs.rm(temp, { force: true });
	}
}

function normalizeReviewNotes(notes: StoredReviewNote[] | undefined): StoredReviewNote[] {
	return (notes ?? []).map((note) => ({
		text: note.text,
		createdAt: note.createdAt,
		...(note.decisionId ? { decisionId: note.decisionId } : {}),
	}));
}

function normalizeStoredRecord(input: StoredDeliverable): StoredDeliverable {
	return {
		...input,
		body: input.body,
		summary: input.summary,
		evidence: cleanStrings(input.evidence),
		recommendations: cleanStrings(input.recommendations),
		refs: cleanRefs(input.refs),
		reviewNotes: normalizeReviewNotes(input.reviewNotes),
	};
}

function sourceFromWorker(deliverable: WorkerDeliverable, worker?: WorkerStatus): StoredWorkerSource {
	const pointer = workerDeliverablePointer(deliverable);
	return {
		kind: "worker",
		workerDeliverable: pointer,
		workerId: deliverable.source.workerId,
		workerLabel: deliverable.source.workerLabel,
		task: deliverable.source.task,
		createdAt: deliverable.createdAt,
		workerGeneration: deliverable.version,
		...(worker?.cwd ? { cwd: worker.cwd } : {}),
		...(deliverable.source.model ? { model: deliverable.source.model } : {}),
		...(deliverable.source.thinking ? { thinking: deliverable.source.thinking } : {}),
		...(deliverable.source.runToken ? { runToken: deliverable.source.runToken } : {}),
		...(deliverable.source.sessionFile ? { sessionFile: deliverable.source.sessionFile } : {}),
		...(worker?.git ? { git: worker.git } : {}),
	};
}

function recordFromWorker(input: WorkerDeliverableSaveInput, savedAt: string): StoredDeliverable {
	const source = sourceFromWorker(input.deliverable, input.worker);
	if (!sameWorkerDeliverablePointer(input.approval.workerDeliverable, source.workerDeliverable)) {
		throw new Error("Worker approval does not match the exact deliverable generation");
	}
	const id = safeDeliverableIdFromWorker(source.workerId);
	return normalizeStoredRecord({
		schemaVersion: STORED_DELIVERABLE_SCHEMA_VERSION,
		id,
		version: source.workerGeneration,
		ref: storedDeliverableRef(id, source.workerGeneration),
		createdAt: input.deliverable.createdAt,
		savedAt,
		body: input.deliverable.body,
		summary: input.deliverable.summary,
		outcome: input.deliverable.outcome,
		evidence: input.deliverable.evidence,
		recommendations: input.deliverable.recommendations,
		refs: input.deliverable.refs,
		...(input.deliverable.changeSet ? { changeSet: input.deliverable.changeSet } : {}),
		source,
		reviewNotes: input.reviewNotes ?? [],
		approval: input.approval,
		...(input.deliverable.sourceHandoff ? { handoffProvenance: input.deliverable.sourceHandoff } : {}),
	});
}

function recordFromParent(input: ParentDeliverableSaveInput): StoredDeliverable {
	const createdAt = input.createdAt ?? new Date().toISOString();
	const savedAt = input.savedAt ?? new Date().toISOString();
	const id = input.id ?? makeParentDeliverableId(new Date(savedAt));
	return normalizeStoredRecord({
		schemaVersion: STORED_DELIVERABLE_SCHEMA_VERSION,
		id,
		version: 1,
		ref: storedDeliverableRef(id, 1),
		createdAt,
		savedAt,
		body: input.body,
		summary: input.summary,
		outcome: input.outcome,
		evidence: input.evidence ?? [],
		recommendations: input.recommendations ?? [],
		refs: input.refs ?? [input.selectedArtifact],
		...(input.changeSet ? { changeSet: input.changeSet } : {}),
		source: { kind: "parent", createdAt, ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}), cwd: input.cwd, selectedArtifact: input.selectedArtifact },
		reviewNotes: [],
		approval: { kind: "human", decisionId: `human-authorship:${id}`, decidedAt: savedAt, reason: "parent-authorship" },
		...(input.handoffProvenance ? { handoffProvenance: input.handoffProvenance } : {}),
	});
}

export function approvedWorkerDecision(events: DecisionEvent[], pointer: WorkerDeliverablePointer): VerdictResolvedEvent | undefined {
	let latest: VerdictResolvedEvent | undefined;
	for (const event of events) {
		if (event.type !== "verdict_resolved") continue;
		if (event.deliverableId !== pointer.id || event.deliverableVersion !== pointer.version || event.deliverableRef !== pointer.ref) continue;
		if (isTerminalDecisionVerb(event.verb)) latest = event;
	}
	if (!latest || latest.verb !== "accept" || !["ready", "ready_open_todos"].includes(latest.state)) return undefined;
	return latest;
}

export function reviewNotesForWorkerDeliverable(events: DecisionEvent[], pointer: WorkerDeliverablePointer): StoredReviewNote[] {
	return events.flatMap((event) => {
		if (event.type !== "verdict_resolved" || event.deliverableId !== pointer.id || event.deliverableVersion !== pointer.version || event.deliverableRef !== pointer.ref || !event.reviewNote) return [];
		return [{ text: event.reviewNote, createdAt: event.timestamp, ...(event.id ? { decisionId: event.id } : {}) }];
	});
}

export function createDeliverableStore(root = defaultRoot()): DeliverableStore {
	const dirFor = (id: string) => {
		assertSafeId(id);
		return path.join(root, id);
	};
	const fileFor = (id: string, version: number) => {
		assertVersion(version);
		return path.join(dirFor(id), `v${version}.json`);
	};

	const read = async (idOrRef: string, version?: number): Promise<StoredDeliverable | undefined> => {
		const parsedRef = parseDeliverableRef(idOrRef);
		const id = parsedRef?.id ?? idOrRef;
		if (!isSafeId(id)) return undefined;
		const selectedVersion = version ?? parsedRef?.version;
		if (selectedVersion !== undefined) {
			if (!Number.isSafeInteger(selectedVersion) || selectedVersion < 1) return undefined;
			return readFileRecord(fileFor(id, selectedVersion), id, selectedVersion);
		}
		const items = await listForId(id);
		return items.at(-1);
	};

	const scanId = async (id: string): Promise<{ records: StoredDeliverable[]; unsupported: UnsupportedDeliverable[] }> => {
		if (!isSafeId(id)) return { records: [], unsupported: [] };
		let names: string[];
		try { names = await fs.readdir(dirFor(id)); } catch { return { records: [], unsupported: [] }; }
		const versions = names.map(versionFromName).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
		const results = await Promise.all(versions.map((version) => readFileResult(fileFor(id, version), id, version)));
		return {
			records: results.flatMap((result) => (result.status === "ok" ? [result.record] : [])),
			unsupported: results.flatMap((result) => (result.status === "unsupported" ? [result.entry] : [])),
		};
	};

	const listForId = async (id: string): Promise<StoredDeliverable[]> => (await scanId(id)).records;

	const scanIds = async (): Promise<{ records: StoredDeliverable[]; unsupported: UnsupportedDeliverable[] }> => {
		let ids: string[];
		try { ids = await fs.readdir(root); } catch { return { records: [], unsupported: [] }; }
		const scans = await Promise.all(ids.filter((id) => !id.startsWith(".") && isSafeId(id)).map((id) => scanId(id)));
		return {
			records: scans.flatMap((scan) => scan.records),
			unsupported: scans.flatMap((scan) => scan.unsupported),
		};
	};

	const save = async (input: StoredDeliverable): Promise<DeliverableSaveResult> => {
		const record = normalizeStoredRecord(input);
		assertSafeId(record.id);
		assertVersion(record.version);
		const issues = storedDeliverableIssues(record);
		if (issues.length) throw new Error(`Invalid stored deliverable: ${issues.join(", ")}`);
		return withDeliverableLock(dirFor(record.id), async () => {
			const file = fileFor(record.id, record.version);
			if (await pathExists(file)) {
				const existing = await readFileResult(file, record.id, record.version);
				if (existing.status === "unsupported") throw new Error(`Deliverable version is claimed by a record this build cannot load (${describeUnsupportedDeliverable(existing.entry)}): ${record.ref}`);
				if (existing.status !== "ok") throw new Error(`Deliverable version is claimed by an invalid or corrupt file: ${record.ref}`);
				const sameWorker = existing.record.source.kind === "worker" && record.source.kind === "worker"
					&& sameWorkerDeliverablePointer(existing.record.source.workerDeliverable, record.source.workerDeliverable);
				if (sameWorker) return { deliverable: existing.record, idempotent: true };
				throw new Error(`Deliverable version already exists: ${record.ref}`);
			}
			await writeExclusiveJson(file, record);
			return { deliverable: record, idempotent: false };
		});
	};

	const store: DeliverableStore = {
		root: () => root,
		dirFor,
		fileFor,
		read,
		async find(idOrRef: string): Promise<StoredDeliverable | undefined> {
			if (idOrRef === "last" || !idOrRef) {
				const all = await store.list();
				return all.at(-1);
			}
			const exact = await read(idOrRef);
			if (exact) return exact;
			const all = await store.list();
			return [...all].reverse().find((item) => item.id === idOrRef || item.id.startsWith(idOrRef) || item.ref === idOrRef || item.ref.startsWith(idOrRef));
		},
		async list(): Promise<StoredDeliverable[]> {
			const { records } = await scanIds();
			return records.sort((a, b) => a.savedAt.localeCompare(b.savedAt) || a.ref.localeCompare(b.ref));
		},
		async listUnsupported(): Promise<UnsupportedDeliverable[]> {
			const { unsupported } = await scanIds();
			return unsupported.sort((a, b) => a.ref.localeCompare(b.ref));
		},
		save,
		async saveWorker(input): Promise<DeliverableSaveResult> {
			return save(recordFromWorker(input, input.savedAt ?? new Date().toISOString()));
		},
		async saveParent(input): Promise<DeliverableSaveResult> {
			return save(recordFromParent(input));
		},
		async delete(deliverable): Promise<boolean> {
			return withDeliverableLock(dirFor(deliverable.id), async () => {
				const file = fileFor(deliverable.id, deliverable.version);
				try {
					await fs.unlink(file);
					return true;
				} catch (err: any) {
					if (err?.code === "ENOENT") return false;
					throw err;
				}
			});
		},
	};
	return store;
}

export function artifactSummaryFromArtifact(artifact: Artifact): ArtifactSummary {
	return {
		displayId: artifact.displayId,
		ref: artifact.ref,
		kind: artifact.kind,
		title: artifact.title,
		subtitle: artifact.subtitle,
		...(artifact.timestamp === undefined ? {} : { timestamp: artifact.timestamp }),
	};
}

export function storedDeliverableArtifact(deliverable: StoredDeliverable): Artifact {
	const workerLabel = deliverable.source.kind === "worker" ? deliverable.source.workerLabel : undefined;
	const label = workerLabel ? `${workerLabel} · ` : "parent · ";
	return {
		id: `deliverable-${deliverable.id}-v${deliverable.version}`,
		displayId: `deliverable-${deliverable.id}-v${deliverable.version}`,
		ref: deliverable.ref,
		kind: "response",
		title: `${label}v${deliverable.version} · ${deliverable.summary}`,
		subtitle: deliverable.source.kind === "worker" ? deliverable.source.task : `${deliverable.source.cwd} · ${deliverable.source.selectedArtifact.ref}`,
		body: deliverable.body,
		timestamp: Date.parse(deliverable.createdAt),
		meta: {
			storedDeliverable: true,
			deliverableId: deliverable.id,
			deliverableVersion: deliverable.version,
			deliverableRef: deliverable.ref,
			outcome: deliverable.outcome,
			summary: deliverable.summary,
			evidence: deliverable.evidence,
			recommended: deliverable.recommendations,
			source: deliverable.source,
			...(deliverable.changeSet ? {
				workerChangeSet: true,
				changedFiles: deliverable.changeSet.files,
				diffStat: deliverable.changeSet.stat,
				hunkCount: deliverable.changeSet.hunkCount,
				patch: deliverable.changeSet.patch,
			} : {}),
		},
	};
}

export function storedDeliverableHandoffProvenance(deliverable: StoredDeliverable): DeliverableHandoffProvenance {
	const approval = deliverable.approval;
	return {
		sourceDeliverableId: deliverable.id,
		sourceVersion: deliverable.version,
		sourceRef: deliverable.ref,
		...(deliverable.source.kind === "worker" ? {
			sourceKind: "worker" as const,
			sourceWorkerId: deliverable.source.workerId,
			sourceWorkerLabel: deliverable.source.workerLabel,
		} : {
			sourceKind: "parent",
			...(deliverable.source.sessionFile ? { sourceSessionFile: deliverable.source.sessionFile } : {}),
			sourceCwd: deliverable.source.cwd,
		}),
		approvingDecisionId: approval.decisionId,
		approvedAt: approval.decidedAt,
		sidecarPath: "source-deliverable.md",
	};
}
