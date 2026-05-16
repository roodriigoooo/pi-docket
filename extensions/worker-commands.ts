import { workerQuestions, workerShortLabel, workerSummaryName, type WorkerStatus } from "./background-work.js";
import type { LoadedArtifactContext } from "./loaded-artifact-context.js";
import type { ArtifactKind } from "./types.js";
import type { WorkerStore } from "./worker-store.js";

export type WorkerCompletionCandidate = { value: string; label: string };

type NotifyLevel = "info" | "warning" | "error";
type TrailMessageKind = "list" | "success" | "action";

type WorkerCommandsDeps = {
	store: WorkerStore;
	loadedArtifacts: Pick<LoadedArtifactContext, "loadWorker" | "unloadSource">;
	cwd: string;
	parentSession?: string;
	notify(text: string, level: NotifyLevel): void;
	announce(subject: string, detail?: string, kind?: TrailMessageKind, trail?: { kind: ArtifactKind; title: string; subtitle?: string }): void;
	emitText(text: string, kind: "list", heading: string): void;
};

export type WorkerCommands = {
	spawn(task: string): Promise<void>;
	tell(ref: string, text: string): Promise<void>;
	list(): Promise<void>;
	delete(ref: string | undefined): Promise<void>;
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

export async function workerCompletionCandidates(store: WorkerStore): Promise<WorkerCompletionCandidate[]> {
	try {
		const workers = await store.list();
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

function formatWorkerList(workers: WorkerStatus[]): string {
	if (workers.length === 0) return "No Trail workers";
	return workers
		.map((w) => {
			const label = workerShortLabel(w.index).padEnd(4);
			const state = (w.state ?? "?").padEnd(8);
			const artifacts = `${w.artifactCount ?? "?"} artifacts`.padEnd(14);
			const age = workerAge(w.updatedAt).padEnd(8);
			return `${label}  ${state}  ${artifacts}  ${age}  ${workerSummaryName(w, 48)}`;
		})
		.join("\n");
}

export function createWorkerCommands(deps: WorkerCommandsDeps): WorkerCommands {
	const loadWorker = async (worker: WorkerStatus): Promise<void> => {
		const slot = await deps.loadedArtifacts.loadWorker(worker);
		deps.announce(
			`loaded ${slot.slot} · ${slot.artifacts.length} artifact${slot.artifacts.length === 1 ? "" : "s"}`,
			`${workerSummaryName(worker)}\nrefs: @${slot.slot}.<id>`,
			"success",
		);
	};

	return {
		async spawn(task: string): Promise<void> {
			try {
				const worker = await deps.store.spawn({ task, cwd: deps.cwd, parentSession: deps.parentSession });
				const label = workerShortLabel(worker.index);
				deps.announce(
					`spawned ${label} · starting`,
					[
						`◌ ${label} ${workerSummaryName(worker)}`,
						"Trail will surface worker output in /trail.",
						`review: /trail`,
						`debug:  /trail workers`,
					].join("\n"),
				);
			} catch (err) {
				deps.notify(`Trail spawn failed: ${String(err)}`, "error");
			}
		},
		async tell(ref: string, text: string): Promise<void> {
			const worker = await deps.store.find(ref);
			if (!worker) {
				deps.notify("Trail worker not found", "error");
				return;
			}
			const sent = await deps.store.sendInput(worker.id, formatWorkerTell(worker, text));
			if (sent) deps.announce(
				`told ${workerShortLabel(worker.index)}`,
				text,
				"success",
				{ kind: "prompt", title: `tell ${workerShortLabel(worker.index)}`, subtitle: workerSummaryName(worker) },
			);
			else deps.notify(`Trail could not send message to ${workerShortLabel(worker.index)}`, "error");
		},
		async list(): Promise<void> {
			deps.emitText(formatWorkerList(await deps.store.list()), "list", "trail · workers");
		},
		async delete(ref: string | undefined): Promise<void> {
			if (!ref) {
				deps.notify("Usage: /trail delete w<N>", "error");
				return;
			}
			const worker = await deps.store.find(ref);
			if (!worker) {
				deps.notify("Trail worker not found", "error");
				return;
			}
			deps.loadedArtifacts.unloadSource("worker", worker.id);
			await deps.store.purge(worker.id);
			deps.announce(`worker ${workerShortLabel(worker.index)} killed`, `${workerSummaryName(worker)}\nid: ${worker.id}`);
		},
		async load(ref: string | undefined): Promise<void> {
			if (!ref) {
				deps.notify("Usage: /trail load w<N>", "error");
				return;
			}
			try {
				const worker = await deps.store.find(ref);
				if (!worker) {
					deps.notify("Trail worker not found", "error");
					return;
				}
				await loadWorker(worker);
			} catch (err) {
				deps.notify(`Trail load failed: ${String(err)}`, "error");
			}
		},
		async unload(ref: string): Promise<void> {
			const worker = await deps.store.find(ref);
			const removed = worker ? deps.loadedArtifacts.unloadSource("worker", worker.id) : undefined;
			if (removed) deps.announce(`unloaded ${removed.slot}`, worker ? workerSummaryName(worker) : undefined);
			else deps.notify("Trail worker not loaded", "warning");
		},
		completionCandidates(): Promise<WorkerCompletionCandidate[]> {
			return workerCompletionCandidates(deps.store);
		},
	};
}
