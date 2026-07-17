import type { WorkerHandoffProvenance, WorkerDeliverable } from "./worker-deliverable.js";

export type WorkerHandoffModel = {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
};

export type WorkerHandoffChoice = {
	task: string;
	kind: string;
	model: string;
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	sourceRef: string;
};

export const HANDOFF_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

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

export function handoffThinkingChoices(model: Pick<WorkerHandoffModel, "reasoning"> | undefined): Array<(typeof HANDOFF_THINKING_LEVELS)[number]> {
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
		sourceWorkerId: deliverable.source.workerId,
		sourceWorkerLabel: deliverable.source.workerLabel,
		approvingDecisionId: decision.id ?? `legacy-approval:${deliverable.ref}`,
		approvedAt: decision.timestamp,
		sidecarPath: options.sidecarPath ?? "source-deliverable.md",
	};
}

export function formatWorkerHandoffConfirmation(choice: WorkerHandoffChoice): string {
	return [
		`Task: ${choice.task}`,
		`Kind: ${choice.kind}`,
		`Model: ${choice.model}`,
		`Thinking: ${choice.thinking}`,
		`Reviewed source: ${choice.sourceRef}`,
		"Starts one fresh worker. Parent transcript is not seeded.",
	].join("\n");
}
