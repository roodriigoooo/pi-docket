/**
 * Worker-only registration boundary. Parent sessions never receive protocol tools,
 * guardrails, heartbeats, or shell fallback interception.
 */
export type WorkerRuntimeDeps = {
	workerId?: string;
	registerGuardrailsAndProtocol(): void;
	startHeartbeat(): void;
	stopHeartbeat(): void | Promise<void>;
	/** Advertise the inbox reader and begin draining it. Parent → worker delivery (ADR-0008). */
	startMailbox(): void;
	stopMailbox(): void;
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
			if (!isWorker) return;
			deps.startHeartbeat();
			deps.startMailbox();
		},
		async onSessionShutdown(): Promise<void> {
			if (!isWorker) return;
			deps.stopMailbox();
			await deps.stopHeartbeat();
		},
	};
}
