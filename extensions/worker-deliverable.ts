import fs from "node:fs/promises";
import path from "node:path";
import { workerSourceLabel, type WorkerDoneInput, type WorkerDoneOutcome, type WorkerStatus } from "./background-work.js";
import type { Artifact, ArtifactSummary } from "./types.js";

export const WORKER_DELIVERABLE_SCHEMA_VERSION = 1 as const;

export type WorkerChangedFile = {
	path: string;
	additions?: number;
	deletions?: number;
};

export type WorkerDeliverableChangeSet = {
	ref: string;
	files: WorkerChangedFile[];
	stat: string;
	patch: string;
	hunkCount: number;
};

export type WorkerHandoffProvenance = {
	sourceDeliverableId: string;
	sourceVersion: number;
	sourceRef: string;
	sourceWorkerId: string;
	sourceWorkerLabel: string;
	approvingDecisionId: string;
	approvedAt: string;
	sidecarPath: string;
};

export type WorkerDeliverablePointer = {
	id: string;
	version: number;
	ref: string;
};

export type WorkerDeliverable = {
	schemaVersion: typeof WORKER_DELIVERABLE_SCHEMA_VERSION;
	id: string;
	version: number;
	ref: string;
	createdAt: string;
	source: {
		workerId: string;
		workerLabel: string;
		task: string;
		kind?: string;
		model?: string;
		thinking?: WorkerStatus["thinking"];
		runToken?: string;
		sessionFile?: string;
		/** Persisted only to make repeated tool execution idempotent. */
		toolCallId?: string;
	};
	body: string;
	summary: string;
	outcome: WorkerDoneOutcome;
	evidence: string[];
	recommendations: string[];
	refs: ArtifactSummary[];
	changeSet?: WorkerDeliverableChangeSet;
	sourceHandoff?: WorkerHandoffProvenance;
};

export type WorkerDeliverablePresentation = "document" | "findings" | "changes";

export type WorkerDeliverablePublicationInput = {
	root: string;
	worker: WorkerStatus;
	toolCallId?: string;
	body: string;
	done?: WorkerDoneInput;
	refs?: ArtifactSummary[];
	changeSet?: WorkerDeliverableChangeSet;
	/** Runs under publication lock after version allocation. */
	captureChangeSet?: (version: number) => WorkerDeliverableChangeSet | undefined | Promise<WorkerDeliverableChangeSet | undefined>;
	createdAt?: string;
};

export type WorkerDeliverablePublication = {
	deliverable: WorkerDeliverable;
	idempotent: boolean;
};

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function cleanList(items: string[] | undefined, max = 100): string[] {
	return (items ?? []).map((item) => String(item).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, max);
}

function cleanRefs(refs: ArtifactSummary[] | undefined): ArtifactSummary[] {
	const seen = new Set<string>();
	const out: ArtifactSummary[] = [];
	for (const ref of refs ?? []) {
		if (!ref || typeof ref.ref !== "string" || !ref.ref || seen.has(ref.ref)) continue;
		seen.add(ref.ref);
		out.push({
			displayId: String(ref.displayId ?? "").trim(),
			ref: ref.ref,
			kind: ref.kind,
			title: String(ref.title ?? "").trim(),
			subtitle: String(ref.subtitle ?? "").trim(),
			...(typeof ref.timestamp === "number" ? { timestamp: ref.timestamp } : {}),
		});
	}
	return out;
}

function firstLine(text: string): string | undefined {
	return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function normalizedChangeSet(changeSet: WorkerDeliverableChangeSet | undefined): WorkerDeliverableChangeSet | undefined {
	if (!changeSet?.patch?.trim()) return undefined;
	const files = (changeSet.files ?? []).map((file) => ({
		path: String(file.path ?? "").trim(),
		...(typeof file.additions === "number" ? { additions: file.additions } : {}),
		...(typeof file.deletions === "number" ? { deletions: file.deletions } : {}),
	})).filter((file) => file.path.length > 0);
	return {
		ref: changeSet.ref,
		files,
		stat: changeSet.stat ?? "",
		patch: changeSet.patch,
		hunkCount: Number.isFinite(changeSet.hunkCount) ? Math.max(0, Math.floor(changeSet.hunkCount)) : 0,
	};
}

export function workerDeliverableId(workerId: string): string {
	return `worker-deliverable:${workerId}`;
}

export function workerDeliverableRef(workerId: string, version: number): string {
	return `${workerDeliverableId(workerId)}:${version}`;
}

export function workerDeliverablesDir(root: string, workerId: string): string {
	return path.join(root, workerId, "deliverables");
}

export function workerDeliverableFile(root: string, workerId: string, version: number): string {
	return path.join(workerDeliverablesDir(root, workerId), `v${version}.json`);
}

export function workerDeliverablePointer(deliverable: Pick<WorkerDeliverable, "id" | "version" | "ref">): WorkerDeliverablePointer {
	return { id: deliverable.id, version: deliverable.version, ref: deliverable.ref };
}

export function sameWorkerDeliverablePointer(a: WorkerDeliverablePointer | undefined, b: WorkerDeliverablePointer | undefined): boolean {
	return Boolean(a && b && a.id === b.id && a.version === b.version && a.ref === b.ref);
}

export function classifyWorkerDeliverable(deliverable: Pick<WorkerDeliverable, "outcome" | "changeSet">): WorkerDeliverablePresentation {
	if (deliverable.changeSet?.patch) return "changes";
	if (deliverable.outcome === "proposal") return "document";
	return "findings";
}

export function normalizeWorkerDeliverable(input: WorkerDeliverablePublicationInput & { version: number }): WorkerDeliverable {
	const done = input.done ?? {};
	const body = typeof input.body === "string" ? input.body : String(input.body ?? "");
	const summary = done.summary?.trim() || firstLine(body) || "Worker deliverable";
	const changeSet = normalizedChangeSet(input.changeSet);
	const worker = input.worker;
	return {
		schemaVersion: WORKER_DELIVERABLE_SCHEMA_VERSION,
		id: workerDeliverableId(worker.id),
		version: input.version,
		ref: workerDeliverableRef(worker.id, input.version),
		createdAt: input.createdAt ?? new Date().toISOString(),
		source: {
			workerId: worker.id,
			workerLabel: workerSourceLabel(worker),
			task: worker.task,
			...(worker.kind ? { kind: worker.kind } : {}),
			...(worker.model ? { model: worker.model } : {}),
			...(worker.thinking ? { thinking: worker.thinking } : {}),
			...(worker.runToken ? { runToken: worker.runToken } : {}),
			...(worker.sessionFile ? { sessionFile: worker.sessionFile } : {}),
			...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
		},
		body,
		summary,
		outcome: done.outcome ?? "completed",
		evidence: cleanList(done.evidence),
		recommendations: cleanList(done.recommended),
		refs: cleanRefs(input.refs),
		...(changeSet ? { changeSet } : {}),
		...(worker.sourceHandoff ? { sourceHandoff: worker.sourceHandoff } : {}),
	};
}

async function writeJsonAtomic(file: string, payload: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
	try {
		await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		await fs.rename(tmp, file);
	} catch (err) {
		await fs.rm(tmp, { force: true });
		throw err;
	}
}

async function withPublicationLock<T>(dir: string, run: () => Promise<T>): Promise<T> {
	const lock = path.join(dir, ".publish.lock");
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
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out acquiring worker deliverable lock for ${path.basename(path.dirname(dir))}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	try {
		return await run();
	} finally {
		await fs.rm(lock, { recursive: true, force: true });
	}
}

function versionFromName(name: string): number | undefined {
	const match = /^v(\d+)\.json$/.exec(name);
	if (!match) return undefined;
	const version = Number(match[1]);
	return Number.isSafeInteger(version) && version > 0 ? version : undefined;
}

function isDeliverable(value: unknown): value is WorkerDeliverable {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<WorkerDeliverable>;
	const validRefs = Array.isArray(item.refs) && item.refs.every((ref) => ref
		&& typeof ref.displayId === "string"
		&& typeof ref.ref === "string"
		&& typeof ref.kind === "string"
		&& typeof ref.title === "string"
		&& typeof ref.subtitle === "string");
	const validChangeSet = item.changeSet === undefined || (
		typeof item.changeSet.ref === "string"
		&& typeof item.changeSet.stat === "string"
		&& typeof item.changeSet.patch === "string"
		&& typeof item.changeSet.hunkCount === "number"
		&& Array.isArray(item.changeSet.files)
		&& item.changeSet.files.every((file) => file && typeof file.path === "string")
	);
	const validSourceHandoff = item.sourceHandoff === undefined || (
		typeof item.sourceHandoff.sourceDeliverableId === "string"
		&& typeof item.sourceHandoff.sourceVersion === "number"
		&& Number.isSafeInteger(item.sourceHandoff.sourceVersion)
		&& item.sourceHandoff.sourceVersion > 0
		&& typeof item.sourceHandoff.sourceRef === "string"
		&& typeof item.sourceHandoff.sourceWorkerId === "string"
		&& typeof item.sourceHandoff.sourceWorkerLabel === "string"
		&& typeof item.sourceHandoff.approvingDecisionId === "string"
		&& typeof item.sourceHandoff.approvedAt === "string"
		&& typeof item.sourceHandoff.sidecarPath === "string"
	);
	return item.schemaVersion === WORKER_DELIVERABLE_SCHEMA_VERSION
		&& typeof item.id === "string"
		&& typeof item.version === "number"
		&& Number.isSafeInteger(item.version)
		&& item.version > 0
		&& typeof item.ref === "string"
		&& typeof item.createdAt === "string"
		&& typeof item.body === "string"
		&& typeof item.summary === "string"
		&& ["completed", "findings", "proposal", "no_evidence"].includes(item.outcome ?? "")
		&& Array.isArray(item.evidence) && item.evidence.every((entry) => typeof entry === "string")
		&& Array.isArray(item.recommendations) && item.recommendations.every((entry) => typeof entry === "string")
		&& validRefs
		&& validChangeSet
		&& validSourceHandoff
		&& typeof item.source?.workerId === "string"
		&& typeof item.source.workerLabel === "string"
		&& typeof item.source.task === "string";
}

export async function readWorkerDeliverable(root: string, workerId: string, version: number): Promise<WorkerDeliverable | undefined> {
	if (!Number.isSafeInteger(version) || version < 1) return undefined;
	try {
		const parsed = JSON.parse(await fs.readFile(workerDeliverableFile(root, workerId, version), "utf8")) as unknown;
		if (!isDeliverable(parsed)) return undefined;
		return parsed.source.workerId === workerId
			&& parsed.id === workerDeliverableId(workerId)
			&& parsed.version === version
			&& parsed.ref === workerDeliverableRef(workerId, version)
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

export async function readCurrentWorkerDeliverable(root: string, worker: Pick<WorkerStatus, "id" | "deliverable">): Promise<WorkerDeliverable | undefined> {
	const pointer = worker.deliverable;
	if (!pointer) return undefined;
	const deliverable = await readWorkerDeliverable(root, worker.id, pointer.version);
	return deliverable && sameWorkerDeliverablePointer(workerDeliverablePointer(deliverable), pointer) ? deliverable : undefined;
}

async function publishedDeliverables(root: string, workerId: string): Promise<{ versions: number[]; items: WorkerDeliverable[] }> {
	let names: string[];
	try {
		names = await fs.readdir(workerDeliverablesDir(root, workerId));
	} catch {
		return { versions: [], items: [] };
	}
	const versions = names.map(versionFromName).filter((version): version is number => version !== undefined).sort((a, b) => a - b);
	const items = await Promise.all(versions.map((version) => readWorkerDeliverable(root, workerId, version)));
	return { versions, items: items.filter((item): item is WorkerDeliverable => item !== undefined) };
}

/**
 * Freeze one accepted ready generation. A lock serializes versions and makes a
 * repeated tool execution with the same call id return its first publication.
 */
export async function publishWorkerDeliverable(input: WorkerDeliverablePublicationInput): Promise<WorkerDeliverablePublication> {
	const dir = workerDeliverablesDir(input.root, input.worker.id);
	return withPublicationLock(dir, async () => {
		const published = await publishedDeliverables(input.root, input.worker.id);
		if (input.toolCallId) {
			const duplicate = published.items.find((item) => item.source.toolCallId === input.toolCallId);
			if (duplicate) return { deliverable: duplicate, idempotent: true };
		}
		// Every claimed vN filename is immutable, even when its contents are corrupt.
		const latestVersion = published.versions.at(-1) ?? 0;
		if (latestVersion >= Number.MAX_SAFE_INTEGER) throw new Error(`Worker deliverable version space exhausted for ${input.worker.id}`);
		const version = latestVersion + 1;
		const changeSet = input.changeSet ?? await input.captureChangeSet?.(version);
		const deliverable = normalizeWorkerDeliverable({ ...input, ...(changeSet ? { changeSet } : {}), version });
		await writeJsonAtomic(workerDeliverableFile(input.root, input.worker.id, version), deliverable);
		return { deliverable, idempotent: false };
	});
}

function messageFromEntry(entry: unknown): any | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const candidate = entry as { message?: unknown; role?: unknown; content?: unknown };
	if (candidate.message && typeof candidate.message === "object") return candidate.message;
	return typeof candidate.role === "string" ? candidate : undefined;
}

function textFromAssistantContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const block = part as { type?: unknown; text?: unknown };
		return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
	}).join("\n");
}

function toolCalls(content: unknown): Array<{ id: string; name: string }> {
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const block = part as { type?: unknown; id?: unknown; name?: unknown };
		return block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string"
			? [{ id: block.id, name: block.name }]
			: [];
	});
}

function hasProtocolCall(content: unknown): boolean {
	return toolCalls(content).some((call) => call.name.startsWith("docket_"));
}

/** Full assistant body around a docket_done call; never routed through artifact limits. */
export function extractWorkerDeliverableBody(branch: unknown[], toolCallId: string | undefined, summary?: string): string {
	const assistants = branch.map(messageFromEntry).filter((message): message is { role: string; content?: unknown } => Boolean(message && message.role === "assistant"));
	if (toolCallId) {
		for (let index = assistants.length - 1; index >= 0; index--) {
			const message = assistants[index]!;
			if (!toolCalls(message.content).some((call) => call.id === toolCallId && call.name === "docket_done")) continue;
			const body = textFromAssistantContent(message.content);
			if (body.trim()) return body;
			break;
		}
	}
	for (let index = assistants.length - 1; index >= 0; index--) {
		const message = assistants[index]!;
		if (hasProtocolCall(message.content)) continue;
		const body = textFromAssistantContent(message.content);
		if (body.trim()) return body;
	}
	return summary?.trim() ?? "";
}

export function workerDeliverableArtifact(deliverable: WorkerDeliverable): Artifact {
	const label = deliverable.source.workerLabel;
	const title = firstLine(deliverable.summary) ?? `${label} deliverable v${deliverable.version}`;
	return {
		id: `deliverable-v${deliverable.version}`,
		displayId: `deliverable-v${deliverable.version}`,
		ref: deliverable.ref,
		kind: "response",
		title: `${label} v${deliverable.version} · ${title}`,
		subtitle: deliverable.source.task,
		body: deliverable.body,
		timestamp: Date.parse(deliverable.createdAt),
		meta: {
			workerDeliverable: true,
			workerId: deliverable.source.workerId,
			workerLabel: label,
			deliverableId: deliverable.id,
			deliverableVersion: deliverable.version,
			deliverableRef: deliverable.ref,
			outcome: deliverable.outcome,
			summary: deliverable.summary,
			evidence: deliverable.evidence,
			recommended: deliverable.recommendations,
			...(deliverable.changeSet ? {
				workerChangeSet: true,
				changeSetRef: deliverable.changeSet.ref,
				changedFiles: deliverable.changeSet.files,
				diffStat: deliverable.changeSet.stat,
				hunkCount: deliverable.changeSet.hunkCount,
				patch: deliverable.changeSet.patch,
			} : {}),
			...(deliverable.sourceHandoff ? { sourceHandoff: deliverable.sourceHandoff } : {}),
		},
	};
}

export function isWorkerDeliverableArtifact(artifact: Artifact | undefined): boolean {
	return artifact?.meta?.workerDeliverable === true || artifact?.ref.startsWith("worker-deliverable:") === true;
}

/** Rehydrate a mounted primary artifact for dashboard/report adapters. */
export function workerDeliverableFromArtifact(artifact: Artifact | undefined): WorkerDeliverable | undefined {
	if (!artifact || !isWorkerDeliverableArtifact(artifact)) return undefined;
	const meta = artifact.meta ?? {};
	const id = typeof meta.deliverableId === "string" ? meta.deliverableId : undefined;
	const version = typeof meta.deliverableVersion === "number" ? meta.deliverableVersion : undefined;
	const ref = typeof meta.deliverableRef === "string" ? meta.deliverableRef : artifact.ref;
	const workerId = typeof meta.workerId === "string" ? meta.workerId : undefined;
	const workerLabel = typeof meta.workerLabel === "string" ? meta.workerLabel : undefined;
	const summary = typeof meta.summary === "string" ? meta.summary : firstLine(artifact.body) ?? artifact.title;
	const outcome = meta.outcome === "completed" || meta.outcome === "findings" || meta.outcome === "proposal" || meta.outcome === "no_evidence" ? meta.outcome : "completed";
	if (!id || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 || !workerId || !workerLabel) return undefined;
	const rawFiles = Array.isArray(meta.changedFiles) ? meta.changedFiles : [];
	const files = rawFiles.map((entry) => {
		if (!entry || typeof entry !== "object") return undefined;
		const file = entry as { path?: unknown; additions?: unknown; deletions?: unknown };
		if (typeof file.path !== "string" || !file.path) return undefined;
		return {
			path: file.path,
			...(typeof file.additions === "number" ? { additions: file.additions } : {}),
			...(typeof file.deletions === "number" ? { deletions: file.deletions } : {}),
		};
	}).filter((file): file is WorkerChangedFile => file !== undefined);
	const patch = typeof meta.patch === "string" ? meta.patch : undefined;
	const evidence = Array.isArray(meta.evidence) ? cleanList(meta.evidence.map(String)) : [];
	const recommendations = Array.isArray(meta.recommended) ? cleanList(meta.recommended.map(String)) : [];
	const createdAt = Number.isFinite(artifact.timestamp) ? new Date(artifact.timestamp!).toISOString() : new Date(0).toISOString();
	const sourceHandoff = meta.sourceHandoff && typeof meta.sourceHandoff === "object" ? meta.sourceHandoff as WorkerHandoffProvenance : undefined;
	return {
		schemaVersion: WORKER_DELIVERABLE_SCHEMA_VERSION,
		id,
		version,
		ref,
		createdAt,
		source: { workerId, workerLabel, task: artifact.subtitle },
		body: artifact.body,
		summary,
		outcome,
		evidence,
		recommendations,
		refs: [],
		...(patch ? {
			changeSet: {
				ref: typeof meta.changeSetRef === "string" ? meta.changeSetRef : `worker-changes:${workerId}:${version}`,
				files,
				stat: typeof meta.diffStat === "string" ? meta.diffStat : "",
				patch,
				hunkCount: typeof meta.hunkCount === "number" ? meta.hunkCount : patch.match(/^@@ /gm)?.length ?? 0,
			},
		} : {}),
		...(sourceHandoff ? { sourceHandoff } : {}),
	};
}

/** Legacy ready workers get one best-effort v1. Their old artifact body may be truncated. */
export function legacyWorkerDeliverableInput(worker: WorkerStatus, artifacts: Artifact[], changeSet?: WorkerDeliverableChangeSet): Omit<WorkerDeliverablePublicationInput, "root" | "worker"> {
	const answer = [...artifacts].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).find((artifact) => {
		if (artifact.kind !== "response" && artifact.kind !== "code") return false;
		return artifact.meta?.workerStatus === undefined && artifact.meta?.workerDeliverable !== true;
	});
	const body = answer?.body || worker.summary || "";
	return {
		toolCallId: "legacy-v1",
		body,
		done: {
			summary: worker.summary,
			outcome: worker.outcome,
			evidence: worker.evidence,
			recommended: worker.recommended,
		},
		refs: artifacts.map((artifact) => ({
			displayId: artifact.displayId,
			ref: artifact.ref,
			kind: artifact.kind,
			title: artifact.title,
			subtitle: artifact.subtitle,
			...(artifact.timestamp !== undefined ? { timestamp: artifact.timestamp } : {}),
		})),
		...(changeSet ? { changeSet } : {}),
	};
}
