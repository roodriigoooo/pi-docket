import type { WorkerEvent } from "./worker-events.js";
import type { WorkerKind, WorkerKindRegistry } from "./worker-kinds.js";

export type TrailExtensionSurface = {
	registerWorkerKind(kind: Omit<WorkerKind, "source"> & { source?: WorkerKind["source"] }): () => void;
	listWorkerKinds(): WorkerKind[];
	onWorkerEvent(handler: (event: { workerId: string; event: WorkerEvent }) => void): () => void;
};

const SURFACE_KEY = "__trail";

type EventHandler = (event: { workerId: string; event: WorkerEvent }) => void;

export type TrailExtensionSurfaceInternals = TrailExtensionSurface & {
	emitWorkerEvent(workerId: string, event: WorkerEvent): void;
};

export function installTrailExtensionSurface(registry: WorkerKindRegistry): TrailExtensionSurfaceInternals {
	const handlers = new Set<EventHandler>();
	const surface: TrailExtensionSurfaceInternals = {
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
				try { handler({ workerId, event }); } catch { /* never let a subscriber break trail */ }
			}
		},
	};
	(globalThis as Record<string, unknown>)[SURFACE_KEY] = surface;
	return surface;
}

export function getTrailExtensionSurface(): TrailExtensionSurfaceInternals | undefined {
	return (globalThis as Record<string, unknown>)[SURFACE_KEY] as TrailExtensionSurfaceInternals | undefined;
}
