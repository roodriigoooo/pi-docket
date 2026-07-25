import type { WorkerHandoffProvenance, WorkerDeliverable } from "./worker-deliverable.js";
import { WORKER_THINKING_LEVELS, type WorkerThinking } from "./worker-spawn-policy.js";

export type WorkerHandoffModel = {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
};

export const HANDOFF_THINKING_LEVELS = WORKER_THINKING_LEVELS;

export function handoffModelRef(model: Pick<WorkerHandoffModel, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function availableHandoffModels(models: readonly WorkerHandoffModel[]): WorkerHandoffModel[] {
	const seen = new Set<string>();
	return models.filter((model) => {
		if (!model.provider || !model.id) return false;
		const ref = handoffModelRef(model);
		if (seen.has(ref)) return false;
		seen.add(ref);
		return true;
	});
}

export function handoffThinkingChoices(model: Pick<WorkerHandoffModel, "reasoning"> | undefined): WorkerThinking[] {
	return model?.reasoning === false ? ["off"] : [...HANDOFF_THINKING_LEVELS];
}

export function createWorkerHandoffProvenance(
	deliverable: WorkerDeliverable,
	decision: { id?: string; timestamp: string },
	options: { sidecarPath?: string } = {},
): WorkerHandoffProvenance {
	return {
		sourceDeliverableId: deliverable.id,
		sourceVersion: deliverable.version,
		sourceRef: deliverable.ref,
		sourceKind: "worker",
		sourceWorkerId: deliverable.source.workerId,
		sourceWorkerLabel: deliverable.source.workerLabel,
		approvingDecisionId: decision.id ?? `legacy-approval:${deliverable.ref}`,
		approvedAt: decision.timestamp,
		sidecarPath: options.sidecarPath ?? "source-deliverable.md",
	};
}
