import type { WorkerEvent } from "./worker-events.js";
import type { WorkerStatus } from "./background-work.js";

/**
 * Automatic worker → parent session content. Always undefined: Docket's hard rule is
 * metadata-only parent flow (#17). Ready/blocked events may refresh the dock and notify
 * extension subscribers; they must never inject worker summaries into the parent transcript.
 *
 * Legacy `worker.autoEmbedSummary` config is ignored if still present in JSON.
 */
export function automaticParentContentForWorkerEvent(
	_event: WorkerEvent,
	_worker?: WorkerStatus,
	_legacyAutoEmbedSummary?: boolean,
): undefined {
	return undefined;
}
