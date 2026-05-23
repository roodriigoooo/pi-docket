import type { WorkerStatus } from "./background-work.js";

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
const BULLET_PREFIX = /^\s*(?:[-*•]|\d+[.)])\s+/;

function firstLine(text: string | undefined): string | undefined {
	const line = text?.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
	return line || undefined;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function workerLabel(worker: WorkerStatus): string {
	return `w${worker.index}`;
}

function kindTag(worker: WorkerStatus): string {
	const kind = worker.kind?.trim();
	if (!kind || kind === "default") return "";
	return `·${kind}`;
}

function extractRecommendations(worker: WorkerStatus): string[] {
	const fromField = Array.isArray(worker.recommended)
		? worker.recommended.map((r) => String(r).trim()).filter(Boolean)
		: [];
	if (fromField.length > 0) return fromField;
	const summary = worker.summary;
	if (typeof summary !== "string") return [];
	const lines: string[] = [];
	let inRecommended = false;
	for (const raw of summary.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) { if (inRecommended) break; continue; }
		if (/^recommended:?$/i.test(line) || /^recommendations:?$/i.test(line) || /^suggested:?$/i.test(line)) {
			inRecommended = true;
			continue;
		}
		if (inRecommended) {
			lines.push(line.replace(BULLET_PREFIX, ""));
		}
	}
	return lines;
}

function summaryHeadline(worker: WorkerStatus): string | undefined {
	const summary = worker.summary;
	if (typeof summary !== "string") return undefined;
	const recommendedIdx = summary.search(/\brecommend(ed|ations?):?/i);
	const prelude = recommendedIdx >= 0 ? summary.slice(0, recommendedIdx) : summary;
	return firstLine(prelude) ?? firstLine(summary);
}

export function formatReadyEmbedMessage(worker: WorkerStatus): ReadyEmbed | undefined {
	const headline = summaryHeadline(worker);
	const recommended = extractRecommendations(worker);
	if (!headline && recommended.length === 0) return undefined;

	const label = workerLabel(worker);
	const tag = kindTag(worker);
	const outcome = worker.outcome ? ` (${worker.outcome})` : "";

	const lines: string[] = [];
	lines.push(`**${label}${tag} ready**${outcome}`);
	if (headline) lines.push(truncate(headline, MAX_SUMMARY_CHARS));
	if (recommended.length > 0) {
		lines.push("");
		lines.push("Recommended:");
		for (const bullet of recommended.slice(0, MAX_RECOMMENDED_BULLETS)) {
			lines.push(`- ${truncate(bullet, MAX_BULLET_CHARS)}`);
		}
		if (recommended.length > MAX_RECOMMENDED_BULLETS) {
			lines.push(`- … ${recommended.length - MAX_RECOMMENDED_BULLETS} more (open card for full list)`);
		}
	}

	const subject = headline ? `${label}${tag} ready · ${truncate(headline, 60)}` : `${label}${tag} ready`;
	return {
		subject,
		heading: "trail · worker ready",
		content: lines.join("\n"),
		title: `${label}${tag} ready`,
		subtitle: headline ? truncate(headline, 100) : "ready",
	};
}
