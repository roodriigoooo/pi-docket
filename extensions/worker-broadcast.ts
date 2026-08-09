import { workerSourceLabel, workerSummaryName, type WorkerStatus } from "./background-work.js";

/**
 * Recipient selection for a broadcast (ADR-0008).
 *
 * The whole point is that the human never types a worker id. A human returning to a session
 * after twenty minutes does not remember which index holds which job, and a surface that asks
 * them to is a guessing game wearing the costume of control. So Docket proposes recipients from
 * evidence it already has, shows the reason beside each one, and asks only for confirmation.
 *
 * Everything here is pure. Scoring must be testable against fixture workers with no tmux and no
 * filesystem, because a heuristic that proposes badly will be trusted for a while before anyone
 * notices — which is also why every proposal carries the reason it was made.
 */

export type BroadcastBand = "affected" | "maybe" | "unrelated";

/** How much weight a claim carries, derived from what Docket already knows about its source. */
export type BroadcastStanding = "promoted" | "worktree" | "unreviewed";

export type BroadcastCandidate = {
	worker: WorkerStatus;
	/** Repo-relative paths this worker has read or edited. */
	touchedPaths?: string[];
	/** Files an approved plan named for this worker. */
	plannedPaths?: string[];
	/** Cheap extra text to match identifiers against — artifact titles, not bodies. */
	keywords?: string[];
};

export type BroadcastSource =
	| { kind: "human" }
	| { kind: "worker"; worker: WorkerStatus; touchedPaths?: string[]; to?: string[]; standing: BroadcastStanding };

export type BroadcastRecipient = {
	worker: WorkerStatus;
	label: string;
	/** Task text, always shown: the label alone is never the only handle offered. */
	task: string;
	kind?: string;
	band: BroadcastBand;
	reason: string;
	selected: boolean;
};

/** Workers that can still act on what they are told. */
const ELIGIBLE_STATES = new Set<WorkerStatus["state"]>(["starting", "active", "idle", "needs_input"]);

const STOP_WORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "into", "have", "has", "was", "were", "are", "not",
	"but", "you", "your", "our", "its", "it's", "now", "new", "old", "add", "added", "use", "used", "using",
	"all", "any", "can", "will", "should", "must", "when", "then", "than", "does", "did", "done", "make",
	"made", "just", "only", "also", "more", "less", "some", "each", "they", "them", "their", "there", "here",
	"what", "which", "who", "how", "why", "one", "two", "out", "off", "over", "under", "about", "after",
	"before", "because", "while", "still", "take", "takes", "took", "get", "gets", "got", "let", "lets",
]);

function normalizePath(value: string): string {
	return value.replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

function basename(value: string): string {
	const parts = normalizePath(value).split("/");
	return parts[parts.length - 1] ?? value;
}

/** Paths the message names. A path is the strongest signal in the message, so it is read first. */
export function extractBroadcastPaths(text: string): string[] {
	const found = new Set<string>();
	for (const raw of text.match(/[`"'(\[]?[\w.@-]+(?:\/[\w.@*-]+)+(?:\.\w{1,8})?|[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|c|h|cpp|hpp|cs|php|swift|sql|json|ya?ml|toml|md|css|scss|html)/g) ?? []) {
		const cleaned = normalizePath(raw.replace(/^[`"'(\[]+|[`"')\],.;:]+$/g, ""));
		if (cleaned.length > 1) found.add(cleaned);
	}
	return [...found];
}

/** Identifiers worth matching: backticked tokens, camelCase, snake_case, dotted calls. */
export function extractBroadcastIdentifiers(text: string): string[] {
	const found = new Set<string>();
	for (const raw of text.match(/`[^`]+`/g) ?? []) {
		const inner = raw.slice(1, -1).trim();
		if (inner.length > 2 && !inner.includes(" ")) found.add(inner.toLowerCase());
	}
	for (const raw of text.match(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []) {
		if (raw.length > 3) found.add(raw.toLowerCase());
	}
	return [...found];
}

function contentTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const raw of text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []) {
		if (!STOP_WORDS.has(raw)) tokens.add(raw);
	}
	return tokens;
}

/**
 * A path matches when either side names the same file. Comparing basenames as well as full
 * paths matters because a worker in an isolated worktree records paths relative to its own
 * workspace, so a strict string equality check would miss nearly everything.
 */
function pathsIntersect(subject: string[], against: Set<string>, againstBases: Set<string>): string | undefined {
	for (const raw of subject) {
		const path = normalizePath(raw);
		if (!path) continue;
		if (against.has(path)) return path;
		for (const candidate of against) {
			if (candidate.endsWith(`/${path}`) || path.endsWith(`/${candidate}`)) return path;
		}
		if (againstBases.has(basename(path))) return path;
	}
	return undefined;
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export type BroadcastScoreInput = {
	text: string;
	source: BroadcastSource;
	candidates: BroadcastCandidate[];
	/**
	 * Paths the caller already knows the subject touches, when they are a fact rather than
	 * something to be read out of prose. A promotion knows exactly which files landed (P4); a
	 * typed broadcast does not, and still relies on `extractBroadcastPaths`.
	 */
	paths?: string[];
	/**
	 * Which worker states may be scored. Defaults to workers that can still act on what they are
	 * told, which is the right filter for a broadcast. Staleness widens it: a finished worker
	 * cannot act, but its deliverable was still produced against a base that moved.
	 */
	eligibleStates?: ReadonlySet<WorkerStatus["state"]>;
};

export function scoreBroadcastRecipients(input: BroadcastScoreInput): BroadcastRecipient[] {
	const eligibleStates = input.eligibleStates ?? ELIGIBLE_STATES;
	const sourceWorkerId = input.source.kind === "worker" ? input.source.worker.id : undefined;
	const addressed = new Set((input.source.kind === "worker" ? input.source.to ?? [] : []).map((label) => label.toLowerCase()));

	// What the message is "about": paths it names, plus everything the source worker touched.
	const subjectPaths = new Set<string>([
		...extractBroadcastPaths(input.text).map(normalizePath),
		...(input.paths ?? []).map(normalizePath),
		...(input.source.kind === "worker" ? (input.source.touchedPaths ?? []).map(normalizePath) : []),
	]);
	const subjectBases = new Set([...subjectPaths].map(basename));
	const identifiers = extractBroadcastIdentifiers(input.text);
	const messageTokens = contentTokens(input.text);

	const recipients: BroadcastRecipient[] = [];
	for (const candidate of input.candidates) {
		const worker = candidate.worker;
		if (worker.id === sourceWorkerId) continue;
		if (!eligibleStates.has(worker.state)) continue;
		const label = workerSourceLabel(worker);

		let band: BroadcastBand = "unrelated";
		let reason = "no overlap found";

		const planHit = pathsIntersect(candidate.plannedPaths ?? [], subjectPaths, subjectBases);
		const pathHit = pathsIntersect(candidate.touchedPaths ?? [], subjectPaths, subjectBases);
		if (pathHit) {
			band = "affected";
			reason = `touches ${truncate(pathHit, 48)}`;
		} else if (planHit) {
			band = "affected";
			reason = `plan names ${truncate(planHit, 48)}`;
		} else {
			const haystack = [workerSummaryName(worker, 200), ...(candidate.keywords ?? []), ...(candidate.touchedPaths ?? []).map(basename)].join(" ").toLowerCase();
			const symbol = identifiers.find((identifier) => haystack.includes(identifier));
			if (symbol) {
				band = "maybe";
				reason = `mentions ${truncate(symbol, 40)}`;
			} else {
				const taskTokens = contentTokens(worker.task);
				const shared = [...messageTokens].filter((token) => taskTokens.has(token)).slice(0, 3);
				if (shared.length >= 2) {
					band = "maybe";
					reason = `task overlaps: ${shared.join(", ")}`;
				}
			}
		}

		// A worker the author named is proposed regardless of overlap — but it is still proposed,
		// not sent. The worker expresses intent; the human keeps the decision.
		if (addressed.has(label.toLowerCase())) {
			band = "affected";
			reason = `addressed by ${workerSourceLabel((input.source as { worker: WorkerStatus }).worker)}`;
		}

		recipients.push({
			worker,
			label,
			task: workerSummaryName(worker, 44),
			...(worker.kind && worker.kind !== "default" ? { kind: worker.kind } : {}),
			band,
			reason,
			selected: band === "affected",
		});
	}

	const order: Record<BroadcastBand, number> = { affected: 0, maybe: 1, unrelated: 2 };
	return recipients.sort((a, b) => order[a.band] - order[b.band] || a.worker.index - b.worker.index);
}

/**
 * Fold companion suggestions into the proposal (ADR-0008, P3 seam).
 *
 * A suggestion can only lift a candidate from `unrelated` to `maybe`. It cannot reach
 * `affected`, because affected is preselected and Enter sends it — letting a companion put a
 * worker there would make an extension able to cause a delivery. It cannot demote or remove
 * either: suppressing a recipient is as consequential as adding one. The reason is attributed
 * so the human can see the proposal did not come from Docket's own evidence.
 */
export function applyBroadcastSuggestions(
	recipients: BroadcastRecipient[],
	suggestions: readonly { workerId: string; reason: string }[],
): BroadcastRecipient[] {
	if (suggestions.length === 0) return recipients;
	const byWorker = new Map(suggestions.map((suggestion) => [suggestion.workerId, suggestion.reason]));
	const updated = recipients.map((recipient) => {
		const reason = byWorker.get(recipient.worker.id);
		if (!reason || recipient.band !== "unrelated") return recipient;
		return { ...recipient, band: "maybe" as const, reason: `suggested · ${reason}`, selected: false };
	});
	const order: Record<BroadcastBand, number> = { affected: 0, maybe: 1, unrelated: 2 };
	return updated.sort((a, b) => order[a.band] - order[b.band] || a.worker.index - b.worker.index);
}

export function broadcastBandCounts(recipients: BroadcastRecipient[]): Record<BroadcastBand, number> {
	return recipients.reduce((counts, recipient) => {
		counts[recipient.band]++;
		return counts;
	}, { affected: 0, maybe: 0, unrelated: 0 } as Record<BroadcastBand, number>);
}

/**
 * When nothing scores as affected, Docket proposes the bulletin instead of handing over a grid
 * of checkboxes. Asking is not the same as helping, and a bad guess interrupts real work.
 */
export function shouldProposeBulletin(recipients: BroadcastRecipient[]): boolean {
	return recipients.every((recipient) => recipient.band !== "affected");
}

/**
 * What a claim is worth, attached automatically. Content is never restricted — "code is ready"
 * is a legitimate broadcast — but a receiving worker has to be able to tell a promoted change
 * from one that only exists in another worker's worktree.
 */
export function broadcastProvenanceLine(source: BroadcastSource): string | undefined {
	if (source.kind === "human") return undefined;
	const label = workerSourceLabel(source.worker);
	if (source.standing === "promoted") {
		const version = source.worker.deliverable ? ` ${source.worker.deliverable.ref} (v${source.worker.deliverable.version})` : "";
		return `${label} ·${version} approved · promoted`;
	}
	if (source.standing === "worktree") return `${label} · in worktree, not promoted`;
	return `${label} · notice, unreviewed`;
}

/** The body a recipient actually reads. Provenance rides with the claim, never separately. */
export function formatBroadcastBody(text: string, source: BroadcastSource): string {
	const provenance = broadcastProvenanceLine(source);
	return provenance ? `${text.trim()}\n\n(${provenance})` : text.trim();
}

/** One line for the ledger and the parent's confirmation. */
export function broadcastSummary(recipients: BroadcastRecipient[], text: string, max = 60): string {
	const labels = recipients.map((recipient) => recipient.label).join(", ");
	return `${labels || "no workers"} · ${truncate(text.replace(/\s+/g, " ").trim(), max)}`;
}
