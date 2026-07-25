import type { WorkerEvent } from "./worker-events.js";
import type { WorkerKind, WorkerKindRegistry, WorkerKindRegistration } from "./worker-kinds.js";

export type DocketExtensionSurface = {
	registerWorkerKind(kind: WorkerKindRegistration): () => void;
	listWorkerKinds(): WorkerKind[];
	onWorkerEvent(handler: (event: { workerId: string; event: WorkerEvent }) => void): () => void;
	/** Register the one optional operator-owned tmux companion adapter. */
	registerTmuxAdapter(adapter: TmuxAdapterRegistration): () => void;
};

export type TmuxWorkerWindowReady = {
	reason: "spawn" | "respawn" | string;
	workerId: string;
	workerLabel: string;
	workerDir: string;
	eventsFile: string;
	sessionName: string;
	windowTarget: string;
	windowId?: string;
	paneId?: string;
};

export type TmuxAdapterCallback = (event: TmuxWorkerWindowReady) => void | Promise<void>;

/** Companion adapter. The named callback keeps the seam extensible without adding
 * layout ownership to Docket's core lifecycle. */
export type TmuxAdapter = {
	onWorkerWindowReady: TmuxAdapterCallback;
};

/** Function form retained for tiny companions that treat the adapter as one callback. */
export type TmuxAdapterRegistration = TmuxAdapter | TmuxAdapterCallback;

declare global {
	var __docket: DocketExtensionSurface;
}

const SURFACE_KEY = "__docket";

type EventHandler = (event: { workerId: string; event: WorkerEvent }) => void;

export type DocketExtensionSurfaceInternals = DocketExtensionSurface & {
	emitWorkerEvent(workerId: string, event: WorkerEvent): void;
	emitWorkerWindowReady(event: TmuxWorkerWindowReady): Promise<void>;
};

export function installDocketExtensionSurface(registry: WorkerKindRegistry): DocketExtensionSurfaceInternals {
	const handlers = new Set<EventHandler>();
	let tmuxAdapter: TmuxAdapterRegistration | undefined;
	const surface: DocketExtensionSurfaceInternals = {
		registerWorkerKind(kind) {
			return registry.register({ ...kind, source: kind.source ?? "runtime" });
		},
		listWorkerKinds() {
			return registry.list();
		},
		onWorkerEvent(handler) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		registerTmuxAdapter(adapter) {
			if (tmuxAdapter) throw new Error("Docket tmux adapter already registered");
			tmuxAdapter = adapter;
			return () => {
				if (tmuxAdapter === adapter) tmuxAdapter = undefined;
			};
		},
		emitWorkerEvent(workerId, event) {
			for (const handler of handlers) {
				try { handler({ workerId, event }); } catch { /* never let a subscriber break docket */ }
			}
		},
		async emitWorkerWindowReady(event) {
			if (!tmuxAdapter) return;
			try {
				if (typeof tmuxAdapter === "function") await tmuxAdapter(event);
				else await tmuxAdapter.onWorkerWindowReady(event);
			} catch (err) {
				// Operator UI is optional. A companion must never roll back a worker
				// launch or turn a healthy worker into a failed one.
				console.warn(`Docket tmux adapter failed for ${event.workerLabel}; worker will continue running.`, err);
			}
		},
	};
	(globalThis as Record<string, unknown>)[SURFACE_KEY] = surface;
	return surface;
}

/** Best-effort notification used by the worker substrate after IDs are persisted. */
export async function notifyTmuxAdapter(event: TmuxWorkerWindowReady): Promise<void> {
	const surface = getDocketExtensionSurface();
	if (!surface) return;
	try {
		if (typeof surface.emitWorkerWindowReady === "function") await surface.emitWorkerWindowReady(event);
	} catch (err) {
		// A stale or third-party surface must be just as harmless as a failing adapter.
		console.warn(`Docket tmux adapter notification failed for ${event.workerLabel}; worker will continue running.`, err);
	}
}

export function getDocketExtensionSurface(): DocketExtensionSurfaceInternals | undefined {
	return (globalThis as Record<string, unknown>)[SURFACE_KEY] as DocketExtensionSurfaceInternals | undefined;
}
