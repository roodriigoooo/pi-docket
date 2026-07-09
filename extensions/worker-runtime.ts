/**
 * Worker-only registration boundary. Parent sessions never receive protocol tools,
 * guardrails, heartbeats, or shell fallback interception.
 */
export type WorkerRuntimeDeps = {
	workerId?: string;
	registerGuardrailsAndProtocol(): void;
	startHeartbeat(): void;
	stopHeartbeat(): void | Promise<void>;
};

export type WorkerRuntime = {
	isWorker: boolean;
	register(): void;
	onSessionStart(): void;
	onSessionShutdown(): Promise<void>;
};

export function createWorkerRuntime(deps: WorkerRuntimeDeps): WorkerRuntime {
	const isWorker = Boolean(deps.workerId);
	return {
		isWorker,
		register(): void {
			if (!isWorker) return;
			deps.registerGuardrailsAndProtocol();
		},
		onSessionStart(): void {
			if (isWorker) deps.startHeartbeat();
		},
		async onSessionShutdown(): Promise<void> {
			if (isWorker) await deps.stopHeartbeat();
		},
	};
}
