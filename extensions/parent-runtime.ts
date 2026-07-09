/**
 * Parent-only registration boundary. Workers never receive dock/watch behavior.
 */
export type ParentRuntimeDeps = {
	startWorkerWatchAndDock(): void;
	stopWorkerWatchAndDock(): void;
};

export type ParentRuntime = {
	onSessionStart(): void;
	onSessionShutdown(): void;
};

export function createParentRuntime(deps: ParentRuntimeDeps): ParentRuntime {
	return {
		onSessionStart(): void {
			deps.startWorkerWatchAndDock();
		},
		onSessionShutdown(): void {
			deps.stopWorkerWatchAndDock();
		},
	};
}
