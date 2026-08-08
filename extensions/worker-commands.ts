import { workerLaunchDetail, workerLaunchSubject, workerQuestions, workerShortLabel, workerSummaryName, type WorkerQuestion, type WorkerStatus } from "./background-work.js";
import { readGitSnapshot } from "./git-context.js";
import type { LoadedArtifactContext } from "./loaded-artifact-context.js";
import type { ArtifactKind } from "./types.js";
import type { WorkerKindRegistry, WorkerKind } from "./worker-kinds.js";
import { workerKindCompatibility } from "./worker-kinds.js";
import { formatWorkerLaunchSummary, resolveWorkerSpawnPolicy, type WorkerExecutionModel, type WorkerThinking } from "./worker-spawn-policy.js";
import { explicitExtensionArgs, workerProjectKey, type WorkerStore } from "./worker-store.js";
import type { WorkerHandoffProvenance } from "./worker-deliverable.js";
import type { WorkerMessageDeliverAs, WorkerMessageTransport } from "./worker-mailbox.js";

export type WorkerCompletionCandidate = { value: string; label: string };

export type WorkerTellOptions = {
	/** Question id this reply resolves. Other open questions stay open. */
	replyTo?: string;
	/** Where the message lands in the worker's loop; defaults to steering the current turn. */
	deliverAs?: WorkerMessageDeliverAs;
};

type NotifyLevel = "info" | "warning" | "error";
type DocketMessageKind = "list" | "success" | "action";

export type WorkerAnnounceMeta = {
	workerId?: string;
	sentMessage?: { workerId: string; workerLabel: string; messageId: string; transport: WorkerMessageTransport };
};

type WorkerCommandsDeps = {
	store: WorkerStore;
	loadedArtifacts: Pick<LoadedArtifactContext, "loadSource" | "unloadSource">;
	cwd: string;
	projectRoot?: string;
	parentSession?: string;
	parentModel(): string | undefined;
	parentThinking(): string | undefined;
	availableModels(): readonly WorkerExecutionModel[];
	kinds: WorkerKindRegistry;
	maxActive(): number;
	/** Project-default kind picked when /docket spawn is invoked without --as. */
	defaultKind?(): string | undefined;
	/** Default parent-seed policy when neither spawn flags nor legacy kind metadata set one. */
	parentSeedPolicy?(): "full" | "none" | undefined;
	/** Absolute bulletin path, when this project has standing notes worth pointing a worker at. */
	bulletinPath?(): string | undefined;
	hasUI: boolean;
	confirmSpawn(title: string, detail: string): Promise<boolean>;
	notify(text: string, level: NotifyLevel): void;
	announce(subject: string, detail?: string, kind?: DocketMessageKind, docket?: { kind: ArtifactKind; title: string; subtitle?: string }, meta?: WorkerAnnounceMeta): void;
	emitText(text: string, kind: "list", heading: string): void;
};

export type WorkerCommandSpawnOptions = {
	worktree?: boolean;
	fresh?: boolean;
	seed?: boolean;
	as?: string;
	model?: string;
	thinking?: WorkerThinking;
	sourceDeliverable?: { body: string; provenance: WorkerHandoffProvenance };
	/** Reviewed Use → Implement launches: the approved plan discharges the kind's plan gate. */
	planAuthorized?: boolean;
	/** Internal handoff guard checked after confirmation and before filesystem/tmux work. */
	authorizeLaunch?: () => Promise<boolean>;
};

export type WorkerCommands = {
	spawn(task: string, options?: WorkerCommandSpawnOptions): Promise<WorkerStatus | undefined>;
	tell(ref: string, text: string, options?: WorkerTellOptions): Promise<boolean | void>;
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

/**
 * Which question this reply answers.
 *
 * An explicit id wins. With exactly one question open the binding is unambiguous, so it is
 * inferred; with several it is not, and guessing would resolve a question nobody answered. An
 * unbound reply is a redirection — the worker resumes and re-asks anything still blocking it.
 */
export function resolveAnsweredQuestion(worker: WorkerStatus, replyTo?: string): WorkerQuestion | undefined {
	const questions = workerQuestions(worker);
	if (replyTo) return questions.find((question) => question.id === replyTo);
	return questions.length === 1 ? questions[0] : undefined;
}

function formatWorkerList(workers: WorkerStatus[], options: { groupByProject?: boolean } = {}): string {
	if (workers.length === 0) return "No Docket workers";
	const lineFor = (w: WorkerStatus) => {
		const label = workerShortLabel(w.index).padEnd(4);
		const state = (w.state ?? "?").padEnd(8);
		const kind = (w.kind ?? "default").padEnd(8);
		const artifacts = `${w.artifactCount ?? "?"} artifacts`.padEnd(14);
		const age = workerAge(w.updatedAt).padEnd(8);
		return `${label}  ${state}  ${kind}  ${artifacts}  ${age}  ${workerSummaryName(w, 40)}`;
	};
	if (!options.groupByProject) return workers.map(lineFor).join("\n");
	const groups = new Map<string, WorkerStatus[]>();
	for (const worker of workers) {
		const key = workerProjectKey(worker);
		groups.set(key, [...(groups.get(key) ?? []), worker]);
	}
	return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([project, entries]) => [`project: ${project}`, ...entries.map(lineFor)]).join("\n");
}

const KIND_SOURCE_ORDER: WorkerKind["source"][] = ["builtin", "user", "runtime"];

function kindAuthority(kind: WorkerKind): string {
	return kind.readOnly ? "read-only" : kind.planGate ? "plan-gated" : "writable";
}

/**
 * One indented block per kind rather than one dense row: name and authority read as a
 * heading, everything that qualifies the kind (description, decision rights, migration
 * warnings) hangs under it, and blank lines keep neighbouring kinds from running together.
 */
function formatKindBlock(kind: WorkerKind): string[] {
	const detail = [
		...(kind.description ? [kind.description] : []),
		...(kind.decisionRights ?? []).map((right) => `rights: ${right}`),
		...(workerKindCompatibility(kind)?.diagnostics ?? []).map((message) => `warning: ${message}`),
	];
	return [`  ${kind.name} · ${kindAuthority(kind)}`, ...detail.map((line) => `    ${line}`)];
}

export function formatKindList(kinds: WorkerKind[], options: { defaultKind?: string } = {}): string {
	if (kinds.length === 0) return "No Docket worker kinds registered";
	const sources = KIND_SOURCE_ORDER.filter((source) => kinds.some((kind) => kind.source === source));
	const groups = sources.map((source) => [
		source,
		...kinds.filter((kind) => kind.source === source).flatMap((kind, index) => [...(index === 0 ? [] : [""]), ...formatKindBlock(kind)]),
	].join("\n"));
	const spawnHint = `Spawn with /docket spawn --as <kind> <task>${options.defaultKind ? ` · without --as: ${options.defaultKind}` : ""}`;
	return [...groups, spawnHint].join("\n\n");
}

export function createWorkerCommands(deps: WorkerCommandsDeps): WorkerCommands {
	const loadWorker = async (worker: WorkerStatus): Promise<void> => {
		const deliverable = await deps.store.readCurrentDeliverable?.(worker);
		if (worker.deliverable && !deliverable) throw new Error(`Worker deliverable ${worker.deliverable.ref} is missing or invalid`);
		const result = await deps.loadedArtifacts.loadSource(deliverable ? { kind: "deliverable", worker, deliverable } : { kind: "worker", worker });
		deps.announce(
			`loaded ${result.slot.slot} · ${result.slot.artifacts.length} artifact${result.slot.artifacts.length === 1 ? "" : "s"}`,
			`${workerSummaryName(worker)}\nrefs: @${result.slot.slot}.<id>`,
			"success",
		);
	};

	return {
		async spawn(task: string, options: WorkerCommandSpawnOptions = {}): Promise<WorkerStatus | undefined> {
			try {
				const handoff = options.sourceDeliverable !== undefined;
				const policy = resolveWorkerSpawnPolicy({
					kinds: deps.kinds,
					availableModels: deps.availableModels(),
					options: { ...options, ...(handoff ? { handoff: true } : {}) },
					configuredDefaultKind: deps.defaultKind?.(),
					configuredParentSeedPolicy: deps.parentSeedPolicy?.(),
					parentSession: deps.parentSession,
					parentModel: deps.parentModel(),
					parentThinking: deps.parentThinking(),
				});
				if (policy.unknownRequestedKind) deps.notify(`Docket: unknown worker kind "${policy.unknownRequestedKind}". Try /docket kinds. Using ${policy.kind.name}.`, "warning");
				if (policy.unknownDefaultKind) deps.notify(`Docket: configured default worker kind "${policy.unknownDefaultKind}" not found. Using builtin default.`, "warning");
				for (const warning of policy.warnings) deps.notify(`Docket: worker kind "${policy.kind.name}": ${warning}`, "warning");

				const max = deps.maxActive();
				if (max > 0) {
					const active = await deps.store.countActive();
					if (active >= max) {
						deps.notify(`Docket: fleet cap reached (${active}/${max} active). Resolve or delete a worker before spawning another.`, "error");
						return undefined;
					}
				}

				const launchSummary = formatWorkerLaunchSummary(policy);
				if (policy.requiresConfirmation && deps.hasUI) {
					const reviewedSource = options.sourceDeliverable?.provenance.sourceRef;
					const gateDischarged = reviewedSource !== undefined && options.planAuthorized === true && policy.kind.planGate === true;
					const detail = [
						`Task: ${task}`,
						launchSummary,
						reviewedSource ? `Reviewed source: ${reviewedSource}` : undefined,
						gateDischarged ? `Plan gate: satisfied at launch by ${reviewedSource}` : undefined,
					]
						.filter((line): line is string => line !== undefined)
						.join("\n");
					const confirmed = await deps.confirmSpawn(handoff ? "Start reviewed handoff worker?" : "Start Docket worker?", detail);
					if (!confirmed) return undefined;
				}
				if (options.authorizeLaunch && !(await options.authorizeLaunch())) return undefined;

				const kind = policy.kind;
				const git = readGitSnapshot(deps.cwd);
				const bulletinPath = deps.bulletinPath?.();
				const worker = await deps.store.spawn({
					task,
					cwd: deps.cwd,
					...(bulletinPath ? { bulletinPath } : {}),
					...(policy.seedSource ? { parentSession: policy.seedSource } : {}),
					worktree: policy.useWorktree,
					...(policy.freshLaunch ? { fresh: true } : {}),
					...(git ? { git } : {}),
					model: policy.model,
					thinking: policy.thinking,
					...(options.sourceDeliverable ? { sourceDeliverable: options.sourceDeliverable } : {}),
					// A plan can only discharge a gate through a reviewed handoff.
					...(options.sourceDeliverable && options.planAuthorized ? { planAuthorized: true } : {}),
					kind: kind.name,
					readOnly: kind.readOnly,
					...(kind.planGate ? { planGate: true } : {}),
					...(kind.decisionRights?.length ? { decisionRights: kind.decisionRights } : {}),
					extensionArgs: [...explicitExtensionArgs(), ...policy.launchArgs],
				});
				const now = Date.parse(worker.createdAt);
				deps.announce(
					workerLaunchSubject(worker, { now }),
					workerLaunchDetail(worker, { now, launchSummary }),
					"action",
					undefined,
					{ workerId: worker.id },
				);
				return worker;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				deps.notify(`Docket spawn failed: ${message}`, "error");
				return undefined;
			}
		},
		async tell(ref: string, text: string, options: WorkerTellOptions = {}): Promise<boolean> {
			const worker = await deps.store.find(ref);
			if (!worker) {
				deps.notify("Docket worker not found", "error");
				return false;
			}
			const label = workerShortLabel(worker.index);
			const question = resolveAnsweredQuestion(worker, options.replyTo);
			const result = await deps.store.sendMessage(worker.id, {
				body: text,
				...(question ? { replyTo: question.id, replyToText: question.text } : {}),
				...(options.deliverAs ? { deliverAs: options.deliverAs } : {}),
			});
			if (!result.ok) {
				deps.notify(result.reason === "empty"
					? `Docket: nothing to send to ${label}`
					: `Docket could not send message to ${label}`, "error");
				return false;
			}
			// The subject is deliberately not "told": nothing has been observed yet. The chip
			// re-reads the message and advances to delivered/read on its own.
			deps.announce(
				`tell ${label} · ${result.transport === "tmux" ? "sent to terminal · receipt unconfirmed" : "queued"}`,
				text,
				"success",
				{ kind: "prompt", title: `tell ${label}`, subtitle: workerSummaryName(worker) },
				{ sentMessage: { workerId: worker.id, workerLabel: label, messageId: result.message.id, transport: result.transport } },
			);
			return true;
		},
		async list(options: { allProjects?: boolean } = {}): Promise<void> {
			const projectRoot = options.allProjects ? undefined : deps.projectRoot;
			deps.emitText(formatWorkerList(await deps.store.list({ ...(projectRoot ? { projectRoot } : {}) }), { groupByProject: options.allProjects === true }), "list", "docket · workers");
		},
		async listKinds(): Promise<void> {
			const fallback = deps.kinds.defaultKind(deps.defaultKind?.()).name;
			deps.emitText(formatKindList(deps.kinds.list(), { defaultKind: fallback }), "list", "docket · worker kinds");
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
			await deps.store.purge(worker.id);
			deps.announce(`worker ${workerShortLabel(worker.index)} killed`, `${workerSummaryName(worker)}\nid: ${worker.id}${worker.worktree ? `\nremoved workspace: ${worker.worktree.path}` : ""}`);
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
