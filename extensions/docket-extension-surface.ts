import type { WorkerEvent } from "./worker-events.js";
import type { WorkerKind, WorkerKindRegistry } from "./worker-kinds.js";

export type DocketExtensionSurface = {
	registerWorkerKind(kind: Omit<WorkerKind, "source"> & { source?: WorkerKind["source"] }): () => void;
	listWorkerKinds(): WorkerKind[];
	onWorkerEvent(handler: (event: { workerId: string; event: WorkerEvent }) => void): () => void;
};

const SURFACE_KEY = "__docket";

type EventHandler = (event: { workerId: string; event: WorkerEvent }) => void;

export type DocketExtensionSurfaceInternals = DocketExtensionSurface & {
	emitWorkerEvent(workerId: string, event: WorkerEvent): void;
};

export function installDocketExtensionSurface(registry: WorkerKindRegistry): DocketExtensionSurfaceInternals {
	const handlers = new Set<EventHandler>();
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
		emitWorkerEvent(workerId, event) {
			for (const handler of handlers) {
				try { handler({ workerId, event }); } catch { /* never let a subscriber break docket */ }
			}
		},
	};
	(globalThis as Record<string, unknown>)[SURFACE_KEY] = surface;
	return surface;
}

export function getDocketExtensionSurface(): DocketExtensionSurfaceInternals | undefined {
	return (globalThis as Record<string, unknown>)[SURFACE_KEY] as DocketExtensionSurfaceInternals | undefined;
}
