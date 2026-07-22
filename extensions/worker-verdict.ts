import { deriveWorkerState, workerQuestions, workerShortLabel, workerSourceLabel, workerStatusArtifact, type WorkerStatus } from "./background-work.js";
import type { DecisionRecord, DecisionVerb } from "./decision-log.js";
import { sameWorkerDeliverablePointer, workerDeliverableArtifact, workerDeliverablePointer, type WorkerDeliverable } from "./worker-deliverable.js";
import type { Artifact } from "./types.js";
import { workerChangeSetArtifact } from "./worker-changes.js";
import type { WorkerCommands } from "./worker-commands.js";
import type { WorkerStore } from "./worker-store.js";
import { workerInProject } from "./worker-store.js";
import type { WorkerChangeReviewOutcome, WorkerChangeReviewPreference } from "./worker-change-review.js";
import { isReviewableWorker, verdictResolvedTransition } from "./worker-lifecycle.js";

export type DocketVerdictAction = {
	verb: "accept" | "reject" | "rejectStop" | "chat" | "diff" | "hunk" | "send" | "report" | "use" | "save";
	worker: WorkerStatus;
	changeSet?: Artifact;
	deliverable?: WorkerDeliverable;
	text?: string;
};

type NotifyLevel = "info" | "warning" | "error";

export type WorkerVerdictDeps = {
	hasUI: boolean;
	projectRoot?: string;
	workerStore: Pick<WorkerStore, "find" | "list" | "updateStatus"> & { readCurrentDeliverable?: WorkerStore["readCurrentDeliverable"] };
	workerCommands: Pick<WorkerCommands, "tell" | "delete" | "respawn">;
	notify(text: string, level: NotifyLevel): void;
	showVerdict(worker: WorkerStatus, remaining?: number): Promise<DocketVerdictAction | null>;
	showReport(worker: WorkerStatus, deliverable?: WorkerDeliverable): Promise<void>;
	confirmDeleteWorker(worker: WorkerStatus): Promise<boolean>;
	showText(title: string, text: string, options?: { diff?: boolean }): Promise<void>;
	formatArtifact(artifact: Artifact): string;
	input(title: string, placeholder: string): Promise<string | undefined>;
	/** Multiline revision-note editor when UI supports it. */
	reviewNote?(title: string, prefill: string): Promise<string | undefined>;
	/** Use is separate from approval and never writes a verdict/lifecycle state. */
	useDeliverable?(worker: WorkerStatus, deliverable: WorkerDeliverable): Promise<void>;
	saveWorkerDeliverable?(worker: WorkerStatus, deliverable: WorkerDeliverable): Promise<void>;
	isDeliverableApproved?(deliverable: WorkerDeliverable): Promise<boolean>;
	promoteWorkerChangeSet(artifact: Artifact): Promise<boolean>;
	markArtifactDone(artifact: Artifact): void;
	reviewWorkerChangeSet(worker: WorkerStatus, changeSet: Artifact, options: { preferred: WorkerChangeReviewPreference; deliverable?: Pick<WorkerDeliverable, "ref" | "version"> }): Promise<WorkerChangeReviewOutcome>;
	refreshWorkerDockWidget(): Promise<void>;
	recordDecision(record: DecisionRecord): Promise<void>;
};

function projectWorker(deps: WorkerVerdictDeps, worker: WorkerStatus): boolean {
	return !deps.projectRoot || workerInProject(worker, deps.projectRoot);
}

export function workerHasChangeSet(worker: WorkerStatus, deliverable?: WorkerDeliverable): Artifact | undefined {
	const state = deriveWorkerState(worker);
	if (state !== "ready" && state !== "ready_open_todos" && state !== "reviewed") return undefined;
	return workerChangeSetArtifact(worker, deliverable);
}

export function verdictCandidateRank(worker: WorkerStatus): number {
	// Rank on cheap derived state only. Change sets are computed lazily for the single
	// opened verdict card, so N ready workers do not trigger N git stage/diff calls.
	if (!isReviewableWorker(worker)) return 100;
	const state = deriveWorkerState(worker);
	if (state === "needs_input") return 0;
	if (state === "failed") return 1;
	if (state === "ready" || state === "ready_open_todos") return 2;
	return 100;
}

export async function rankedVerdictWorkers(deps: WorkerVerdictDeps, exclude?: Set<string>): Promise<WorkerStatus[]> {
	const workers = await deps.workerStore.list({ ...(deps.projectRoot ? { projectRoot: deps.projectRoot } : {}) });
	return workers
		.filter((worker) => !exclude?.has(worker.id))
		.map((worker) => ({ worker, rank: verdictCandidateRank(worker) }))
		.filter((entry) => entry.rank < 100)
		.sort((a, b) => a.rank - b.rank || Date.parse(b.worker.updatedAt) - Date.parse(a.worker.updatedAt))
		.map((entry) => entry.worker);
}

export async function findVerdictWorker(deps: WorkerVerdictDeps, ref?: string): Promise<WorkerStatus | undefined> {
	if (ref) {
		const worker = await deps.workerStore.find(ref);
		return worker && projectWorker(deps, worker) ? worker : undefined;
	}
	return (await rankedVerdictWorkers(deps))[0];
}

function decisionState(worker: WorkerStatus) {
	return deriveWorkerState(worker.reviewedAt ? { ...worker, reviewedAt: undefined } : worker);
}

function visibleDecisionContext(worker: WorkerStatus, changeSet: Artifact | undefined, deliverable?: WorkerDeliverable): { risk?: string; evidenceRefs: string[] } {
	const statusArtifact = workerStatusArtifact(worker);
	const questions = workerQuestions(worker);
	const risk = questions.length > 0 ? questions[questions.length - 1]?.risk : undefined;
	const evidenceRefs = deliverable
		? [deliverable.ref, changeSet?.ref].filter((ref): ref is string => typeof ref === "string" && ref.length > 0)
		: [changeSet?.ref, statusArtifact?.ref].filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
	return { ...(risk ? { risk } : {}), evidenceRefs };
}

async function recordDecision(deps: WorkerVerdictDeps, worker: WorkerStatus, verb: DecisionVerb, option: string | undefined, changeSet: Artifact | undefined, deliverable?: WorkerDeliverable, reviewNote?: string): Promise<void> {
	const context = visibleDecisionContext(worker, changeSet, deliverable);
	await deps.recordDecision({
		workerId: worker.id,
		workerLabel: workerShortLabel(worker.index),
		state: decisionState(worker),
		verb,
		...(option ? { option } : {}),
		...(context.risk ? { risk: context.risk } : {}),
		evidenceRefs: context.evidenceRefs,
		...(deliverable ? { deliverableId: deliverable.id, deliverableVersion: deliverable.version, deliverableRef: deliverable.ref } : {}),
		...(reviewNote ? { reviewNote } : {}),
		...(worker.task ? { task: worker.task } : {}),
	});
}

/**
 * Mark a worker reviewed so it stops demanding attention in the dock. Set only on
 * terminal verdicts that close out a ready or failed worker. Live-keeping verdicts
 * (needs_input send/chat/reject, failed retry, ready chat-back-for-revision) do NOT
 * set it — the worker is still in play.
 */
async function markReviewed(deps: WorkerVerdictDeps, worker: WorkerStatus, deliverable?: WorkerDeliverable): Promise<void> {
	try {
		await deps.workerStore.updateStatus(worker.id, verdictResolvedTransition(new Date().toISOString(), deliverable ? workerDeliverablePointer(deliverable) : undefined));
	} catch {
		// best-effort: the decision ledger is the source of truth; never block on this.
	}
}

export async function runWorkerVerdict(deps: WorkerVerdictDeps, worker: WorkerStatus, remaining = 0): Promise<"advance" | "stop"> {
	if (!deps.hasUI) {
		deps.notify("Docket verdict needs UI. Use /docket tell, /docket load, or /docket delete.", "error");
		return "stop";
	}
	let cardWorker = worker;
	while (true) {
		const result = await deps.showVerdict(cardWorker, remaining);
		if (!result) return "stop";
		const latest = await deps.workerStore.find(result.worker.id) ?? result.worker;
		let deliverable = result.deliverable;
		if (!deliverable && latest.deliverable && deps.workerStore.readCurrentDeliverable) {
			deliverable = await deps.workerStore.readCurrentDeliverable(latest);
		}
		if (result.deliverable && !sameWorkerDeliverablePointer(latest.deliverable, workerDeliverablePointer(result.deliverable))) {
			deps.notify("Docket: newer deliverable published while this card was open. Reopened latest version.", "warning");
			cardWorker = latest;
			continue;
		}
		const label = workerSourceLabel(latest);
		const state = deriveWorkerState(latest);
		const changeSet = result.changeSet ?? workerHasChangeSet(latest, deliverable);
		const statusArtifact = workerStatusArtifact(latest);
		if (result.verb === "diff") {
			if (changeSet) await deps.reviewWorkerChangeSet(latest, changeSet, { preferred: "builtin", ...(deliverable ? { deliverable } : {}) });
			continue;
		}
		if (result.verb === "report") {
			await deps.showReport(latest, deliverable);
			continue;
		}
		if (result.verb === "use") {
			if (!deliverable || !deps.useDeliverable || !(await deps.isDeliverableApproved?.(deliverable) ?? false)) {
				deps.notify("Docket Use requires approval of current deliverable version.", "warning");
				continue;
			}
			await deps.useDeliverable(latest, deliverable);
			await deps.refreshWorkerDockWidget();
			return "stop";
		}
		if (result.verb === "save") {
			if (!deliverable || !deps.saveWorkerDeliverable) continue;
			await deps.saveWorkerDeliverable(latest, deliverable);
			await deps.refreshWorkerDockWidget();
			return "stop";
		}
		if (result.verb === "hunk") {
			if (!changeSet) continue;
			const outcome = await deps.reviewWorkerChangeSet(latest, changeSet, { preferred: "hunk", ...(deliverable ? { deliverable } : {}) });
			if (outcome.kind === "comments-sent") {
				await recordDecision(deps, latest, "chat", `Hunk review comments (${outcome.commentCount})`, changeSet, deliverable);
				await deps.refreshWorkerDockWidget();
				return "advance";
			}
			continue;
		}
		if (result.verb === "send") {
			if (!result.text || (await deps.workerCommands.tell(label, result.text)) === false) continue;
			await recordDecision(deps, latest, "send", result.text, changeSet, deliverable);
			await deps.refreshWorkerDockWidget();
			return "advance";
		}
		if (result.verb === "rejectStop") {
			if (!(await deps.confirmDeleteWorker(latest))) continue;
			await deps.workerCommands.delete(label);
			await recordDecision(deps, latest, "rejectStop", undefined, changeSet, deliverable);
			await deps.refreshWorkerDockWidget();
			return "advance";
		}
		if (result.verb === "chat") {
			const prefill = deliverable ? "" : "message to worker";
			const title = deliverable ? `Request revision · ${label} · ${deliverable.ref}` : `Chat ${label}`;
			const text = (await (deps.reviewNote?.(title, prefill) ?? deps.input(title, prefill)))?.trim();
			if (!text) continue;
			const message = deliverable ? `Request revision for ${deliverable.ref} (version ${deliverable.version}):\n${text}` : changeSet ? `revise: ${text}` : text;
			if ((await deps.workerCommands.tell(label, message)) === false) continue;
			await recordDecision(deps, latest, "chat", text, changeSet, deliverable, deliverable ? text : undefined);
			await deps.refreshWorkerDockWidget();
			return "advance";
		}
		if (result.verb === "accept") {
			if (state === "needs_input") {
				if ((await deps.workerCommands.tell(label, "Approved. Proceed.")) === false) continue;
			} else if (state === "failed") await deps.workerCommands.respawn(label);
			else if (changeSet) {
				if (await deps.promoteWorkerChangeSet(changeSet)) {
					deps.markArtifactDone(changeSet);
					await recordDecision(deps, latest, "accept", undefined, changeSet, deliverable);
					await markReviewed(deps, latest, deliverable);
					await deps.refreshWorkerDockWidget();
					return "advance";
				}
				continue;
			} else if (deliverable) {
				deps.markArtifactDone(workerDeliverableArtifact(deliverable));
				await recordDecision(deps, latest, "accept", undefined, changeSet, deliverable);
				await markReviewed(deps, latest, deliverable);
				await deps.refreshWorkerDockWidget();
				return "advance";
			} else if (statusArtifact) {
				deps.markArtifactDone(statusArtifact);
				await recordDecision(deps, latest, "accept", undefined, changeSet);
				await markReviewed(deps, latest);
				await deps.refreshWorkerDockWidget();
				return "advance";
			}
			await recordDecision(deps, latest, "accept", undefined, changeSet, deliverable);
			await deps.refreshWorkerDockWidget();
			return "advance";
		}
		if (result.verb === "reject") {
			if (state === "needs_input") {
				const text = (await deps.input(`Reject ${label}`, "what should the worker do instead?"))?.trim();
				if (!text) continue;
				if ((await deps.workerCommands.tell(label, text)) === false) continue;
				await recordDecision(deps, latest, "reject", text, changeSet, deliverable);
			} else {
				if (changeSet) deps.markArtifactDone(changeSet);
				else if (deliverable) deps.markArtifactDone(workerDeliverableArtifact(deliverable));
				else if (statusArtifact) deps.markArtifactDone(statusArtifact);
				await recordDecision(deps, latest, "reject", undefined, changeSet, deliverable);
				await markReviewed(deps, latest, deliverable);
			}
			await deps.refreshWorkerDockWidget();
			return "advance";
		}
	}
}

export async function runWorkerVerdictQueue(deps: WorkerVerdictDeps, first: WorkerStatus): Promise<void> {
	const resolved = new Set<string>();
	let current: WorkerStatus | undefined = first;
	while (current) {
		const others = (await rankedVerdictWorkers(deps, resolved)).filter((entry) => entry.id !== current!.id);
		const outcome = await runWorkerVerdict(deps, current, others.length);
		if (outcome === "stop") return;
		resolved.add(current.id);
		current = (await rankedVerdictWorkers(deps, resolved))[0];
	}
}
