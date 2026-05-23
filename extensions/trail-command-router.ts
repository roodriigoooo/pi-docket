import { workerQuestions, workerSourceLabel, workerSummaryName, type WorkerStatus } from "./background-work.js";
import { workerResultArtifact, workerResultText } from "./worker-result.js";
import { isSharedSessionTarget, SHARED_TMUX_SESSION } from "./worker-store.js";
import type { CheckpointCommands } from "./checkpoint-commands.js";
import type { CheckpointStore, CheckpointSummary } from "./checkpoint-store.js";
import type { ArtifactCatalog } from "./artifact-catalog.js";
import type { LoadedArtifactContext, LoadResult } from "./loaded-artifact-context.js";
import type { NavigatorMode } from "./trail-navigator.js";
import type { CheckpointCreateOptions, TrailIntent } from "./trail-command-grammar.js";
import type { Artifact, CheckpointIndexEntry } from "./types.js";
import type { WorkerCommands } from "./worker-commands.js";
import type { WorkerStore } from "./worker-store.js";

export type TrailBrowserAction = { action: "inspect" | "openFile" | "promoteWorker" | "reference" | "injectFull" | "copy" | "checkpoint" | "search" | "tellWorker"; artifact?: Artifact };

export type ParallelWorkEntry = {
	worker: WorkerStatus;
	artifact: Artifact;
};

export type ParallelWorkAction =
	| { action: "peek"; entry: ParallelWorkEntry }
	| { action: "details" | "load" | "copyAttach" | "answers" | "tell" | "stop"; worker: WorkerStatus }
	| null;

export type LoadPickerMode = "checkpoint" | "worker";
export type LoadPickerSelection =
	| { kind: "checkpoint"; action: "load" | "preview"; summary: CheckpointSummary }
	| { kind: "worker"; action: "load"; worker: WorkerStatus }
	| null;

type NotifyLevel = "info" | "warning" | "error";
type TrailMessageKind = "notice" | "success" | "error" | "usage" | "list" | "action" | "help";

export type TrailCommandRouterDeps = {
	hasUI: boolean;
	workerId?: string;
	workerCommands: WorkerCommands;
	checkpointCommands: CheckpointCommands;
	loadedArtifacts: LoadedArtifactContext;
	workerStore: WorkerStore;
	checkpointStore: CheckpointStore;
	notify(text: string, level: NotifyLevel): void;
	emitText(text: string, kind: TrailMessageKind, heading?: string): void;
	announce(subject: string, detail?: string, kind?: TrailMessageKind): void;
	trailUsage(advanced?: boolean): string;
	renderArtifactList(artifacts: Artifact[]): string;
	renderParallelWorkList(workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]>): string;
	formatArtifact(artifact: Artifact): string;
	refreshChipWidget(): void;
	refreshWorkerDockWidget(): Promise<void>;
	refreshWorkerCarryoverForReview(): Promise<void>;
	showWorkerResult(worker: WorkerStatus, artifacts: Artifact[], expanded: boolean): void;
	clearWorkerResult(): boolean;
	markArtifactDone(artifact: Artifact): void;
	promoteWorkerChangeSet(artifact: Artifact): Promise<boolean>;
	applyWorkerState(state: "needs_input" | "ready" | "failed", text?: string): Promise<void>;
	createCheckpoint(options: CheckpointCreateOptions): Promise<void>;
	createHandoffCheckpoint(): Promise<void>;
	catalog(): Promise<ArtifactCatalog>;
	readWorkersWithArtifacts(): Promise<{ workers: WorkerStatus[]; artifactsByWorker: Map<string, Artifact[]> }>;
	showParallelWorkDashboard(workers: WorkerStatus[], artifactsByWorker: Map<string, Artifact[]>): Promise<ParallelWorkAction>;
	showLoadPicker(summaries: CheckpointSummary[], workers: WorkerStatus[], initialMode: LoadPickerMode): Promise<LoadPickerSelection>;
	showText(title: string, text: string): Promise<void>;
	showTrailBrowser(catalog: ArtifactCatalog, artifacts: Artifact[], initialMode: NavigatorMode): Promise<TrailBrowserAction | null>;
	showArtifact(catalog: ArtifactCatalog, artifact: Artifact): Promise<void>;
	openFileOrArtifact(catalog: ArtifactCatalog, artifact: Artifact): Promise<void>;
	input(title: string, placeholder: string): Promise<string | undefined>;
	copyText(text: string): Promise<boolean>;
	announceChipChange(artifact: Artifact, mode: "ref" | "full", result: ReturnType<LoadedArtifactContext["toggleChip"]>): void;
	parallelKindLabel(kind: Artifact["kind"]): string;
};

export function buildAttachCommand(target: string): string {
	if (isSharedSessionTarget(target)) {
		const window = target.split(":")[1] ?? "";
		return window ? `tmux attach -t ${SHARED_TMUX_SESSION} \\; select-window -t ${window}` : `tmux attach -t ${SHARED_TMUX_SESSION}`;
	}
	return `tmux attach -t ${target}`;
}

function trailMetaString(artifact: Artifact, key: string): string | undefined {
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
	if (result.source.kind === "worker") return `${workerSummaryName(result.source.worker)}\nattach: @${slot.slot}.<id>`;
	const checkpoint = result.source.checkpoint;
	const tag = result.queuedConsume ? "consume on session end" : `${checkpoint.mode} checkpoint`;
	return `${checkpoint.id}\n${tag}\nrefs: @${slot.slot}.<id>`;
}

export function createTrailCommandRouter(deps: TrailCommandRouterDeps) {
	const announceLoadResult = (result: LoadResult): void => deps.announce(loadResultSubject(result), loadResultDetail(result), "success");

	const showWorkerResult = async (ref: string, action: "show" | "use"): Promise<void> => {
		const worker = await deps.workerStore.find(ref);
		if (!worker) {
			deps.notify("Trail worker not found", "error");
			return;
		}
		if (action === "show") {
			const artifacts = await deps.workerStore.readArtifacts(worker.id);
			if (deps.hasUI) deps.showWorkerResult(worker, artifacts, true);
			else deps.emitText(workerResultText(worker, artifacts), "list", `trail · ${workerSourceLabel(worker)}`);
			return;
		}
		const result = await deps.loadedArtifacts.loadSource({ kind: "worker", worker });
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
			deps.notify("Usage: /trail tell w<N> <text>", "error");
			return;
		}
		const worker = await deps.workerStore.find(ref);
		const label = worker ? workerSourceLabel(worker) : ref;
		const questions = worker ? workerQuestions(worker).map((question, index) => `${index + 1}. ${question.text}`).join("\n") : undefined;
		const placeholder = artifact ? trailMetaString(artifact, "question") ?? artifact.title : questions;
		const message = (await deps.input(`Tell ${label}`, placeholder ?? "instruction, answer, or follow-up"))?.trim();
		if (!message) return;
		await deps.workerCommands.tell(ref, message);
		await deps.refreshWorkerDockWidget();
	};

	return {
		async handle(intent: TrailIntent): Promise<void> {
			if (intent.kind === "help") {
				deps.emitText(deps.trailUsage(intent.advanced === true), "help", intent.advanced === true ? "trail · help advanced" : "trail · help");
				return;
			}

			if (intent.kind === "clear") {
				const had = deps.loadedArtifacts.clearChips();
				deps.refreshChipWidget();
				const hadWorkerResult = deps.clearWorkerResult();
				deps.notify(had || hadWorkerResult ? "Trail cleared" : "Trail had no chips", "info");
				return;
			}

			if (intent.kind === "worker-result") {
				await showWorkerResult(intent.worker, intent.action);
				return;
			}

			if (intent.kind === "tell") {
				await tellWorker(intent.worker, intent.text);
				return;
			}

			if (intent.kind === "attach") {
				let target = `${SHARED_TMUX_SESSION}:`;
				if (intent.worker) {
					const worker = await deps.workerStore.find(intent.worker);
					if (!worker) {
						deps.notify("Trail worker not found", "error");
						return;
					}
					target = worker.tmuxSession;
				}
				const command = buildAttachCommand(target);
				const copied = await deps.copyText(command);
				deps.notify(copied ? `Copied: ${command}` : command, copied ? "info" : "warning");
				return;
			}

			if (intent.kind === "worker-state") {
				if (!deps.workerId) {
					deps.notify("Worker state commands only run inside a Trail worker", "warning");
					return;
				}
				await deps.applyWorkerState(intent.state, intent.text);
				return;
			}

			if (intent.kind === "checkpoint") {
				await deps.createCheckpoint(intent.options);
				return;
			}

			if (intent.kind === "continue") {
				await deps.checkpointCommands.continue(intent.idOrLast);
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
				if (intent.workers === true) await deps.workerCommands.list();
				else await deps.checkpointCommands.list(intent.includeConsumed === true);
				return;
			}

			if (intent.kind === "spawn") {
				await deps.workerCommands.spawn(intent.task, { worktree: intent.worktree === true, fresh: intent.fresh === true, ...(intent.as ? { as: intent.as } : {}) });
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
				const { workers, artifactsByWorker } = await deps.readWorkersWithArtifacts();
				if (!deps.hasUI) {
					deps.emitText(deps.renderParallelWorkList(workers, artifactsByWorker), "list", "trail · parallel work");
					return;
				}
				while (true) {
					const result = await deps.showParallelWorkDashboard(workers, artifactsByWorker);
					if (!result) return;
					if (result.action === "peek") {
						await deps.showText(`${workerSourceLabel(result.entry.worker)} · ${deps.parallelKindLabel(result.entry.artifact.kind)}`, deps.formatArtifact(result.entry.artifact));
						continue;
					}
					if (result.action === "details") {
						await deps.showText(`${workerSourceLabel(result.worker)} · details`, workerResultText(result.worker, artifactsByWorker.get(result.worker.id) ?? []));
						continue;
					}
					if (result.action === "load") {
						announceLoadResult(await deps.loadedArtifacts.loadSource({ kind: "worker", worker: result.worker }));
						await deps.refreshWorkerDockWidget();
						return;
					}
					if (result.action === "copyAttach") {
						const command = buildAttachCommand(result.worker.tmuxSession);
						const copied = await deps.copyText(command);
						deps.notify(copied ? `Copied: ${command}` : command, copied ? "info" : "warning");
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
					if (result.action === "answers") {
						const loadResult = await deps.loadedArtifacts.loadSource({ kind: "worker", worker: result.worker });
						await deps.refreshWorkerDockWidget();
						const answers = loadResult.slot.artifacts.filter((artifact) => artifact.kind === "response");
						if (answers.length === 0) {
							deps.notify(`No answers yet for ${workerSourceLabel(result.worker)}`, "info");
							return;
						}
						await deps.showTrailBrowser(await deps.catalog(), answers, "answers");
						return;
					}
				}
			}

			if (intent.kind === "load") {
				if (intent.refKind === "worker") {
					await deps.workerCommands.load(intent.ref);
					await deps.refreshWorkerDockWidget();
					return;
				}

				const opts = { includeConsumed: intent.includeConsumed === true };
				let source: Parameters<LoadedArtifactContext["loadSource"]>[0] | undefined;
				if (intent.ref) {
					const checkpoint = await deps.checkpointStore.find(intent.ref, opts);
					if (!checkpoint) {
						deps.notify("Trail checkpoint not found", "error");
						return;
					}
					source = { kind: "checkpoint", checkpoint };
				} else {
					const [summaries, workers] = await Promise.all([
						deps.checkpointStore.listSummaries(opts),
						deps.workerStore.list(),
					]);
					if (summaries.length === 0 && workers.length === 0) {
						deps.notify("Trail has nothing to load — try /trail checkpoint or /trail spawn", "error");
						return;
					}
					if (!deps.hasUI) {
						source = deps.loadedArtifacts.defaultLoadSource({ checkpoints: summaries.map((summary) => summary.entry), workers });
					} else {
						const initial: LoadPickerMode = summaries.length > 0 ? "checkpoint" : "worker";
						while (true) {
							const selected = await deps.showLoadPicker(summaries, workers, initial);
							if (!selected) {
								deps.notify("Trail load cancelled", "info");
								return;
							}
							if (selected.kind === "worker") {
								source = { kind: "worker", worker: selected.worker };
								break;
							}
							if (selected.action === "preview") {
								const md = await deps.checkpointStore.readMarkdown(selected.summary.entry);
								await deps.showText(`Trail checkpoint ${selected.summary.entry.id}`, md);
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
					if (source.kind === "worker") await deps.refreshWorkerDockWidget();
				} catch (err) {
					deps.notify(`Trail load failed: ${String(err)}`, "error");
				}
				return;
			}

			if (intent.kind === "unload") {
				if (intent.targetKind === "all") {
					const slots = deps.loadedArtifacts.slots().map((entry) => entry.slot);
					for (const slot of slots) deps.loadedArtifacts.unloadSlot(slot);
					if (slots.length) deps.announce(`unloaded ${slots.length} slot${slots.length === 1 ? "" : "s"}`, slots.join(", "));
					else deps.notify("Trail had no loaded slots", "info");
					return;
				}
				if (intent.targetKind === "worker") {
					await deps.workerCommands.unload(intent.target);
					await deps.refreshWorkerDockWidget();
					return;
				}
				const checkpoint = await deps.checkpointStore.find(intent.target, { includeConsumed: true });
				const targetId = checkpoint?.id ?? intent.target;
				const removed = deps.loadedArtifacts.unloadSource("checkpoint", targetId);
				if (removed) deps.announce(`unloaded ${removed.slot}`, removed.sourceId);
				else deps.notify("Trail checkpoint not loaded", "warning");
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
					deps.notify(intent.query ? `Trail answers found no matches for: ${intent.query}` : "Trail has no answers yet", "info");
					return;
				}
				if (!deps.hasUI) {
					deps.emitText(deps.renderArtifactList(artifacts), "list", intent.query ? `trail · answers "${intent.query}"` : "trail · answers");
					return;
				}
			}

			if (intent.kind === "search") {
				initialMode = "log";
				artifacts = await catalog.search(intent.query);
				if (artifacts.length === 0) {
					deps.notify(`Trail search found no artifacts for: ${intent.query}`, "info");
					return;
				}
				if (!deps.hasUI) {
					deps.emitText(deps.renderArtifactList(artifacts), "list", `trail · search "${intent.query}"`);
					return;
				}
			}

			if (intent.kind === "artifact") {
				const artifact = catalog.find(intent.idOrRef);
				if (!artifact) {
					deps.notify("Trail artifact not found", "error");
					return;
				}
				deps.markArtifactDone(artifact);
				if (intent.action === "ref" || intent.action === "inject") {
					const r = deps.loadedArtifacts.toggleChip(artifact, "ref");
					deps.refreshChipWidget();
					deps.announceChipChange(artifact, "ref", r);
				} else if (intent.action === "inject-full") {
					const r = deps.loadedArtifacts.toggleChip(artifact, "full");
					deps.refreshChipWidget();
					deps.announceChipChange(artifact, "full", r);
				} else {
					const ok = await deps.copyText(catalog.fullText(artifact));
					deps.notify(ok ? `Trail copied ${artifact.id}` : "No clipboard command found", ok ? "info" : "warning");
				}
				return;
			}

			if (!deps.hasUI) {
				deps.emitText(deps.renderArtifactList(artifacts), "list", `trail · ${initialMode}`);
				return;
			}

			while (true) {
				const result = await deps.showTrailBrowser(catalog, artifacts, initialMode);
				if (!result) return;
				if (result.action === "checkpoint") {
					await deps.createHandoffCheckpoint();
					return;
				}
				if (result.action === "search") {
					const query = (await deps.input("Search Trail", "commands, errors, files, answers..."))?.trim();
					if (!query) continue;
					const matches = await catalog.search(query);
					if (matches.length === 0) {
						deps.notify(`Trail search found no artifacts for: ${query}`, "info");
						continue;
					}
					artifacts = matches;
					initialMode = "log";
					continue;
				}
				if (result.action === "tellWorker" && result.artifact) {
					const workerRef = artifactWorkerRef(result.artifact);
					if (!workerRef) {
						deps.notify("Trail worker not found for this item", "error");
						continue;
					}
					await tellWorker(workerRef, undefined, result.artifact);
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
					deps.notify(ok ? `Trail copied ${artifact.id}` : "No clipboard command found", ok ? "info" : "warning");
				}
				return;
			}
		},
	};
}
