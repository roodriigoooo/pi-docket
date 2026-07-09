import { deriveWorkerState, workerQuestions, workerShortLabel, workerSourceLabel, workerStatusArtifact, type WorkerStatus } from "./background-work.js";
import type { DecisionRecord, DecisionVerb } from "./decision-log.js";
import type { Artifact } from "./types.js";
import { workerChangeSetArtifact } from "./worker-changes.js";
import type { WorkerCommands } from "./worker-commands.js";
import type { WorkerStore } from "./worker-store.js";
import { workerInProject } from "./worker-store.js";
import type { WorkerChangeReviewOutcome, WorkerChangeReviewPreference } from "./worker-change-review.js";

export type DocketVerdictAction = {
	verb: "accept" | "reject" | "rejectStop" | "chat" | "diff" | "hunk" | "send";
	worker: WorkerStatus;
	changeSet?: Artifact;
	text?: string;
};

type NotifyLevel = "info" | "warning" | "error";

export type WorkerVerdictDeps = {
	hasUI: boolean;
	projectRoot?: string;
	workerStore: Pick<WorkerStore, "find" | "list" | "patchStatus">;
	workerCommands: Pick<WorkerCommands, "tell" | "delete" | "respawn">;
	notify(text: string, level: NotifyLevel): void;
	showVerdict(worker: WorkerStatus, remaining?: number): Promise<DocketVerdictAction | null>;
	confirmDeleteWorker(worker: WorkerStatus): Promise<boolean>;
	showText(title: string, text: string, options?: { diff?: boolean }): Promise<void>;
	formatArtifact(artifact: Artifact): string;
	input(title: string, placeholder: string): Promise<string | undefined>;
	promoteWorkerChangeSet(artifact: Artifact): Promise<boolean>;
	markArtifactDone(artifact: Artifact): void;
	reviewWorkerChangeSet(worker: WorkerStatus, changeSet: Artifact, options: { preferred: WorkerChangeReviewPreference }): Promise<WorkerChangeReviewOutcome>;
	refreshWorkerDockWidget(): Promise<void>;
	recordDecision(record: DecisionRecord): Promise<void>;
};

function projectWorker(deps: WorkerVerdictDeps, worker: WorkerStatus): boolean {
	return !deps.projectRoot || workerInProject(worker, deps.projectRoot);
}

export function workerHasChangeSet(worker: WorkerStatus): Artifact | undefined {
	const state = deriveWorkerState(worker);
	if (state !== "ready" && state !== "ready_open_todos") return undefined;
	return workerChangeSetArtifact(worker);
}

export function verdictCandidateRank(worker: WorkerStatus): number {
	// Rank on cheap derived state only. Change sets are computed lazily for the single
	// opened verdict card, so N ready workers do not trigger N git stage/diff calls.
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

function visibleDecisionContext(worker: WorkerStatus, changeSet: Artifact | undefined): { risk?: string; evidenceRefs: string[] } {
	const statusArtifact = workerStatusArtifact(worker);
	const questions = workerQuestions(worker);
	const risk = questions.length > 0 ? questions[questions.length - 1]?.risk : undefined;
	const evidenceRefs = [changeSet?.ref, statusArtifact?.ref].filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
	return { ...(risk ? { risk } : {}), evidenceRefs };
}

async function recordDecision(deps: WorkerVerdictDeps, worker: WorkerStatus, verb: DecisionVerb, option: string | undefined, changeSet: Artifact | undefined): Promise<void> {
	const context = visibleDecisionContext(worker, changeSet);
	await deps.recordDecision({
		workerId: worker.id,
		workerLabel: workerShortLabel(worker.index),
		state: deriveWorkerState(worker),
		verb,
		...(option ? { option } : {}),
		...(context.risk ? { risk: context.risk } : {}),
		evidenceRefs: context.evidenceRefs,
		...(worker.task ? { task: worker.task } : {}),
	});
}

/**
 * Mark a worker reviewed so it stops demanding attention in the dock. Set only on
 * terminal verdicts that close out a ready or failed worker. Live-keeping verdicts
 * (needs_input send/chat/reject, failed retry, ready chat-back-for-revision) do NOT
 * set it — the worker is still in play.
 */
async function markReviewed(deps: WorkerVerdictDeps, worker: WorkerStatus): Promise<void> {
	try {
		await deps.workerStore.patchStatus(worker.id, { reviewedAt: new Date().toISOString() });
	} catch {
		// best-effort: the decision ledger is the source of truth; never block on this.
	}
}

export async function runWorkerVerdict(deps: WorkerVerdictDeps, worker: WorkerStatus, remaining = 0): Promise<"advance" | "stop"> {
	if (!deps.hasUI) {
		deps.notify("Docket verdict needs UI. Use /docket tell, /docket load, or /docket delete.", "error");
		return "stop";
	}
	while (true) {
		const result = await deps.showVerdict(worker, remaining);
		if (!result) return "stop";
		const latest = await deps.workerStore.find(result.worker.id) ?? result.worker;
		const label = workerSourceLabel(latest);
		const state = deriveWorkerState(latest);
		const changeSet = result.changeSet ?? workerHasChangeSet(latest);
		const statusArtifact = workerStatusArtifact(latest);
		if (result.verb === "diff") {
			if (changeSet) await deps.reviewWorkerChangeSet(latest, changeSet, { preferred: "builtin" });
			continue;
		}
		if (result.verb === "hunk") {
			if (!changeSet) continue;
			const outcome = await deps.reviewWorkerChangeSet(latest, changeSet, { preferred: "hunk" });
			if (outcome.kind === "comments-sent") {
				await recordDecision(deps, latest, "chat", `Hunk review comments (${outcome.commentCount})`, changeSet);
				await deps.refreshWorkerDockWidget();
				return "advance";
			}
			continue;
		}
		if (result.verb === "send") {
			if (result.text) await deps.workerCommands.tell(label, result.text);
			await recordDecision(deps, latest, "send", result.text, changeSet);
			await deps.refreshWorkerDockWidget();
			return "advance";
		}
		if (result.verb === "rejectStop") {
			if (!(await deps.confirmDeleteWorker(latest))) continue;
			await deps.workerCommands.delete(label);
			await recordDecision(deps, latest, "rejectStop", undefined, changeSet);
			await deps.refreshWorkerDockWidget();
			return "advance";
		}
		if (result.verb === "chat") {
			const text = (await deps.input(`Chat ${label}`, "message to worker"))?.trim();
			if (!text) continue;
			await deps.workerCommands.tell(label, changeSet ? `revise: ${text}` : text);
			await recordDecision(deps, latest, "chat", text, changeSet);
			await deps.refreshWorkerDockWidget();
			return "advance";
		}
		if (result.verb === "accept") {
			if (state === "needs_input") await deps.workerCommands.tell(label, "Approved. Proceed.");
			else if (state === "failed") await deps.workerCommands.respawn(label);
			else if (changeSet) {
				if (await deps.promoteWorkerChangeSet(changeSet)) deps.markArtifactDone(changeSet);
				await markReviewed(deps, latest);
			} else if (statusArtifact) {
				deps.markArtifactDone(statusArtifact);
				await markReviewed(deps, latest);
			}
			await recordDecision(deps, latest, "accept", undefined, changeSet);
			await deps.refreshWorkerDockWidget();
			return "advance";
		}
		if (result.verb === "reject") {
			if (state === "needs_input") {
				const text = (await deps.input(`Reject ${label}`, "what should the worker do instead?"))?.trim();
				if (!text) continue;
				await deps.workerCommands.tell(label, text);
				await recordDecision(deps, latest, "reject", text, changeSet);
			} else {
				if (changeSet) deps.markArtifactDone(changeSet);
				else if (statusArtifact) deps.markArtifactDone(statusArtifact);
				await markReviewed(deps, latest);
				await recordDecision(deps, latest, "reject", undefined, changeSet);
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
