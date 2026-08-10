import type { WorkerEvent } from "./worker-events.js";
import type { WorkerKind, WorkerKindRegistry, WorkerKindRegistration } from "./worker-kinds.js";
import type { BroadcastBand } from "./worker-broadcast.js";

export type DocketExtensionSurface = {
	registerWorkerKind(kind: WorkerKindRegistration): () => void;
	listWorkerKinds(): WorkerKind[];
	onWorkerEvent(handler: (event: { workerId: string; event: WorkerEvent }) => void): () => void;
	/** Register the one optional operator-owned tmux companion adapter. */
	registerTmuxAdapter(adapter: TmuxAdapterRegistration): () => void;
	/** Observe messages moving between the parent and its workers. Metadata only, read-only. */
	onMessage(handler: MessageObserver): () => void;
	/** Suggest additional broadcast candidates. Suggestions are proposals, never selections. */
	registerBroadcastAdvisor(advisor: BroadcastAdvisor): () => void;
};

/**
 * What a companion sees when a message moves (ADR-0008).
 *
 * Deliberately no body. A dashboard needs to know that w1 was told something and whether it was
 * taken; it does not need the text, and handing bodies to every subscriber would make Docket's
 * own metadata-only discipline meaningless at the seam. A companion that genuinely needs content
 * can read the worker directory itself and own that decision explicitly.
 */
export type WorkerMessageObservation = {
	workerId: string;
	/** `in` reaches the worker, `out` leaves it. */
	direction: "in" | "out";
	messageId: string;
	kind: string;
	from: string;
	delivery: string;
	transport: string;
	replyTo?: string;
	at: number;
};

export type MessageObserver = (observation: WorkerMessageObservation) => void;

export type BroadcastAdvisorCandidate = {
	workerId: string;
	label: string;
	task: string;
	kind?: string;
	band: BroadcastBand;
	reason: string;
};

export type BroadcastAdvisorInput = {
	text: string;
	source: { kind: "human" } | { kind: "worker"; workerLabel: string; standing: string };
	candidates: readonly BroadcastAdvisorCandidate[];
};

/** A companion's proposal. It can raise a candidate into `maybe`; it can do nothing else. */
export type BroadcastSuggestion = { workerId: string; reason: string };

export type BroadcastAdvisor = (input: BroadcastAdvisorInput) => BroadcastSuggestion[] | Promise<BroadcastSuggestion[]>;

/** A companion is advisory, so it gets a short window and is dropped if it misses it. */
export const BROADCAST_ADVISOR_TIMEOUT_MS = 250;

/**
 * Settle `work` within the window, or give up on it and take `fallback`.
 *
 * The timer is deliberately **not** unref'd. It is the whole isolation guarantee — an advisor that
 * never resolves is exactly what this exists to survive — and an unref'd timer cannot fire when
 * the hung promise is the only thing left, so the process drains and the caller's await never
 * settles. Inside pi that never showed, because a live session always has other handles; under
 * `node --test` the file is the only thing running and every later test in it dies with
 * "Promise resolution is still pending but the event loop has already resolved".
 *
 * Holding the loop open is bounded by `timeoutMs` and the timer is always cleared, so a
 * well-behaved advisor costs nothing. The abandoned promise stays pending forever — a promise
 * cannot be cancelled — but nothing awaits it, so it holds nothing open.
 */
async function settleWithin<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export type TmuxWorkerWindowReady = {
	reason: "spawn" | "respawn" | string;
	workerId: string;
	workerLabel: string;
	workerDir: string;
	eventsFile: string;
	sessionName: string;
	windowTarget: string;
	windowId?: string;
	paneId?: string;
};

export type TmuxAdapterCallback = (event: TmuxWorkerWindowReady) => void | Promise<void>;

/** Companion adapter. The named callback keeps the seam extensible without adding
 * layout ownership to Docket's core lifecycle. */
export type TmuxAdapter = {
	onWorkerWindowReady: TmuxAdapterCallback;
};

/** Function form retained for tiny companions that treat the adapter as one callback. */
export type TmuxAdapterRegistration = TmuxAdapter | TmuxAdapterCallback;

declare global {
	var __docket: DocketExtensionSurface;
}

const SURFACE_KEY = "__docket";

type EventHandler = (event: { workerId: string; event: WorkerEvent }) => void;

export type DocketExtensionSurfaceInternals = DocketExtensionSurface & {
	emitWorkerEvent(workerId: string, event: WorkerEvent): void;
	emitWorkerWindowReady(event: TmuxWorkerWindowReady): Promise<void>;
	collectBroadcastSuggestions(input: BroadcastAdvisorInput, timeoutMs?: number): Promise<BroadcastSuggestion[]>;
};

function stringField(payload: Record<string, unknown>, key: string, fallback: string): string {
	const value = payload[key];
	return typeof value === "string" ? value : fallback;
}

/** Decode a `message` event into the observation shape. Returns undefined for anything else. */
export function messageObservationFromEvent(workerId: string, event: WorkerEvent): WorkerMessageObservation | undefined {
	if (event.kind !== "message") return undefined;
	const payload = event.payload ?? {};
	const messageId = typeof payload.id === "string" ? payload.id : undefined;
	if (!messageId) return undefined;
	const replyTo = typeof payload.replyTo === "string" ? payload.replyTo : undefined;
	return {
		workerId,
		direction: payload.direction === "out" ? "out" : "in",
		messageId,
		kind: stringField(payload, "kind", "directive"),
		from: stringField(payload, "from", "human"),
		delivery: stringField(payload, "delivery", "queued"),
		transport: stringField(payload, "transport", "inbox"),
		...(replyTo ? { replyTo } : {}),
		at: Number.isFinite(event.ts) ? event.ts : Date.now(),
	};
}

export function installDocketExtensionSurface(registry: WorkerKindRegistry): DocketExtensionSurfaceInternals {
	const handlers = new Set<EventHandler>();
	const messageObservers = new Set<MessageObserver>();
	const broadcastAdvisors = new Set<BroadcastAdvisor>();
	let tmuxAdapter: TmuxAdapterRegistration | undefined;
	const surface: DocketExtensionSurfaceInternals = {
		registerWorkerKind(kind) {
			return registry.register({ ...kind, source: kind.source ?? "runtime" });
		},
		listWorkerKinds() {
			return registry.list();
		},
		onWorkerEvent(handler) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		onMessage(handler) {
			messageObservers.add(handler);
			return () => messageObservers.delete(handler);
		},
		registerBroadcastAdvisor(advisor) {
			// Unlike the tmux adapter this is not exclusive: an advisor owns nothing, so several
			// can suggest without any of them being able to conflict.
			broadcastAdvisors.add(advisor);
			return () => broadcastAdvisors.delete(advisor);
		},
		async collectBroadcastSuggestions(input, timeoutMs = BROADCAST_ADVISOR_TIMEOUT_MS) {
			if (broadcastAdvisors.size === 0) return [];
			const known = new Set(input.candidates.map((candidate) => candidate.workerId));
			const results = await Promise.all([...broadcastAdvisors].map(async (advisor) => {
				try {
					const suggestions = await settleWithin<BroadcastSuggestion[]>(Promise.resolve(advisor(input)), timeoutMs, []);
					return Array.isArray(suggestions) ? suggestions : [];
				} catch {
					// A companion that throws is simply a companion with no opinion.
					return [];
				}
			}));
			const seen = new Set<string>();
			const collected: BroadcastSuggestion[] = [];
			for (const suggestion of results.flat()) {
				// An advisor cannot invent a recipient Docket did not already enumerate.
				if (!suggestion || typeof suggestion.workerId !== "string" || !known.has(suggestion.workerId)) continue;
				if (seen.has(suggestion.workerId)) continue;
				const reason = typeof suggestion.reason === "string" ? suggestion.reason.trim() : "";
				if (!reason) continue;
				seen.add(suggestion.workerId);
				collected.push({ workerId: suggestion.workerId, reason });
			}
			return collected;
		},
		registerTmuxAdapter(adapter) {
			if (tmuxAdapter) throw new Error("Docket tmux adapter already registered");
			tmuxAdapter = adapter;
			return () => {
				if (tmuxAdapter === adapter) tmuxAdapter = undefined;
			};
		},
		emitWorkerEvent(workerId, event) {
			for (const handler of handlers) {
				try { handler({ workerId, event }); } catch { /* never let a subscriber break docket */ }
			}
			// Decoded from the same emission rather than a second call site, so an observer can
			// never see a message the event stream did not.
			const observation = messageObservationFromEvent(workerId, event);
			if (!observation) return;
			for (const observer of messageObservers) {
				try { observer(observation); } catch { /* never let a subscriber break docket */ }
			}
		},
		async emitWorkerWindowReady(event) {
			if (!tmuxAdapter) return;
			try {
				if (typeof tmuxAdapter === "function") await tmuxAdapter(event);
				else await tmuxAdapter.onWorkerWindowReady(event);
			} catch (err) {
				// Operator UI is optional. A companion must never roll back a worker
				// launch or turn a healthy worker into a failed one.
				console.warn(`Docket tmux adapter failed for ${event.workerLabel}; worker will continue running.`, err);
			}
		},
	};
	(globalThis as Record<string, unknown>)[SURFACE_KEY] = surface;
	return surface;
}

/** Best-effort notification used by the worker substrate after IDs are persisted. */
export async function notifyTmuxAdapter(event: TmuxWorkerWindowReady): Promise<void> {
	const surface = getDocketExtensionSurface();
	if (!surface) return;
	try {
		if (typeof surface.emitWorkerWindowReady === "function") await surface.emitWorkerWindowReady(event);
	} catch (err) {
		// A stale or third-party surface must be just as harmless as a failing adapter.
		console.warn(`Docket tmux adapter notification failed for ${event.workerLabel}; worker will continue running.`, err);
	}
}

export function getDocketExtensionSurface(): DocketExtensionSurfaceInternals | undefined {
	return (globalThis as Record<string, unknown>)[SURFACE_KEY] as DocketExtensionSurfaceInternals | undefined;
}
