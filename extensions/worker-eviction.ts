import type { WorkerStatus } from "./background-work.js";
import { dockTerminalAgeMs, isDockTerminal, pruneDisposition } from "./worker-lifecycle.js";

/**
 * States that count as "the worker is done". Auto-hide and auto-prune only
 * apply to these; in-progress, waiting, ready, and failed workers stay
 * visible so the user can still act on them.
 */
export type EvictionConfig = {
	dockIdleHideMinutes?: number;
	pruneAfterHours?: number;
};

export function dockIdleHideMs(config: EvictionConfig | undefined): number {
	const minutes = config?.dockIdleHideMinutes;
	if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return 0;
	return minutes * 60_000;
}

export function pruneAfterMs(config: EvictionConfig | undefined): number {
	const hours = config?.pruneAfterHours;
	if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) return 0;
	return hours * 3_600_000;
}

export function isDockIdleEvictable(worker: WorkerStatus, now: number, idleHideMs: number): boolean {
	if (idleHideMs <= 0) return false;
	if (!isDockTerminal(worker)) return false;
	return dockTerminalAgeMs(worker, now) >= idleHideMs;
}

export function shouldPruneWorker(worker: WorkerStatus, now: number, pruneMs: number): boolean {
	return pruneDisposition(worker, now, pruneMs, true) !== "keep";
}

export function selectEvictableWorkerIds(workers: WorkerStatus[], now: number, idleHideMs: number): Set<string> {
	const out = new Set<string>();
	for (const worker of workers) {
		if (isDockIdleEvictable(worker, now, idleHideMs)) out.add(worker.id);
	}
	return out;
}

export function selectPrunableWorkers(workers: WorkerStatus[], now: number, pruneMs: number): WorkerStatus[] {
	return workers.filter((worker) => shouldPruneWorker(worker, now, pruneMs));
}
