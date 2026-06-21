import { spawnSync } from "node:child_process";
import { workerQuestions, workerSourceLabel, workerSummaryName, type WorkerStatus } from "./background-work.js";
import { renderDecisionLog, type DecisionEvent, type DecisionRecord } from "./decision-log.js";
import { workerResultArtifact, workerResultText } from "./worker-result.js";
import { isSharedSessionTarget, SHARED_TMUX_SESSION } from "./worker-store.js";
import type { CheckpointCommands } from "./checkpoint-commands.js";
import type { CheckpointStore, CheckpointSummary } from "./checkpoint-store.js";
import type { ArtifactCatalog } from "./artifact-catalog.js";
import type { LoadedArtifactContext, LoadResult } from "./loaded-artifact-context.js";
import type { NavigatorMode } from "./docket-navigator.js";
import type { CheckpointCreateOptions, DocketIntent } from "./docket-command-grammar.js";
import type { Artifact, CheckpointIndexEntry } from "./types.js";
import type { WorkerCommands } from "./worker-commands.js";
import type { WorkerStore } from "./worker-store.js";
import { findVerdictWorker, runWorkerVerdict, runWorkerVerdictQueue, type DocketVerdictAction } from "./worker-verdict.js";
import type { HunkReviewAction, HunkReviewComment, HunkReviewResult } from "./worker-diff-review.js";

export type DocketBrowserAction = { action: "inspect" | "openFile" | "promoteWorker" | "reference" | "injectFull" | "copy" | "save" | "search" | "tellWorker" | "verdict"; artifact?: Artifact };

export type { DocketVerdictAction } from "./worker-verdict.js";

export type ParallelWorkEntry = {
	worker: WorkerStatus;
	artifact: Artifact;
};

export type ParallelWorkAction =
	| { action: "peek"; entry: ParallelWorkEntry }
	| { action: "details" | "verdict" | "load" | "copyAttach" | "tell" | "stop"; worker: WorkerStatus }
	| null;

export type LoadPickerMode = "checkpoint" | "worker";
export type LoadPickerSelection =
	| { kind: "checkpoint"; action: "load" | "preview"; summary: CheckpointSummary }
	| { kind: "worker"; action: "load"; worker: WorkerStatus }
	| null;

type NotifyLevel = "info" | "warning" | "error";
type DocketMessageKind = "notice" | "success" | "error" | "usage" | "list" | "action" | "help";

export type DocketCommandRouterDeps = {
	hasUI: boolean;
	workerId?: string;
	projectRoot?: string;
	workerCommands: WorkerCommands;
	checkpointCommands: CheckpointCommands;
	loadedArtifacts: LoadedArtifactContext;
	workerStore: WorkerStore;
	checkpointStore: CheckpointStore;
	notify(text: string, level: NotifyLevel): void;
	emitText(text: string, kind: DocketMessageKind, heading?: string): void;
	announce(subject: string, detail?: string, kind?: DocketMessageKind): void;
	docketUsage(advanced?: boolean): string;
	renderArtifactList(artifacts: Artifact[]): string;
	renderParallelWorkList(workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]>, options?: { groupByProject?: boolean }): string;
	formatArtifact(artifact: Artifact): string;
	refreshChipWidget(): void;
	refreshWorkerDockWidget(): Promise<void>;
	refreshWorkerCarryoverForReview(): Promise<void>;
	showWorkerResult(worker: WorkerStatus, artifacts: Artifact[], expanded: boolean): void;
	clearWorkerResult(): boolean;
	markArtifactDone(artifact: Artifact): void;
	markWorkerLoaded(worker: WorkerStatus): void;
	markWorkerUnloaded(worker: WorkerStatus): void;
	markAllWorkersUnloaded(): void;
	promoteWorkerChangeSet(artifact: Artifact): Promise<boolean>;
	reviewWorkerChangeSetInHunk(worker: WorkerStatus, changeSet: Artifact): Promise<HunkReviewResult>;
	chooseHunkReviewAction(worker: WorkerStatus, comments: HunkReviewComment[]): Promise<HunkReviewAction>;
	applyWorkerState(state: "needs_input" | "ready" | "failed", text?: string): Promise<void>;
	createCheckpoint(options: CheckpointCreateOptions): Promise<void>;
	createHandoffCheckpoint(): Promise<void>;
	catalog(): Promise<ArtifactCatalog>;
	readWorkersWithArtifacts(options?: { allProjects?: boolean }): Promise<{ workers: WorkerStatus[]; artifactsByWorker: Map<string, Artifact[]> }>;
	showParallelWorkDashboard(workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]>, options?: { groupByProject?: boolean }): Promise<ParallelWorkAction>;
	showLoadPicker(summaries: CheckpointSummary[], workers: WorkerStatus[], initialMode: LoadPickerMode): Promise<LoadPickerSelection>;
	showText(title: string, text: string, options?: { diff?: boolean }): Promise<void>;
	showDocketBrowser(catalog: ArtifactCatalog, artifacts: Artifact[], initialMode: NavigatorMode): Promise<DocketBrowserAction | null>;
	showVerdict(worker: WorkerStatus, remaining?: number): Promise<DocketVerdictAction | null>;
	showArtifact(catalog: ArtifactCatalog, artifact: Artifact): Promise<void>;
	openFileOrArtifact(catalog: ArtifactCatalog, artifact: Artifact): Promise<void>;
	input(title: string, placeholder: string): Promise<string | undefined>;
	confirmDeleteWorker(worker: WorkerStatus): Promise<boolean>;
	copyText(text: string): Promise<boolean>;
	announceChipChange(artifact: Artifact, mode: "ref" | "full", result: ReturnType<LoadedArtifactContext["toggleChip"]>): void;
	parallelKindLabel(kind: Artifact["kind"]): string;
	/** Append a resolved verdict to the decision ledger. Best-effort; never blocks the verdict. */
	recordDecision(record: DecisionRecord): Promise<void>;
	/** Read the decision ledger for the `/docket log decisions` audit. */
	readDecisionEvents(): Promise<DecisionEvent[]>;
};

export type TmuxNavigation = {
	mode: "attach" | "switch";
	target: string;
	command: string;
	args: string[];
};

function normalizeTmuxTarget(target: string): { session: string; window?: string } {
	if (isSharedSessionTarget(target)) {
		const rawWindow = target.slice(`${SHARED_TMUX_SESSION}:`.length);
		const window = rawWindow.replace(/^:+/, "");
		return { session: SHARED_TMUX_SESSION, ...(window ? { window } : {}) };
	}
	return { session: target };
}

export function buildTmuxNavigation(target: string, options: { insideTmux?: boolean } = {}): TmuxNavigation {
	const insideTmux = options.insideTmux ?? Boolean(process.env.TMUX);
	const normalized = normalizeTmuxTarget(target);
	const targetLabel = normalized.window ? `${normalized.session}:${normalized.window}` : normalized.session;
	if (insideTmux) {
		return {
			mode: "switch",
			target: targetLabel,
			command: `tmux switch-client -t ${targetLabel}`,
			args: ["switch-client", "-t", targetLabel],
		};
	}
	if (normalized.session === SHARED_TMUX_SESSION && normalized.window) {
		return {
			mode: "attach",
			target: targetLabel,
			command: `tmux attach -t ${SHARED_TMUX_SESSION} \\; select-window -t ${normalized.window}`,
			args: ["attach", "-t", SHARED_TMUX_SESSION, ";", "select-window", "-t", normalized.window],
		};
	}
	return {
		mode: "attach",
		target: targetLabel,
		command: `tmux attach -t ${targetLabel}`,
		args: ["attach", "-t", targetLabel],
	};
}

export function buildAttachCommand(target: string, options: { insideTmux?: boolean } = {}): string {
	return buildTmuxNavigation(target, options).command;
}

function runTmuxNavigation(nav: TmuxNavigation): boolean {
	if (nav.mode !== "switch") return false;
	const result = spawnSync("tmux", nav.args, { stdio: "ignore" });
	return result.status === 0;
}

function docketMetaString(artifact: Artifact, key: string): string | undefined {
	const value = artifact.meta?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function artifactWorkerRef(artifact: Artifact): string | undefined {
	const label = artifact.meta?.workerLabel;
	if (typeof label === "string" && label.length > 0) return label;
	return artifact.source;
}

function loadResultSubject(result: LoadResult): string {
	const slot = result.slot;
	return `loaded ${slot.slot} · ${slot.artifacts.length} artifact${slot.artifacts.length === 1 ? "" : "s"}`;
}

function loadResultDetail(result: LoadResult): string {
	const slot = result.slot;
	if (result.source.kind === "worker") return `${workerSummaryName(result.source.worker)}\nrefs: @${slot.slot}.<id>`;
	const checkpoint = result.source.checkpoint;
	const tag = result.queuedConsume ? "consume on session end" : `${checkpoint.mode} bundle`;
	return `${checkpoint.id}\n${tag}\nrefs: @${slot.slot}.<id>`;
}

export function createDocketCommandRouter(deps: DocketCommandRouterDeps) {
	const announceLoadResult = (result: LoadResult): void => deps.announce(loadResultSubject(result), loadResultDetail(result), "success");
	const navigateTmux = async (target: string): Promise<void> => {
		const nav = buildTmuxNavigation(target);
		if (nav.mode === "switch" && runTmuxNavigation(nav)) {
			deps.notify(`Switched tmux client: ${nav.command}`, "info");
			return;
		}
		const copied = await deps.copyText(nav.command);
		deps.notify(copied ? `Copied: ${nav.command}` : nav.command, copied ? "info" : "warning");
	};

	const showWorkerResult = async (ref: string, action: "show" | "use"): Promise<void> => {
		const worker = await deps.workerStore.find(ref);
		if (!worker) {
			deps.notify("Docket worker not found", "error");
			return;
		}
		if (action === "show") {
			const artifacts = await deps.workerStore.readArtifacts(worker.id);
			if (deps.hasUI) deps.showWorkerResult(worker, artifacts, true);
			else deps.emitText(workerResultText(worker, artifacts), "list", `docket · ${workerSourceLabel(worker)}`);
			return;
		}
		const result = await deps.loadedArtifacts.loadSource({ kind: "worker", worker });
		deps.markWorkerLoaded(worker);
		const artifact = workerResultArtifact(worker, result.slot.artifacts);
		if (!artifact) {
			deps.notify(`No result yet for ${workerSourceLabel(worker)}`, "warning");
			return;
		}
		const chipResult = deps.loadedArtifacts.toggleChip(artifact, "ref");
		deps.refreshChipWidget();
		deps.showWorkerResult(worker, result.slot.artifacts, false);
		deps.announceChipChange(artifact, "ref", chipResult);
		await deps.refreshWorkerDockWidget();
	};

	const tellWorker = async (ref: string, text?: string, artifact?: Artifact): Promise<void> => {
		const trimmed = text?.trim();
		if (trimmed) {
			await deps.workerCommands.tell(ref, trimmed);
			await deps.refreshWorkerDockWidget();
			return;
		}
		if (!deps.hasUI) {
			deps.notify("Usage: /docket tell w<N> <text>", "error");
			return;
		}
		const worker = await deps.workerStore.find(ref);
		const label = worker ? workerSourceLabel(worker) : ref;
		const questions = worker ? workerQuestions(worker).map((question, index) => `${index + 1}. ${question.text}`).join("\n") : undefined;
		const placeholder = artifact ? docketMetaString(artifact, "question") ?? artifact.title : questions;
		const message = (await deps.input(`Tell ${label}`, placeholder ?? "instruction, answer, or follow-up"))?.trim();
		if (!message) return;
		await deps.workerCommands.tell(ref, message);
		await deps.refreshWorkerDockWidget();
	};

	return {
		async handle(intent: DocketIntent): Promise<void> {
			if (intent.kind === "help") {
				deps.emitText(deps.docketUsage(intent.advanced === true), "help", intent.advanced === true ? "docket · help advanced" : "docket · help");
				return;
			}

			if (intent.kind === "clear") {
				const had = deps.loadedArtifacts.clearChips();
				deps.refreshChipWidget();
				const hadWorkerResult = deps.clearWorkerResult();
				deps.notify(had || hadWorkerResult ? "Docket cleared" : "Docket had no chips", "info");
				return;
			}

			if (intent.kind === "tell") {
				await tellWorker(intent.worker, intent.text);
				return;
			}

			if (intent.kind === "verdict") {
				const worker = await findVerdictWorker(deps, intent.worker);
				if (!worker) {
					deps.notify("Docket worker needing verdict not found", "warning");
					return;
				}
				if (intent.worker) await runWorkerVerdict(deps, worker);
				else await runWorkerVerdictQueue(deps, worker);
				return;
			}

			if (intent.kind === "decisions") {
				const events = await deps.readDecisionEvents();
				const report = renderDecisionLog(events);
				if (deps.hasUI) await deps.showText("docket · decisions", report);
				else deps.emitText(report, "list", "docket · decisions");
				return;
			}

			if (intent.kind === "attach") {
				let target = `${SHARED_TMUX_SESSION}:`;
				if (intent.worker) {
					const worker = await deps.workerStore.find(intent.worker);
					if (!worker) {
						deps.notify("Docket worker not found", "error");
						return;
					}
					target = worker.tmuxSession;
				}
				await navigateTmux(target);
				return;
			}

			if (intent.kind === "worker-state") {
				if (!deps.workerId) {
					deps.notify("Worker state commands only run inside a Docket worker", "warning");
					return;
				}
				await deps.applyWorkerState(intent.state, intent.text);
				return;
			}

			if (intent.kind === "save") {
				await deps.createCheckpoint(intent.options);
				return;
			}

			if (intent.kind === "delete") {
				if (intent.targetKind === "worker") {
					await deps.workerCommands.delete(intent.target);
					await deps.refreshWorkerDockWidget();
				} else await deps.checkpointCommands.delete(intent.target);
				return;
			}

			if (intent.kind === "list") {
				if (intent.workers === true) await deps.workerCommands.list({ allProjects: intent.allProjects === true });
				else await deps.checkpointCommands.list(intent.includeConsumed === true);
				return;
			}

			if (intent.kind === "spawn") {
				await deps.workerCommands.spawn(intent.task, { worktree: intent.worktree === true, fresh: intent.fresh === true, seed: intent.seed === true, ...(intent.as ? { as: intent.as } : {}) });
				await deps.refreshWorkerDockWidget();
				return;
			}

			if (intent.kind === "kinds") {
				await deps.workerCommands.listKinds();
				return;
			}

			if (intent.kind === "respawn") {
				await deps.workerCommands.respawn(intent.target);
				await deps.refreshWorkerDockWidget();
				return;
			}

			if (intent.kind === "workers") {
				const { workers, artifactsByWorker } = await deps.readWorkersWithArtifacts({ allProjects: intent.allProjects === true });
				const groupByProject = intent.allProjects === true;
				if (!deps.hasUI) {
					deps.emitText(deps.renderParallelWorkList(workers, artifactsByWorker, { groupByProject }), "list", "docket · parallel work");
					return;
				}
				while (true) {
					const result = await deps.showParallelWorkDashboard(workers, artifactsByWorker, { groupByProject });
					if (!result) return;
					if (result.action === "peek") {
						await deps.showText(`${workerSourceLabel(result.entry.worker)} · ${deps.parallelKindLabel(result.entry.artifact.kind)}`, deps.formatArtifact(result.entry.artifact));
						continue;
					}
					if (result.action === "details") {
						await deps.showText(`${workerSourceLabel(result.worker)} · details`, workerResultText(result.worker, artifactsByWorker.get(result.worker.id) ?? []));
						continue;
					}
					if (result.action === "verdict") {
						await runWorkerVerdict(deps, result.worker);
						return;
					}
					if (result.action === "load") {
						announceLoadResult(await deps.loadedArtifacts.loadSource({ kind: "worker", worker: result.worker }));
						deps.markWorkerLoaded(result.worker);
						await deps.refreshWorkerDockWidget();
						return;
					}
					if (result.action === "copyAttach") {
						await navigateTmux(result.worker.tmuxSession);
						return;
					}
					if (result.action === "tell") {
						await tellWorker(workerSourceLabel(result.worker));
						return;
					}
					if (result.action === "stop") {
						await deps.workerCommands.delete(workerSourceLabel(result.worker));
						await deps.refreshWorkerDockWidget();
						return;
					}
				}
			}

			if (intent.kind === "load") {
				if (intent.refKind === "worker") {
					if (!intent.ref) {
						deps.notify("Usage: /docket load w<N>", "error");
						return;
					}
					const worker = await deps.workerStore.find(intent.ref);
					if (!worker) {
						deps.notify("Docket worker not found", "error");
						return;
					}
					try {
						announceLoadResult(await deps.loadedArtifacts.loadSource({ kind: "worker", worker }));
						deps.markWorkerLoaded(worker);
					} catch (err) {
						deps.notify(`Docket load failed: ${String(err)}`, "error");
					}
					await deps.refreshWorkerDockWidget();
					return;
				}

				const opts = { includeConsumed: intent.includeConsumed === true };
				let source: Parameters<LoadedArtifactContext["loadSource"]>[0] | undefined;
				if (intent.ref) {
					const checkpoint = await deps.checkpointStore.find(intent.ref, opts);
					if (!checkpoint) {
						deps.notify("Docket bundle not found", "error");
						return;
					}
					source = { kind: "checkpoint", checkpoint };
				} else {
					const [summaries, workers] = await Promise.all([
						deps.checkpointStore.listSummaries(opts),
						deps.workerStore.list({ ...(deps.projectRoot ? { projectRoot: deps.projectRoot } : {}) }),
					]);
					if (summaries.length === 0 && workers.length === 0) {
						deps.notify("Docket has nothing to load — try /docket save or /docket spawn", "error");
						return;
					}
					if (!deps.hasUI) {
						source = deps.loadedArtifacts.defaultLoadSource({ checkpoints: summaries.map((summary) => summary.entry), workers });
					} else {
						const initial: LoadPickerMode = summaries.length > 0 ? "checkpoint" : "worker";
						while (true) {
							const selected = await deps.showLoadPicker(summaries, workers, initial);
							if (!selected) {
								deps.notify("Docket load cancelled", "info");
								return;
							}
							if (selected.kind === "worker") {
								source = { kind: "worker", worker: selected.worker };
								break;
							}
							if (selected.action === "preview") {
								const md = await deps.checkpointStore.readMarkdown(selected.summary.entry);
								await deps.showText(`Docket checkpoint ${selected.summary.entry.id}`, md);
								continue;
							}
							source = { kind: "checkpoint", checkpoint: selected.summary.entry };
							break;
						}
					}
				}
				if (!source) return;
				try {
					const result = await deps.loadedArtifacts.loadSource(source);
					announceLoadResult(result);
					if (source.kind === "worker") {
						deps.markWorkerLoaded(source.worker);
						await deps.refreshWorkerDockWidget();
					}
				} catch (err) {
					deps.notify(`Docket load failed: ${String(err)}`, "error");
				}
				return;
			}

			if (intent.kind === "unload") {
				if (intent.targetKind === "all") {
					const slots = deps.loadedArtifacts.slots().map((entry) => entry.slot);
					for (const slot of slots) deps.loadedArtifacts.unloadSlot(slot);
					deps.markAllWorkersUnloaded();
					if (slots.length) deps.announce(`unloaded ${slots.length} slot${slots.length === 1 ? "" : "s"}`, slots.join(", "));
					else deps.notify("Docket had no loaded slots", "info");
					return;
				}
				if (intent.targetKind === "worker") {
					const worker = await deps.workerStore.find(intent.target);
					await deps.workerCommands.unload(intent.target);
					if (worker) deps.markWorkerUnloaded(worker);
					await deps.refreshWorkerDockWidget();
					return;
				}
				const checkpoint = await deps.checkpointStore.find(intent.target, { includeConsumed: true });
				const targetId = checkpoint?.id ?? intent.target;
				const removed = deps.loadedArtifacts.unloadSource("checkpoint", targetId);
				if (removed) deps.announce(`unloaded ${removed.slot}`, removed.sourceId);
				else deps.notify("Docket checkpoint not loaded", "warning");
				return;
			}

			const shouldBrowse = intent.kind === "browse" || intent.kind === "answers" || intent.kind === "search";
			if (shouldBrowse) await deps.refreshWorkerCarryoverForReview();
			const catalog = await deps.catalog();
			let artifacts = catalog.list();
			let initialMode: NavigatorMode = intent.kind === "browse" && intent.mode ? intent.mode : "review";

			if (intent.kind === "answers") {
				initialMode = "answers";
				if (intent.query) artifacts = (await catalog.search(intent.query)).filter((artifact) => artifact.kind === "response");
				else artifacts = artifacts.filter((artifact) => artifact.kind === "response");
				if (artifacts.length === 0) {
					deps.notify(intent.query ? `Docket answers found no matches for: ${intent.query}` : "Docket has no answers yet", "info");
					return;
				}
				if (!deps.hasUI) {
					deps.emitText(deps.renderArtifactList(artifacts), "list", intent.query ? `docket · answers "${intent.query}"` : "docket · answers");
					return;
				}
			}

			if (intent.kind === "search") {
				initialMode = "log";
				artifacts = await catalog.search(intent.query);
				if (artifacts.length === 0) {
					deps.notify(`Docket search found no artifacts for: ${intent.query}`, "info");
					return;
				}
				if (!deps.hasUI) {
					deps.emitText(deps.renderArtifactList(artifacts), "list", `docket · search "${intent.query}"`);
					return;
				}
			}

			if (intent.kind === "artifact") {
				const artifact = catalog.find(intent.idOrRef);
				if (!artifact) {
					deps.notify("Docket artifact not found", "error");
					return;
				}
				deps.markArtifactDone(artifact);
				if (intent.action === "ref") {
					const r = deps.loadedArtifacts.toggleChip(artifact, "ref");
					deps.refreshChipWidget();
					deps.announceChipChange(artifact, "ref", r);
				} else if (intent.action === "inject-full") {
					const r = deps.loadedArtifacts.toggleChip(artifact, "full");
					deps.refreshChipWidget();
					deps.announceChipChange(artifact, "full", r);
				} else {
					const ok = await deps.copyText(catalog.fullText(artifact));
					deps.notify(ok ? `Docket copied ${artifact.id}` : "No clipboard command found", ok ? "info" : "warning");
				}
				return;
			}

			if (!deps.hasUI) {
				deps.emitText(deps.renderArtifactList(artifacts), "list", `docket · ${initialMode}`);
				return;
			}

			while (true) {
				const result = await deps.showDocketBrowser(catalog, artifacts, initialMode);
				if (!result) return;
				if (result.action === "save") {
					await deps.createHandoffCheckpoint();
					return;
				}
				if (result.action === "search") {
					const query = (await deps.input("Search Docket", "commands, errors, files, answers..."))?.trim();
					if (!query) continue;
					const matches = await catalog.search(query);
					if (matches.length === 0) {
						deps.notify(`Docket search found no artifacts for: ${query}`, "info");
						continue;
					}
					artifacts = matches;
					initialMode = "log";
					continue;
				}
				if (result.action === "tellWorker" && result.artifact) {
					const workerRef = artifactWorkerRef(result.artifact);
					if (!workerRef) {
						deps.notify("Docket worker not found for this item", "error");
						continue;
					}
					await tellWorker(workerRef, undefined, result.artifact);
					return;
				}
				if (result.action === "verdict" && result.artifact) {
					const workerId = docketMetaString(result.artifact, "workerId") ?? artifactWorkerRef(result.artifact);
					const worker = workerId ? await findVerdictWorker(deps, workerId) : undefined;
					if (!worker) {
						deps.notify("Docket worker not found for this item", "error");
						continue;
					}
					await runWorkerVerdict(deps, worker);
					return;
				}
				if (!result.artifact) return;
				deps.markArtifactDone(result.artifact);
				if (result.action === "inspect") {
					await deps.showArtifact(catalog, result.artifact);
					continue;
				}
				if (result.action === "openFile") {
					await deps.openFileOrArtifact(catalog, result.artifact);
					continue;
				}
				if (result.action === "promoteWorker") {
					if (await deps.promoteWorkerChangeSet(result.artifact)) deps.markArtifactDone(result.artifact);
					return;
				}
				const artifact = result.artifact;
				if (result.action === "reference") {
					const r = deps.loadedArtifacts.toggleChip(artifact, "ref");
					deps.refreshChipWidget();
					deps.announceChipChange(artifact, "ref", r);
				} else if (result.action === "injectFull") {
					const r = deps.loadedArtifacts.toggleChip(artifact, "full");
					deps.refreshChipWidget();
					deps.announceChipChange(artifact, "full", r);
				} else if (result.action === "copy") {
					const ok = await deps.copyText(catalog.fullText(artifact));
					deps.notify(ok ? `Docket copied ${artifact.id}` : "No clipboard command found", ok ? "info" : "warning");
				}
				return;
			}
		},
	};
}
