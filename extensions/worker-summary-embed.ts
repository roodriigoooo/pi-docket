import { workerSourceLabel, type WorkerStatus } from "./background-work.js";
import { truncateWorkerReviewText, workerRecommendedItems, workerSummaryHeadline } from "./worker-review.js";

export type ReadyEmbed = {
	subject: string;
	heading: string;
	content: string;
	title: string;
	subtitle: string;
};

const MAX_RECOMMENDED_BULLETS = 5;
const MAX_BULLET_CHARS = 140;
const MAX_SUMMARY_CHARS = 280;

function kindTag(worker: WorkerStatus): string {
	const kind = worker.kind?.trim();
	if (!kind || kind === "default") return "";
	return `·${kind}`;
}

export function formatReadyEmbedMessage(worker: WorkerStatus): ReadyEmbed | undefined {
	const headline = workerSummaryHeadline(worker);
	const recommended = workerRecommendedItems(worker, Number.POSITIVE_INFINITY);
	if (!headline && recommended.length === 0) return undefined;

	const label = workerSourceLabel(worker);
	const tag = kindTag(worker);
	const outcome = worker.outcome ? ` (${worker.outcome})` : "";

	const lines: string[] = [];
	lines.push(`**${label}${tag} ready**${outcome}`);
	if (headline) lines.push(truncateWorkerReviewText(headline, MAX_SUMMARY_CHARS));
	if (recommended.length > 0) {
		lines.push("");
		lines.push("Recommended:");
		for (const bullet of recommended.slice(0, MAX_RECOMMENDED_BULLETS)) {
			lines.push(`- ${truncateWorkerReviewText(bullet, MAX_BULLET_CHARS)}`);
		}
		if (recommended.length > MAX_RECOMMENDED_BULLETS) {
			lines.push(`- … ${recommended.length - MAX_RECOMMENDED_BULLETS} more (open card for full list)`);
		}
	}

	const subject = headline ? `${label}${tag} ready · ${truncateWorkerReviewText(headline, 60)}` : `${label}${tag} ready`;
	return {
		subject,
		heading: "docket · worker ready",
		content: lines.join("\n"),
		title: `${label}${tag} ready`,
		subtitle: headline ? truncateWorkerReviewText(headline, 100) : "ready",
	};
}
