import { workerLaunchDetail, workerLaunchSubject, workerQuestions, workerShortLabel, workerSummaryName, type WorkerStatus } from "./background-work.js";
import { readGitSnapshot } from "./git-context.js";
import type { LoadedArtifactContext } from "./loaded-artifact-context.js";
import type { ArtifactKind } from "./types.js";
import type { WorkerKindRegistry, WorkerKind } from "./worker-kinds.js";
import { resolveWorkerSpawnPolicy } from "./worker-spawn-policy.js";
import { explicitExtensionArgs, workerProjectKey, type WorkerStore } from "./worker-store.js";

export type WorkerCompletionCandidate = { value: string; label: string };

type NotifyLevel = "info" | "warning" | "error";
type DocketMessageKind = "list" | "success" | "action";

type WorkerCommandsDeps = {
	store: WorkerStore;
	loadedArtifacts: Pick<LoadedArtifactContext, "loadSource" | "unloadSource">;
	cwd: string;
	projectRoot?: string;
	parentSession?: string;
	parentModel?(): string | undefined;
	kinds: WorkerKindRegistry;
	maxActive(): number;
	captureTerminal(): boolean;
	/** Project-default kind picked when /docket spawn is invoked without --as. */
	defaultKind?(): string | undefined;
	/** Default parent-seed policy when neither the spawn flags nor the kind set one. */
	parentSeedPolicy?(): "full" | "none";
	notify(text: string, level: NotifyLevel): void;
	announce(subject: string, detail?: string, kind?: DocketMessageKind, docket?: { kind: ArtifactKind; title: string; subtitle?: string }, meta?: { workerId: string }): void;
	emitText(text: string, kind: "list", heading: string): void;
};

export type WorkerCommands = {
	spawn(task: string, options?: { worktree?: boolean; fresh?: boolean; seed?: boolean; as?: string; parentWorkerId?: string; depth?: number; layout?: "single" | "split-events"; captureTerminal?: boolean }): Promise<WorkerStatus | undefined>;
	tell(ref: string, text: string): Promise<void>;
	list(options?: { allProjects?: boolean }): Promise<void>;
	listKinds(): Promise<void>;
	delete(ref: string | undefined): Promise<void>;
	respawn(target: string): Promise<void>;
	load(ref: string | undefined): Promise<void>;
	unload(ref: string): Promise<void>;
	completionCandidates(): Promise<WorkerCompletionCandidate[]>;
};

export function workerAge(updatedAt: string): string {
	const ageMs = Date.now() - Date.parse(updatedAt);
	if (!Number.isFinite(ageMs) || ageMs < 0) return updatedAt;
	const seconds = Math.round(ageMs / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return `${hours}h ago`;
}

export async function workerCompletionCandidates(store: WorkerStore, options: { projectRoot?: string } = {}): Promise<WorkerCompletionCandidate[]> {
	try {
		const workers = await store.list(options);
		return workers.slice(-10).reverse().map((w) => ({
			value: workerShortLabel(w.index),
			label: `${workerShortLabel(w.index)}  ${w.state}  ${workerSummaryName(w, 40)}`,
		}));
	} catch {
		return [];
	}
}

function formatWorkerTell(worker: WorkerStatus, text: string): string {
	const questions = workerQuestions(worker);
	if (questions.length === 0) return `Parent message: ${text}`;
	const questionList = questions.map((question, index) => `${index + 1}) ${question.text}`).join(" ");
	return `Parent message for ${questions.length} question${questions.length === 1 ? "" : "s"}: ${questionList} Message: ${text}`;
}

function formatWorkerList(workers: WorkerStatus[], options: { groupByProject?: boolean } = {}): string {
	if (workers.length === 0) return "No Docket workers";
	const lineFor = (w: WorkerStatus) => {
		const label = workerShortLabel(w.index).padEnd(4);
		const state = (w.state ?? "?").padEnd(8);
		const kind = (w.kind ?? "default").padEnd(8);
		const artifacts = `${w.artifactCount ?? "?"} artifacts`.padEnd(14);
		const age = workerAge(w.updatedAt).padEnd(8);
		const parentTag = w.parentWorkerId ? ` ↳w${workers.find((p) => p.id === w.parentWorkerId)?.index ?? "?"}` : "";
		return `${label}  ${state}  ${kind}  ${artifacts}  ${age}  ${workerSummaryName(w, 40)}${parentTag}`;
	};
	if (!options.groupByProject) return workers.map(lineFor).join("\n");
	const groups = new Map<string, WorkerStatus[]>();
	for (const worker of workers) {
		const key = workerProjectKey(worker);
		groups.set(key, [...(groups.get(key) ?? []), worker]);
	}
	return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([project, entries]) => [`project: ${project}`, ...entries.map(lineFor)]).join("\n");
}

function formatKindList(kinds: WorkerKind[]): string {
	if (kinds.length === 0) return "No Docket worker kinds registered";
	return kinds.map((k) => {
		const ro = k.readOnly ? "ro" : "rw";
		const seed = k.parentSeedPolicy === "none" ? "fresh" : "seeded";
		const spawn = k.canSpawn.length ? `spawn:${k.canSpawn.join(",")}` : "no-spawn";
		const src = `[${k.source}]`;
		const desc = k.description ? ` — ${k.description}` : "";
		return `${k.name.padEnd(12)} ${ro} ${seed} ${spawn} ${src}${desc}`;
	}).join("\n");
}

export function createWorkerCommands(deps: WorkerCommandsDeps): WorkerCommands {
	const loadWorker = async (worker: WorkerStatus): Promise<void> => {
		const result = await deps.loadedArtifacts.loadSource({ kind: "worker", worker });
		deps.announce(
			`loaded ${result.slot.slot} · ${result.slot.artifacts.length} artifact${result.slot.artifacts.length === 1 ? "" : "s"}`,
			`${workerSummaryName(worker)}\nrefs: @${result.slot.slot}.<id>`,
			"success",
		);
	};

	return {
		async spawn(task: string, options: { worktree?: boolean; fresh?: boolean; seed?: boolean; as?: string; parentWorkerId?: string; depth?: number; layout?: "single" | "split-events"; captureTerminal?: boolean } = {}): Promise<WorkerStatus | undefined> {
			try {
				const policy = resolveWorkerSpawnPolicy({
					kinds: deps.kinds,
					options,
					configuredDefaultKind: deps.defaultKind?.(),
					configuredParentSeedPolicy: deps.parentSeedPolicy?.(),
					parentSession: deps.parentSession,
					parentModel: deps.parentModel?.(),
					captureTerminalDefault: deps.captureTerminal(),
				});
				if (policy.unknownRequestedKind) deps.notify(`Docket: unknown worker kind "${policy.unknownRequestedKind}". Try /docket kinds. Falling back to default.`, "warning");
				if (policy.unknownDefaultKind) deps.notify(`Docket: configured default worker kind "${policy.unknownDefaultKind}" not found. Falling back to default.`, "warning");
				const kind = policy.kind;
				const max = deps.maxActive();
				if (max > 0) {
					const active = await deps.store.countActive();
					if (active >= max) {
						deps.notify(`Docket: fleet cap reached (${active}/${max} active). Resolve or delete a worker before spawning another.`, "error");
						return undefined;
					}
				}
				const git = readGitSnapshot(deps.cwd);
				// When seeding is wanted but no parent session is available (e.g. worker-side
				// spawns with no parent JSONL), degrade to an explicit fresh launch rather
				// than silently passing an undefined parentSession.
				const worker = await deps.store.spawn({
					task,
					cwd: deps.cwd,
					...(policy.seedSource ? { parentSession: policy.seedSource } : {}),
					worktree: policy.useWorktree,
					...(policy.freshLaunch ? { fresh: true } : {}),
					...(git ? { git } : {}),
					kind: kind.name,
					readOnly: kind.readOnly,
					...(kind.planGate ? { planGate: true } : {}),
					...(kind.decisionRights?.length ? { decisionRights: kind.decisionRights } : {}),
					...(kind.canSpawn.length > 0 ? { canSpawn: kind.canSpawn } : {}),
					...(options.parentWorkerId ? { parentWorkerId: options.parentWorkerId } : {}),
					...(typeof options.depth === "number" ? { depth: options.depth } : {}),
					layout: policy.layout,
					...(policy.captureTerminal ? { captureTerminal: true } : {}),
					...(policy.launchArgs.length ? { extensionArgs: [...explicitExtensionArgs(), ...policy.launchArgs] } : {}),
				});
				const now = Date.parse(worker.createdAt);
				deps.announce(
					workerLaunchSubject(worker, { now }),
					workerLaunchDetail(worker, { now }),
					"action",
					undefined,
					{ workerId: worker.id },
				);
				return worker;
			} catch (err) {
				deps.notify(`Docket spawn failed: ${String(err)}`, "error");
				return undefined;
			}
		},
		async tell(ref: string, text: string): Promise<void> {
			const worker = await deps.store.find(ref);
			if (!worker) {
				deps.notify("Docket worker not found", "error");
				return;
			}
			const sent = await deps.store.sendInput(worker.id, formatWorkerTell(worker, text));
			if (sent) deps.announce(
				`told ${workerShortLabel(worker.index)}`,
				text,
				"success",
				{ kind: "prompt", title: `tell ${workerShortLabel(worker.index)}`, subtitle: workerSummaryName(worker) },
			);
			else deps.notify(`Docket could not send message to ${workerShortLabel(worker.index)}`, "error");
		},
		async list(options: { allProjects?: boolean } = {}): Promise<void> {
			const projectRoot = options.allProjects ? undefined : deps.projectRoot;
			deps.emitText(formatWorkerList(await deps.store.list({ ...(projectRoot ? { projectRoot } : {}) }), { groupByProject: options.allProjects === true }), "list", "docket · workers");
		},
		async listKinds(): Promise<void> {
			deps.emitText(formatKindList(deps.kinds.list()), "list", "docket · worker kinds");
		},
		async delete(ref: string | undefined): Promise<void> {
			if (!ref) {
				deps.notify("Usage: /docket delete w<N>", "error");
				return;
			}
			const worker = await deps.store.find(ref);
			if (!worker) {
				deps.notify("Docket worker not found", "error");
				return;
			}
			deps.loadedArtifacts.unloadSource("worker", worker.id);
			const purged = await deps.store.purge(worker.id, { cascade: true });
			const childCount = Math.max(0, purged.length - 1);
			const cascadeNote = childCount > 0 ? `\ncascade: purged ${childCount} child worker${childCount === 1 ? "" : "s"}` : "";
			deps.announce(`worker ${workerShortLabel(worker.index)} killed`, `${workerSummaryName(worker)}\nid: ${worker.id}${worker.worktree ? `\nremoved workspace: ${worker.worktree.path}` : ""}${cascadeNote}`);
		},
		async respawn(target: string): Promise<void> {
			const ALL = target.toLowerCase() === "all";
			const candidates = ALL
				? (await deps.store.list()).filter((w) => ["ended", "error", "failed"].includes(w.state))
				: await (async () => {
					const w = await deps.store.find(target);
					return w ? [w] : [];
				})();
			if (candidates.length === 0) {
				deps.notify(ALL ? "Docket: no relaunch-eligible workers" : "Docket worker not found", "warning");
				return;
			}
			const ok: string[] = [];
			const failed: { label: string; error: string }[] = [];
			for (const worker of candidates) {
				try {
					const result = await deps.store.respawn(worker.id);
					if (result) ok.push(workerShortLabel(result.index));
					else failed.push({ label: workerShortLabel(worker.index), error: "no status" });
				} catch (err) {
					failed.push({ label: workerShortLabel(worker.index), error: String(err) });
				}
			}
			if (ok.length > 0) deps.announce(`respawned ${ok.length} worker${ok.length === 1 ? "" : "s"}`, ok.join(", "), "success");
			if (failed.length > 0) deps.notify(`Docket respawn failed for: ${failed.map((entry) => `${entry.label} (${entry.error})`).join(", ")}`, "error");
		},
		async load(ref: string | undefined): Promise<void> {
			if (!ref) {
				deps.notify("Usage: /docket load w<N>", "error");
				return;
			}
			try {
				const worker = await deps.store.find(ref);
				if (!worker) {
					deps.notify("Docket worker not found", "error");
					return;
				}
				await loadWorker(worker);
			} catch (err) {
				deps.notify(`Docket load failed: ${String(err)}`, "error");
			}
		},
		async unload(ref: string): Promise<void> {
			const worker = await deps.store.find(ref);
			const removed = worker ? deps.loadedArtifacts.unloadSource("worker", worker.id) : undefined;
			if (removed) deps.announce(`unloaded ${removed.slot}`, worker ? workerSummaryName(worker) : undefined);
			else deps.notify("Docket worker not loaded", "warning");
		},
		completionCandidates(): Promise<WorkerCompletionCandidate[]> {
			return workerCompletionCandidates(deps.store, { ...(deps.projectRoot ? { projectRoot: deps.projectRoot } : {}) });
		},
	};
}
