import type { WorkerKind, WorkerKindRegistry, WorkerLayout, WorkerParentSeedPolicy } from "./worker-kinds.js";
import { normalizeWorkerKindName } from "./worker-kinds.js";

export type WorkerSpawnOptions = {
	as?: string;
	fresh?: boolean;
	seed?: boolean;
	worktree?: boolean;
	layout?: WorkerLayout;
	captureTerminal?: boolean;
};

export type ResolvedWorkerSpawnPolicy = {
	kind: WorkerKind;
	unknownRequestedKind?: string;
	unknownDefaultKind?: string;
	seedSource?: string;
	freshLaunch: boolean;
	useWorktree: boolean;
	captureTerminal: boolean;
	layout: WorkerLayout;
	launchArgs: string[];
};

export function qualifiedModelRef(model: { provider: string; id: string } | undefined): string | undefined {
	if (!model?.provider || !model.id) return undefined;
	return `${model.provider}/${model.id}`;
}

function kindExists(kinds: WorkerKindRegistry, name: string | undefined): boolean {
	const normalized = normalizeWorkerKindName(name);
	return normalized ? kinds.names().includes(normalized) : false;
}

function resolveKind(kinds: WorkerKindRegistry, requestedName: string | undefined, configuredDefault: string | undefined): Pick<ResolvedWorkerSpawnPolicy, "kind" | "unknownRequestedKind" | "unknownDefaultKind"> {
	if (requestedName?.trim()) {
		if (kindExists(kinds, requestedName)) return { kind: kinds.get(normalizeWorkerKindName(requestedName)) };
		return { kind: kinds.defaultKind(configuredDefault), unknownRequestedKind: requestedName.trim() };
	}
	if (configuredDefault?.trim() && !kindExists(kinds, configuredDefault)) {
		return { kind: kinds.defaultKind(configuredDefault), unknownDefaultKind: configuredDefault.trim() };
	}
	return { kind: kinds.defaultKind(configuredDefault) };
}

export function workerKindLaunchArgs(kind: Pick<WorkerKind, "model" | "thinking">, defaults: { model?: string } = {}): string[] {
	const args: string[] = [];
	const model = kind.model ?? defaults.model;
	if (model) args.push("--model", model);
	if (kind.thinking) args.push("--thinking", kind.thinking);
	return args;
}

export function resolveWorkerSpawnPolicy(input: {
	kinds: WorkerKindRegistry;
	options?: WorkerSpawnOptions;
	configuredDefaultKind?: string;
	configuredParentSeedPolicy?: WorkerParentSeedPolicy;
	parentSession?: string;
	parentModel?: string;
	captureTerminalDefault?: boolean;
}): ResolvedWorkerSpawnPolicy {
	const options = input.options ?? {};
	const kindResult = resolveKind(input.kinds, options.as, input.configuredDefaultKind);
	const kind = kindResult.kind;
	const wantSeed = options.fresh !== true && (
		options.seed === true ||
		kind.parentSeedPolicy === "full" ||
		input.configuredParentSeedPolicy === "full"
	);
	const seedSource = wantSeed ? input.parentSession : undefined;
	return {
		...kindResult,
		kind,
		...(seedSource ? { seedSource } : {}),
		freshLaunch: !wantSeed || !seedSource,
		useWorktree: options.worktree === true || kind.defaultWorktree,
		captureTerminal: options.captureTerminal === true || input.captureTerminalDefault === true,
		layout: options.layout ?? kind.layout,
		launchArgs: workerKindLaunchArgs(kind, { model: input.parentModel }),
	};
}
