import type { WorkerKind, WorkerKindRegistry, WorkerLayout, WorkerParentSeedPolicy } from "./worker-kinds.js";
import { normalizeWorkerKindName, workerKindCompatibility } from "./worker-kinds.js";

export const WORKER_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type WorkerThinking = (typeof WORKER_THINKING_LEVELS)[number];

export type WorkerExecutionModel = {
	provider: string;
	id: string;
	reasoning: boolean;
};

export type WorkerSpawnOptions = {
	as?: string;
	fresh?: boolean;
	seed?: boolean;
	worktree?: boolean;
	captureTerminal?: boolean;
	model?: string;
	thinking?: string;
	/** Internal marker for reviewed Use → Worker launches. */
	handoff?: boolean;
};

export type ResolvedWorkerSpawnPolicy = {
	kind: WorkerKind;
	kindSource: "--as" | "worker.defaultKind" | "builtin default";
	unknownRequestedKind?: string;
	unknownDefaultKind?: string;
	model: string;
	modelSource: "--model" | "handoff choice" | "deprecated kind model" | "parent";
	thinking: WorkerThinking;
	thinkingSource: "--thinking" | "handoff choice" | "deprecated kind thinking" | "parent";
	thinkingAdjustedFrom?: WorkerThinking;
	context: "fresh" | "seeded";
	contextSource: "handoff forced-fresh" | "--fresh" | "--seed" | "worker.parentSeedPolicy" | "deprecated kind parent_seed" | "fresh default";
	seedSource?: string;
	freshLaunch: boolean;
	useWorktree: boolean;
	workspaceSource: "--worktree" | "deprecated kind default_worktree" | "kind intent";
	captureTerminal: boolean;
	layout: WorkerLayout;
	layoutSource: "deprecated kind layout" | "single default";
	launchArgs: string[];
	legacyContributions: string[];
	warnings: string[];
	requiresConfirmation: boolean;
};

export class WorkerSpawnPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerSpawnPolicyError";
	}
}

export function isWorkerThinking(value: unknown): value is WorkerThinking {
	return typeof value === "string" && (WORKER_THINKING_LEVELS as readonly string[]).includes(value);
}

export function qualifiedModelRef(model: { provider: string; id: string } | undefined): string | undefined {
	if (!model?.provider || !model.id) return undefined;
	return `${model.provider}/${model.id}`;
}

function kindExists(kinds: WorkerKindRegistry, name: string | undefined): boolean {
	const normalized = normalizeWorkerKindName(name);
	return normalized ? kinds.names().includes(normalized) : false;
}

function resolveDefaultKind(kinds: WorkerKindRegistry, configuredDefault: string | undefined): Pick<ResolvedWorkerSpawnPolicy, "kind" | "kindSource" | "unknownDefaultKind"> {
	if (configuredDefault?.trim()) {
		if (kindExists(kinds, configuredDefault)) {
			return { kind: kinds.get(normalizeWorkerKindName(configuredDefault)), kindSource: "worker.defaultKind" };
		}
		return { kind: kinds.defaultKind(), kindSource: "builtin default", unknownDefaultKind: configuredDefault.trim() };
	}
	return { kind: kinds.defaultKind(), kindSource: "builtin default" };
}

function resolveKind(kinds: WorkerKindRegistry, requestedName: string | undefined, configuredDefault: string | undefined): Pick<ResolvedWorkerSpawnPolicy, "kind" | "kindSource" | "unknownRequestedKind" | "unknownDefaultKind"> {
	if (requestedName?.trim()) {
		if (kindExists(kinds, requestedName)) {
			return { kind: kinds.get(normalizeWorkerKindName(requestedName)), kindSource: "--as" };
		}
		return { ...resolveDefaultKind(kinds, configuredDefault), unknownRequestedKind: requestedName.trim() };
	}
	return resolveDefaultKind(kinds, configuredDefault);
}

function exactAvailableModel(ref: string, availableModels: readonly WorkerExecutionModel[]): WorkerExecutionModel {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) {
		throw new WorkerSpawnPolicyError(`Model "${ref}" must be an exact provider/model reference.`);
	}
	const provider = ref.slice(0, slash);
	const id = ref.slice(slash + 1);
	const model = availableModels.find((candidate) => candidate.provider === provider && candidate.id === id);
	if (!model || qualifiedModelRef(model) !== ref) {
		throw new WorkerSpawnPolicyError(`Model "${ref}" is not available. Use an exact provider/model from Pi's available model registry.`);
	}
	return model;
}

function authorityLabel(kind: WorkerKind): string {
	if (kind.readOnly) return "read-only";
	if (kind.planGate) return "plan-gated";
	return "writable";
}

export function formatWorkerLaunchSummary(policy: ResolvedWorkerSpawnPolicy): string {
	const lines = [
		`Kind: ${policy.kind.name} · ${authorityLabel(policy.kind)}`,
		`Model: ${policy.model}`,
		`Thinking: ${policy.thinking}`,
		`Context: ${policy.context === "seeded" ? "seeded parent session" : "fresh"}`,
		`Workspace: ${policy.useWorktree ? "isolated worker workspace" : "parent directory"}`,
	];
	if (policy.thinkingAdjustedFrom) {
		lines.push(`Thinking source: inherited ${policy.thinkingAdjustedFrom} resolved to off for non-reasoning model`);
	}
	if (policy.legacyContributions.length > 0) {
		lines.push(`Deprecated kind defaults: ${policy.legacyContributions.join(", ")}`);
	}
	return lines.join("\n");
}

export function resolveWorkerSpawnPolicy(input: {
	kinds: WorkerKindRegistry;
	availableModels: readonly WorkerExecutionModel[];
	options?: WorkerSpawnOptions;
	configuredDefaultKind?: string;
	configuredParentSeedPolicy?: WorkerParentSeedPolicy;
	parentSession?: string;
	parentModel?: string;
	parentThinking?: string;
	captureTerminalDefault?: boolean;
}): ResolvedWorkerSpawnPolicy {
	const options = input.options ?? {};
	const kindResult = resolveKind(input.kinds, options.as, input.configuredDefaultKind);
	const kind = kindResult.kind;
	const compatibility = workerKindCompatibility(kind);
	const legacy = compatibility?.legacyExecution;
	const legacyContributions: string[] = [];

	let modelRef: string | undefined;
	let modelSource: ResolvedWorkerSpawnPolicy["modelSource"];
	if (options.model !== undefined) {
		modelRef = options.model;
		modelSource = options.handoff ? "handoff choice" : "--model";
	} else if (legacy?.model !== undefined) {
		modelRef = legacy.model;
		modelSource = "deprecated kind model";
		legacyContributions.push("model");
	} else {
		modelRef = input.parentModel;
		modelSource = "parent";
	}
	if (modelRef === undefined) {
		throw new WorkerSpawnPolicyError("No worker model resolved. Select a parent model or pass --model <provider/model>.");
	}
	const model = exactAvailableModel(modelRef, input.availableModels);

	let requestedThinking: string | undefined;
	let thinkingSource: ResolvedWorkerSpawnPolicy["thinkingSource"];
	if (options.thinking !== undefined) {
		requestedThinking = options.thinking;
		thinkingSource = options.handoff ? "handoff choice" : "--thinking";
	} else if (legacy?.thinking !== undefined) {
		requestedThinking = legacy.thinking;
		thinkingSource = "deprecated kind thinking";
		legacyContributions.push("thinking");
	} else {
		requestedThinking = input.parentThinking;
		thinkingSource = "parent";
	}
	if (!isWorkerThinking(requestedThinking)) {
		const shown = requestedThinking === undefined ? "unavailable" : `"${requestedThinking}"`;
		throw new WorkerSpawnPolicyError(`Worker thinking level ${shown} is invalid. Expected one of: ${WORKER_THINKING_LEVELS.join(", ")}.`);
	}
	const explicitThinking = thinkingSource !== "parent";
	if (!model.reasoning && explicitThinking && requestedThinking !== "off") {
		throw new WorkerSpawnPolicyError(`Model "${modelRef}" does not support thinking level "${requestedThinking}". Use --thinking off.`);
	}
	const thinking = model.reasoning || requestedThinking === "off" ? requestedThinking : "off";
	const thinkingAdjustedFrom = thinking !== requestedThinking ? requestedThinking : undefined;

	let wantsSeed = false;
	let contextSource: ResolvedWorkerSpawnPolicy["contextSource"] = "fresh default";
	if (options.handoff) {
		contextSource = "handoff forced-fresh";
	} else if (options.fresh === true) {
		contextSource = "--fresh";
	} else if (options.seed === true) {
		wantsSeed = true;
		contextSource = "--seed";
	} else if (input.configuredParentSeedPolicy !== undefined) {
		wantsSeed = input.configuredParentSeedPolicy === "full";
		contextSource = "worker.parentSeedPolicy";
	} else if (legacy?.parentSeedPolicy !== undefined) {
		wantsSeed = legacy.parentSeedPolicy === "full";
		contextSource = "deprecated kind parent_seed";
		legacyContributions.push("parent_seed");
	}
	const seedSource = wantsSeed ? input.parentSession : undefined;
	const warnings = [...(compatibility?.diagnostics ?? [])];
	if (wantsSeed && !seedSource) warnings.push("parent context seeding was requested, but no parent session is available; launching fresh.");

	let useWorktree: boolean;
	let workspaceSource: ResolvedWorkerSpawnPolicy["workspaceSource"];
	if (options.worktree === true) {
		useWorktree = true;
		workspaceSource = "--worktree";
	} else if (legacy?.defaultWorktree !== undefined) {
		useWorktree = legacy.defaultWorktree;
		workspaceSource = "deprecated kind default_worktree";
		legacyContributions.push("default_worktree");
	} else {
		useWorktree = !kind.readOnly;
		workspaceSource = "kind intent";
	}

	const layout = legacy?.layout ?? "single";
	const layoutSource: ResolvedWorkerSpawnPolicy["layoutSource"] = legacy?.layout !== undefined ? "deprecated kind layout" : "single default";
	if (legacy?.layout !== undefined) legacyContributions.push("layout");
	const context = seedSource ? "seeded" : "fresh";
	const requiresConfirmation = options.handoff === true
		|| modelRef !== input.parentModel
		|| thinking !== input.parentThinking
		|| legacyContributions.length > 0;

	return {
		...kindResult,
		model: modelRef,
		modelSource,
		thinking,
		thinkingSource,
		...(thinkingAdjustedFrom ? { thinkingAdjustedFrom } : {}),
		context,
		contextSource,
		...(seedSource ? { seedSource } : {}),
		freshLaunch: context === "fresh",
		useWorktree,
		workspaceSource,
		captureTerminal: options.captureTerminal === true || input.captureTerminalDefault === true,
		layout,
		layoutSource,
		launchArgs: ["--model", modelRef, "--thinking", thinking],
		legacyContributions,
		warnings,
		requiresConfirmation,
	};
}
