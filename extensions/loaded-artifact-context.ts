import { createArtifactCatalog, type ArtifactCatalog, type DocketRuntimeContext } from "./artifact-catalog.js";
import { loadConfig, type DocketConfig } from "./docket-config.js";
import type { Artifact, ArtifactKind, CheckpointIndexEntry } from "./types.js";
import { deriveWorkerState, workerShortLabel, type WorkerStatus } from "./background-work.js";
import { workerDeliverableArtifact, type WorkerDeliverable } from "./worker-deliverable.js";

export type ChipMode = "ref" | "full";

export type Chip = {
	displayId: string;
	ref: string;
	mode: ChipMode;
	kind: ArtifactKind;
	title: string;
	/** Immutable Deliverable body retained until submit even if current worker version advances. */
	body?: string;
};

export type ChipToggleResult = "added" | "removed" | "upgraded" | "downgraded";

export type CarryoverKind = "checkpoint" | "worker";

export type CarryoverSlot = {
	slot: string;
	kind: CarryoverKind;
	sourceId: string;
	artifacts: Artifact[];
	checkpoint?: CheckpointIndexEntry;
	deliverableRef?: string;
};

export type LoadableSource =
	| { kind: "checkpoint"; checkpoint: CheckpointIndexEntry }
	| { kind: "worker"; worker: WorkerStatus }
	| { kind: "deliverable"; worker: WorkerStatus; deliverable: WorkerDeliverable };

export type LoadableSourceCandidates = {
	checkpoints: CheckpointIndexEntry[];
	workers: WorkerStatus[];
};

export type LoadResult = {
	source: LoadableSource;
	slot: CarryoverSlot;
	queuedConsume: boolean;
};

export type ChipExpansion = {
	text: string;
	expanded: number;
	missing: string[];
};

export type LoadedArtifactContextDeps = {
	loadConfig?: (cwd: string) => Promise<DocketConfig>;
	createCatalog?: (ctx: DocketRuntimeContext, config: DocketConfig, carryover: Artifact[]) => ArtifactCatalog;
	readCheckpointArtifacts: (checkpoint: CheckpointIndexEntry) => Promise<Artifact[]>;
	readWorkerArtifacts: (worker: WorkerStatus) => Promise<Artifact[]>;
};

export type LoadedArtifactContext = {
	chips(): Chip[];
	slots(): CarryoverSlot[];
	carryoverArtifacts(): Artifact[];
	reset(): void;
	defaultLoadSource(candidates: LoadableSourceCandidates): LoadableSource | undefined;
	loadSource(source: LoadableSource): Promise<LoadResult>;
	loadCheckpoint(checkpoint: CheckpointIndexEntry): Promise<CarryoverSlot>;
	loadWorker(worker: WorkerStatus): Promise<CarryoverSlot>;
	/** Mount one immutable reviewed generation under its worker slot. */
	loadDeliverable(worker: WorkerStatus, deliverable: WorkerDeliverable): Promise<CarryoverSlot>;
	unloadSlot(slot: string): CarryoverSlot | undefined;
	unloadSource(kind: CarryoverKind, sourceId: string): CarryoverSlot | undefined;
	queueCheckpointConsume(checkpoint: CheckpointIndexEntry): void;
	drainCheckpointConsumes(markConsumed: (checkpoint: CheckpointIndexEntry) => Promise<void>): Promise<void>;
	toggleChip(artifact: Artifact, mode: ChipMode): ChipToggleResult;
	clearChips(): boolean;
	expandChipsForSubmit(ctx: DocketRuntimeContext, userText: string): Promise<ChipExpansion>;
};

function namespaceCarryover(artifacts: Artifact[], slot: string): Artifact[] {
	return artifacts.map((artifact) => {
		const namespacedId = `${slot}.${artifact.displayId}`;
		return { ...artifact, id: namespacedId, displayId: namespacedId, source: slot };
	});
}

function renderChipBlock(chip: Chip, content: string): string {
	const opener = `<<docket @${chip.displayId} ${chip.mode}>>`;
	const closer = `<</docket>>`;
	return `${opener}\n${content}\n${closer}`;
}

export function createLoadedArtifactContext(deps: LoadedArtifactContextDeps): LoadedArtifactContext {
	let chips: Chip[] = [];
	let carryover: Map<string, CarryoverSlot> = new Map();
	let pendingCheckpointConsumes: Map<string, CheckpointIndexEntry> = new Map();
	let nextCheckpointSlotIndex = 1;

	const findSlotForSource = (kind: CarryoverKind, sourceId: string): CarryoverSlot | undefined => {
		for (const slot of carryover.values()) {
			if (slot.kind === kind && slot.sourceId === sourceId) return slot;
		}
		return undefined;
	};

	const carryoverArtifacts = (): Artifact[] => {
		const out: Artifact[] = [];
		for (const slot of carryover.values()) out.push(...slot.artifacts);
		return out;
	};

	const unloadSlot = (slot: string): CarryoverSlot | undefined => {
		const entry = carryover.get(slot);
		if (!entry) return undefined;
		carryover.delete(slot);
		if (entry.kind === "checkpoint") pendingCheckpointConsumes.delete(entry.sourceId);
		return entry;
	};

	const loadCheckpoint = async (checkpoint: CheckpointIndexEntry): Promise<CarryoverSlot> => {
		const existing = findSlotForSource("checkpoint", checkpoint.id);
		if (existing) return existing;
		const raw = await deps.readCheckpointArtifacts(checkpoint);
		const slot = `c${nextCheckpointSlotIndex++}`;
		const entry: CarryoverSlot = { slot, kind: "checkpoint", sourceId: checkpoint.id, artifacts: namespaceCarryover(raw, slot), checkpoint };
		carryover.set(slot, entry);
		return entry;
	};

	const loadWorker = async (worker: WorkerStatus): Promise<CarryoverSlot> => {
		const existing = findSlotForSource("worker", worker.id);
		if (existing && !existing.deliverableRef) return existing;
		if (existing) carryover.delete(existing.slot);
		const raw = await deps.readWorkerArtifacts(worker);
		const slot = workerShortLabel(worker.index);
		const entry: CarryoverSlot = { slot, kind: "worker", sourceId: worker.id, artifacts: namespaceCarryover(raw, slot) };
		carryover.set(slot, entry);
		return entry;
	};

	const loadDeliverable = async (worker: WorkerStatus, deliverable: WorkerDeliverable): Promise<CarryoverSlot> => {
		const existing = findSlotForSource("worker", worker.id);
		if (existing?.deliverableRef === deliverable.ref) return existing;
		if (existing) {
			if (existing.deliverableRef) chips = chips.filter((chip) => chip.ref !== existing.deliverableRef);
			carryover.delete(existing.slot);
		}
		const slot = workerShortLabel(worker.index);
		const baseArtifact = workerDeliverableArtifact(deliverable);
		const artifact = { ...baseArtifact, meta: { ...baseArtifact.meta, workerStatus: deriveWorkerState(worker) } };
		const entry: CarryoverSlot = {
			slot,
			kind: "worker",
			sourceId: worker.id,
			deliverableRef: deliverable.ref,
			artifacts: namespaceCarryover([artifact], slot),
		};
		carryover.set(slot, entry);
		return entry;
	};

	const loadSource = async (source: LoadableSource): Promise<LoadResult> => {
		const slot = source.kind === "checkpoint"
			? await loadCheckpoint(source.checkpoint)
			: source.kind === "deliverable" ? await loadDeliverable(source.worker, source.deliverable) : await loadWorker(source.worker);
		const queuedConsume = source.kind === "checkpoint" && source.checkpoint.consumeOnUse === true;
		if (queuedConsume) pendingCheckpointConsumes.set(source.checkpoint.id, source.checkpoint);
		return { source, slot, queuedConsume };
	};

	return {
		chips() {
			return [...chips];
		},
		slots() {
			return [...carryover.values()];
		},
		carryoverArtifacts,
		reset() {
			chips = [];
			carryover = new Map();
			pendingCheckpointConsumes = new Map();
			nextCheckpointSlotIndex = 1;
		},
		defaultLoadSource(candidates: LoadableSourceCandidates): LoadableSource | undefined {
			const checkpoint = candidates.checkpoints[candidates.checkpoints.length - 1];
			if (checkpoint) return { kind: "checkpoint", checkpoint };
			const worker = candidates.workers[candidates.workers.length - 1];
			return worker ? { kind: "worker", worker } : undefined;
		},
		loadSource,
		loadCheckpoint(checkpoint: CheckpointIndexEntry): Promise<CarryoverSlot> {
			return loadSource({ kind: "checkpoint", checkpoint }).then((result) => result.slot);
		},
		loadWorker(worker: WorkerStatus): Promise<CarryoverSlot> {
			return loadSource({ kind: "worker", worker }).then((result) => result.slot);
		},
		loadDeliverable(worker: WorkerStatus, deliverable: WorkerDeliverable): Promise<CarryoverSlot> {
			return loadSource({ kind: "deliverable", worker, deliverable }).then((result) => result.slot);
		},
		unloadSlot,
		unloadSource(kind: CarryoverKind, sourceId: string): CarryoverSlot | undefined {
			const entry = findSlotForSource(kind, sourceId);
			if (!entry) return undefined;
			return unloadSlot(entry.slot);
		},
		queueCheckpointConsume(checkpoint: CheckpointIndexEntry): void {
			pendingCheckpointConsumes.set(checkpoint.id, checkpoint);
		},
		async drainCheckpointConsumes(markConsumed: (checkpoint: CheckpointIndexEntry) => Promise<void>): Promise<void> {
			if (pendingCheckpointConsumes.size === 0) return;
			const pending = [...pendingCheckpointConsumes.values()];
			pendingCheckpointConsumes = new Map();
			await Promise.all(pending.map(async (checkpoint) => {
				try { await markConsumed(checkpoint); }
				catch { /* best-effort */ }
			}));
		},
		toggleChip(artifact: Artifact, mode: ChipMode): ChipToggleResult {
			const idx = chips.findIndex((c) => c.ref === artifact.ref);
			const body = mode === "full" && artifact.meta?.workerDeliverable === true ? artifact.body : undefined;
			if (idx === -1) {
				chips = [...chips, { displayId: artifact.displayId, ref: artifact.ref, mode, kind: artifact.kind, title: artifact.title, ...(body !== undefined ? { body } : {}) }];
				return "added";
			}
			const existing = chips[idx]!;
			if (existing.mode === mode) {
				chips = chips.filter((_, i) => i !== idx);
				return "removed";
			}
			chips = chips.map((chip, i) => {
				if (i !== idx) return chip;
				const { body: _body, ...rest } = chip;
				return { ...rest, mode, ...(body !== undefined ? { body } : {}) };
			});
			return mode === "full" ? "upgraded" : "downgraded";
		},
		clearChips(): boolean {
			if (chips.length === 0) return false;
			chips = [];
			return true;
		},
		async expandChipsForSubmit(ctx: DocketRuntimeContext, userText: string): Promise<ChipExpansion> {
			if (chips.length === 0) return { text: userText, expanded: 0, missing: [] };
			const config = await (deps.loadConfig ?? loadConfig)(ctx.cwd);
			const catalog = (deps.createCatalog ?? createArtifactCatalog)(ctx, config, carryoverArtifacts());
			const blocks: string[] = [];
			const missing: string[] = [];
			for (const chip of chips) {
				const artifact = catalog.find(chip.ref) ?? catalog.find(chip.displayId);
				if (!artifact && chip.body === undefined) {
					missing.push(chip.displayId);
					continue;
				}
				const body = chip.body ?? (chip.mode === "full" ? catalog.fullText(artifact!) : catalog.reference(artifact!));
				blocks.push(renderChipBlock(chip, body));
			}
			if (blocks.length === 0) return { text: userText, expanded: 0, missing };
			const header = `<<docket-context: ${blocks.length} reference${blocks.length === 1 ? "" : "s"}>>`;
			const footer = `<</docket-context>>`;
			const wrapped = `${header}\n${blocks.join("\n\n")}\n${footer}`;
			const text = userText.trim() ? `${wrapped}\n\n${userText}` : wrapped;
			return { text, expanded: blocks.length, missing };
		},
	};
}
