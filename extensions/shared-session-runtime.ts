/**
 * Registration boundary for behavior shared by parent and worker sessions.
 * The supplied callbacks keep Pi-specific state private to the composition root.
 */
export type SharedSessionRuntimeDeps = {
	registerMessageRendering(): void;
	registerCommandRouting(): void;
	registerSessionLifecycle(): void;
	registerContextExpansion(): void;
};

export type SharedSessionRuntime = {
	register(): void;
};

export function createSharedSessionRuntime(deps: SharedSessionRuntimeDeps): SharedSessionRuntime {
	return {
		register(): void {
			deps.registerMessageRendering();
			deps.registerCommandRouting();
			deps.registerSessionLifecycle();
			deps.registerContextExpansion();
		},
	};
}
