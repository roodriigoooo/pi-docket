import type { WorkerStatus } from "./background-work.js";
import type { Artifact } from "./types.js";
import { formatHunkReviewComments, type HunkReviewAction, type HunkReviewComment, type HunkReviewResult } from "./worker-diff-review.js";

export type WorkerChangeReviewPreference = "builtin" | "hunk";

export type WorkerChangeReviewOutcome =
	| { kind: "returned" }
	| { kind: "comments-sent"; commentCount: number };

type NotifyLevel = "info" | "warning";

/**
 * UI and delivery seams for reviewing one deterministic worker change set.
 *
 * This intentionally cannot promote artifacts, mount them, or inject them into
 * context. The caller retains those lifecycle responsibilities.
 */
export type WorkerChangeReviewDeps = {
	showBuiltinDiff(worker: WorkerStatus, changeSet: Artifact): Promise<void>;
	reviewInHunk(worker: WorkerStatus, changeSet: Artifact): Promise<HunkReviewResult>;
	chooseAction(worker: WorkerStatus, comments: HunkReviewComment[]): Promise<HunkReviewAction>;
	sendToWorker(worker: WorkerStatus, text: string): Promise<void>;
	copyText(text: string): Promise<boolean>;
	notify(text: string, level: NotifyLevel): void;
};

export async function reviewWorkerChangeSet(
	deps: WorkerChangeReviewDeps,
	worker: WorkerStatus,
	changeSet: Artifact,
	options: { preferred: WorkerChangeReviewPreference },
): Promise<WorkerChangeReviewOutcome> {
	if (options.preferred === "builtin") {
		await deps.showBuiltinDiff(worker, changeSet);
		return { kind: "returned" };
	}

	const review = await deps.reviewInHunk(worker, changeSet);
	if (!review.available || review.message) {
		deps.notify(review.message ?? "Hunk review failed.", "warning");
		await deps.showBuiltinDiff(worker, changeSet);
		return { kind: "returned" };
	}
	if (review.comments.length === 0) {
		deps.notify("Hunk review completed with no comments.", "info");
		return { kind: "returned" };
	}

	const text = formatHunkReviewComments(review.comments);
	const action = await deps.chooseAction(worker, review.comments);
	if (action === "send") {
		await deps.sendToWorker(worker, text);
		return { kind: "comments-sent", commentCount: review.comments.length };
	}
	if (action === "copy") {
		const copied = await deps.copyText(text);
		deps.notify(copied ? "Copied Hunk review comments" : "No clipboard command found", copied ? "info" : "warning");
	}
	return { kind: "returned" };
}
