/**
 * Views communicate through router/verdict action types. They never receive
 * session-runtime state, artifact mounts, or worker lifecycle dependencies.
 */
export type {
	DocketBrowserAction,
	LoadPickerSelection,
	ParallelWorkAction,
} from "../docket-command-router.js";
export type { DocketVerdictAction } from "../worker-verdict.js";
