import type { ArtifactCatalog } from "./artifact-catalog.js";
import type { DecisionEvent } from "./decision-log.js";
import {
	approvedWorkerDecision,
	artifactSummaryFromArtifact,
	createDeliverableStore,
	reviewNotesForWorkerDeliverable,
	type DeliverableSaveResult,
	type DeliverableStore,
	type StoredDeliverable,
} from "./deliverable-store.js";
import type { WorkerDeliverable, WorkerDeliverablePointer } from "./worker-deliverable.js";
import { isWorkerDeliverableArtifact, sameWorkerDeliverablePointer, workerDeliverablePointer } from "./worker-deliverable.js";
import type { WorkerStatus } from "./background-work.js";
import type { WorkerStore } from "./worker-store.js";
import type { WorkerDoneOutcome } from "./background-work.js";
import type { Artifact } from "./types.js";

export type DeliverableSaveSource =
	| { kind: "worker"; ref: string }
	| { kind: "artifact"; ref: string };

export type ParentDeliverableOutcome = Extract<WorkerDoneOutcome, "proposal" | "findings" | "completed">;

export type DeliverableLifecycleDeps = {
	store?: DeliverableStore;
	workerStore: Pick<WorkerStore, "find" | "readCurrentDeliverable"> & { readDeliverable?: WorkerStore["readDeliverable"] };
	readDecisionEvents(): Promise<DecisionEvent[]>;
	catalog(): Promise<ArtifactCatalog>;
	cwd: string;
	parentSession?: string;
	hasUI: boolean;
	edit(title: string, content: string): Promise<string | undefined>;
	selectOutcome(): Promise<ParentDeliverableOutcome | undefined>;
	selectSource?(): Promise<DeliverableSaveSource | undefined>;
	notify(text: string, level: "info" | "warning" | "error"): void;
};

export type DeliverableLifecycle = {
	save(source?: DeliverableSaveSource): Promise<DeliverableSaveResult | undefined>;
	saveWorker(ref: string, expected?: WorkerDeliverablePointer): Promise<DeliverableSaveResult | undefined>;
	saveArtifact(ref: string): Promise<DeliverableSaveResult | undefined>;
};

function firstLine(text: string): string {
	return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Parent deliverable";
}

function outcomeLabel(outcome: ParentDeliverableOutcome): string {
	if (outcome === "proposal") return "Proposal";
	if (outcome === "findings") return "Findings";
	return "Completed";
}

function workerSourceError(worker: WorkerStatus, deliverable: WorkerDeliverable | undefined): string {
	if (!deliverable) return `Docket ${worker.id} has no valid current Worker Deliverable.`;
	return `Docket ${worker.id} Worker Deliverable ${deliverable.ref} is not approved for saving.`;
}

function workerPointerFromRef(ref: string): WorkerDeliverablePointer | undefined {
	const parsed = /^worker-deliverable:(.+):(\d+)$/.exec(ref);
	if (!parsed) return undefined;
	const id = ref.slice(0, ref.lastIndexOf(":"));
	const version = Number(parsed[2]);
	if (!Number.isSafeInteger(version) || version < 1 || ref !== `${id}:${version}`) return undefined;
	return { id, version, ref };
}

function workerPointerFromArtifact(artifact: Artifact): WorkerDeliverablePointer | undefined {
	const meta = artifact.meta ?? {};
	const ref = typeof meta.deliverableRef === "string" ? meta.deliverableRef : artifact.ref;
	const pointer = workerPointerFromRef(ref);
	if (!pointer) return undefined;
	if (typeof meta.deliverableId === "string" && meta.deliverableId !== pointer.id) return undefined;
	if (typeof meta.deliverableVersion === "number" && meta.deliverableVersion !== pointer.version) return undefined;
	return pointer;
}

export function createDeliverableLifecycle(deps: DeliverableLifecycleDeps): DeliverableLifecycle {
	const store = deps.store ?? createDeliverableStore();

	const saveWorker = async (ref: string, expected?: WorkerDeliverablePointer): Promise<DeliverableSaveResult | undefined> => {
		const worker = await deps.workerStore.find(ref);
		if (!worker) {
			deps.notify("Docket worker not found", "error");
			return undefined;
		}
		const deliverable = expected
			? await (deps.workerStore.readDeliverable
				? deps.workerStore.readDeliverable(worker.id, expected.version)
				: deps.workerStore.readCurrentDeliverable(worker).then((current) => current && sameWorkerDeliverablePointer(workerDeliverablePointer(current), expected) ? current : undefined))
			: await deps.workerStore.readCurrentDeliverable(worker);
		if (!deliverable) {
			deps.notify(expected ? `Docket Worker Deliverable ${expected.ref} is missing or invalid.` : workerSourceError(worker, deliverable), "error");
			return undefined;
		}
		if (expected && !sameWorkerDeliverablePointer(workerDeliverablePointer(deliverable), expected)) {
			deps.notify(`Docket Worker Deliverable ${expected.ref} is stale or mismatched.`, "warning");
			return undefined;
		}
		const events = await deps.readDecisionEvents();
		const decision = approvedWorkerDecision(events, workerDeliverablePointer(deliverable));
		if (!decision) {
			deps.notify(workerSourceError(worker, deliverable), "warning");
			return undefined;
		}
		const result = await store.saveWorker({
			deliverable,
			worker,
			approval: {
				kind: "worker",
				decisionId: decision.id ?? `legacy-approval:${deliverable.ref}`,
				decidedAt: decision.timestamp,
				verdict: "accept",
				workerDeliverable: workerDeliverablePointer(deliverable),
				decision,
			},
			reviewNotes: reviewNotesForWorkerDeliverable(events, workerDeliverablePointer(deliverable)),
		});
		deps.notify(result.idempotent ? `Docket deliverable already saved: ${result.deliverable.ref}` : `Docket deliverable saved: ${result.deliverable.ref}`, "info");
		return result;
	};

	const saveArtifact = async (ref: string): Promise<DeliverableSaveResult | undefined> => {
		const directWorkerPointer = workerPointerFromRef(ref);
		if (directWorkerPointer) return saveWorker(directWorkerPointer.id.slice("worker-deliverable:".length), directWorkerPointer);
		const catalog = await deps.catalog();
		const artifact = catalog.find(ref);
		if (!artifact) {
			deps.notify("Docket artifact not found", "error");
			return undefined;
		}
		if (isWorkerDeliverableArtifact(artifact)) {
			const expected = workerPointerFromArtifact(artifact);
			const workerId = typeof artifact.meta?.workerId === "string"
				? artifact.meta.workerId
				: expected?.id.slice("worker-deliverable:".length).split(":")[0];
			if (!workerId || !expected) {
				deps.notify("Docket Worker Deliverable has no source worker", "error");
				return undefined;
			}
			// A Worker Deliverable is already an explicit durable candidate. Never
			// turn it into parent-authored content and bypass generation approval.
			return saveWorker(workerId, expected);
		}
		if (!deps.hasUI) {
			deps.notify("Docket parent authoring requires interactive UI. Use --from w<N> for an explicitly approved worker deliverable.", "error");
			return undefined;
		}
		const edited = await deps.edit(`Edit deliverable · ${artifact.displayId}`, catalog.fullText(artifact));
		if (edited === undefined) {
			deps.notify("Docket deliverable save cancelled", "info");
			return undefined;
		}
		if (!edited.trim()) {
			deps.notify("Docket deliverable body cannot be empty", "error");
			return undefined;
		}
		const outcome = await deps.selectOutcome();
		if (!outcome) {
			deps.notify("Docket deliverable save cancelled", "info");
			return undefined;
		}
		const result = await store.saveParent({
			body: edited,
			summary: firstLine(edited),
			outcome,
			refs: [artifactSummaryFromArtifact(artifact)],
			selectedArtifact: artifactSummaryFromArtifact(artifact),
			sessionFile: deps.parentSession,
			cwd: deps.cwd,
		});
		deps.notify(`Docket deliverable saved: ${result.deliverable.ref} · ${outcomeLabel(outcome)}`, "info");
		return result;
	};

	return {
		save(source): Promise<DeliverableSaveResult | undefined> {
			return (async () => {
				const selected = source ?? await deps.selectSource?.();
				if (!selected) {
					if (!source) deps.notify(deps.hasUI ? "Docket deliverable save cancelled" : "Docket save needs --from w<N> outside interactive UI.", deps.hasUI ? "info" : "error");
					return undefined;
				}
				return selected.kind === "worker" ? saveWorker(selected.ref) : saveArtifact(selected.ref);
			})();
		},
		saveWorker,
		saveArtifact,
	};
}
