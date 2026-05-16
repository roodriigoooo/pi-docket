import { createArtifactCatalog, type ArtifactCatalog, type TrailRuntimeContext } from "./artifact-catalog.js";
import { loadConfig, type TrailConfig } from "./trail-config.js";
import type { Artifact, ArtifactKind, CheckpointIndexEntry } from "./types.js";
import { workerShortLabel, type WorkerStatus } from "./background-work.js";

export type ChipMode = "ref" | "full";

export type Chip = {
	displayId: string;
	ref: string;
	mode: ChipMode;
	kind: ArtifactKind;
	title: string;
};

export type ChipToggleResult = "added" | "removed" | "upgraded" | "downgraded";

export type CarryoverKind = "checkpoint" | "worker";

export type CarryoverSlot = {
	slot: string;
	kind: CarryoverKind;
	sourceId: string;
	artifacts: Artifact[];
	checkpoint?: CheckpointIndexEntry;
};

export type ChipExpansion = {
	text: string;
	expanded: number;
	missing: string[];
};

export type LoadedArtifactContextDeps = {
	loadConfig?: (cwd: string) => Promise<TrailConfig>;
	createCatalog?: (ctx: TrailRuntimeContext, config: TrailConfig, carryover: Artifact[]) => ArtifactCatalog;
	readCheckpointArtifacts: (checkpoint: CheckpointIndexEntry) => Promise<Artifact[]>;
	readWorkerArtifacts: (worker: WorkerStatus) => Promise<Artifact[]>;
};

export type LoadedArtifactContext = {
	chips(): Chip[];
	slots(): CarryoverSlot[];
	carryoverArtifacts(): Artifact[];
	reset(): void;
	loadCheckpoint(checkpoint: CheckpointIndexEntry): Promise<CarryoverSlot>;
	loadWorker(worker: WorkerStatus): Promise<CarryoverSlot>;
	unloadSlot(slot: string): CarryoverSlot | undefined;
	unloadSource(kind: CarryoverKind, sourceId: string): CarryoverSlot | undefined;
	queueCheckpointConsume(checkpoint: CheckpointIndexEntry): void;
	drainCheckpointConsumes(markConsumed: (checkpoint: CheckpointIndexEntry) => Promise<void>): Promise<void>;
	toggleChip(artifact: Artifact, mode: ChipMode): ChipToggleResult;
	clearChips(): boolean;
	expandChipsForSubmit(ctx: TrailRuntimeContext, userText: string): Promise<ChipExpansion>;
};

function namespaceCarryover(artifacts: Artifact[], slot: string): Artifact[] {
	return artifacts.map((artifact) => {
		const namespacedId = `${slot}.${artifact.displayId}`;
		return { ...artifact, id: namespacedId, displayId: namespacedId, source: slot };
	});
}

function renderChipBlock(chip: Chip, content: string): string {
	const opener = `<<trail @${chip.displayId} ${chip.mode}>>`;
	const closer = `<</trail>>`;
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
		async loadCheckpoint(checkpoint: CheckpointIndexEntry): Promise<CarryoverSlot> {
			const existing = findSlotForSource("checkpoint", checkpoint.id);
			if (existing) return existing;
			const raw = await deps.readCheckpointArtifacts(checkpoint);
			const slot = `c${nextCheckpointSlotIndex++}`;
			const entry: CarryoverSlot = { slot, kind: "checkpoint", sourceId: checkpoint.id, artifacts: namespaceCarryover(raw, slot), checkpoint };
			carryover.set(slot, entry);
			return entry;
		},
		async loadWorker(worker: WorkerStatus): Promise<CarryoverSlot> {
			const existing = findSlotForSource("worker", worker.id);
			if (existing) return existing;
			const raw = await deps.readWorkerArtifacts(worker);
			const slot = workerShortLabel(worker.index);
			const entry: CarryoverSlot = { slot, kind: "worker", sourceId: worker.id, artifacts: namespaceCarryover(raw, slot) };
			carryover.set(slot, entry);
			return entry;
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
			if (idx === -1) {
				chips = [...chips, { displayId: artifact.displayId, ref: artifact.ref, mode, kind: artifact.kind, title: artifact.title }];
				return "added";
			}
			const existing = chips[idx]!;
			if (existing.mode === mode) {
				chips = chips.filter((_, i) => i !== idx);
				return "removed";
			}
			chips = chips.map((c, i) => (i === idx ? { ...c, mode } : c));
			return mode === "full" ? "upgraded" : "downgraded";
		},
		clearChips(): boolean {
			if (chips.length === 0) return false;
			chips = [];
			return true;
		},
		async expandChipsForSubmit(ctx: TrailRuntimeContext, userText: string): Promise<ChipExpansion> {
			if (chips.length === 0) return { text: userText, expanded: 0, missing: [] };
			const config = await (deps.loadConfig ?? loadConfig)(ctx.cwd);
			const catalog = (deps.createCatalog ?? createArtifactCatalog)(ctx, config, carryoverArtifacts());
			const blocks: string[] = [];
			const missing: string[] = [];
			for (const chip of chips) {
				const artifact = catalog.find(chip.ref) ?? catalog.find(chip.displayId);
				if (!artifact) {
					missing.push(chip.displayId);
					continue;
				}
				const body = chip.mode === "full" ? catalog.fullText(artifact) : catalog.reference(artifact);
				blocks.push(renderChipBlock(chip, body));
			}
			if (blocks.length === 0) return { text: userText, expanded: 0, missing };
			const header = `<<trail-context: ${blocks.length} reference${blocks.length === 1 ? "" : "s"}>>`;
			const footer = `<</trail-context>>`;
			const wrapped = `${header}\n${blocks.join("\n\n")}\n${footer}`;
			const text = userText.trim() ? `${wrapped}\n\n${userText}` : wrapped;
			return { text, expanded: blocks.length, missing };
		},
	};
}
