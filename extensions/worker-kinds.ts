import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export const DEFAULT_KIND_NAME = "default";

export type WorkerParentSeedPolicy = "full" | "none";
export type WorkerLayout = "single" | "split-events";
export type WorkerThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type WorkerKind = {
	name: string;
	description?: string;
	model?: string;
	thinking?: WorkerThinking;
	readOnly: boolean;
	defaultWorktree: boolean;
	parentSeedPolicy: WorkerParentSeedPolicy;
	maxArtifacts?: number;
	maxDurationSec?: number;
	canSpawn: string[];
	/** Opt-in gate: worker must ask the parent to approve its plan before first edit/mutating command. */
	planGate?: boolean;
	/** Scope-specific rights surfaced in task.md and guardrails. */
	decisionRights?: string[];
	guardrailsAppend?: string;
	systemPrompt?: string;
	layout: WorkerLayout;
	source: "builtin" | "user" | "runtime";
	sourcePath?: string;
};

export type WorkerKindRegistry = {
	get(name: string | undefined): WorkerKind;
	list(): WorkerKind[];
	names(): string[];
	register(kind: WorkerKind): () => void;
	unregister(name: string): boolean;
	reload(cwd: string): Promise<void>;
	defaultKind(projectDefault?: string): WorkerKind;
};

const BUILTIN_DEFAULT: WorkerKind = {
	name: DEFAULT_KIND_NAME,
	description: "General-purpose Docket worker; matches pre-kinds behavior.",
	readOnly: false,
	defaultWorktree: true,
	parentSeedPolicy: "none",
	canSpawn: [],
	layout: "single",
	source: "builtin",
};

function csv(value: string | undefined): string[] {
	if (!value) return [];
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function asBool(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return fallback;
	const lowered = value.trim().toLowerCase();
	if (["true", "yes", "y", "1", "on"].includes(lowered)) return true;
	if (["false", "no", "n", "0", "off"].includes(lowered)) return false;
	return fallback;
}

function asInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
	if (typeof value !== "string") return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

// Default is "none" (fresh worker) so spawned workers do not inherit the parent
// session's full context. Kinds that want parent-context seeding opt in with
// `parent_seed: full`; callers can force it per-spawn with `--seed`.
function asSeedPolicy(value: unknown): WorkerParentSeedPolicy {
	if (typeof value === "string") {
		const lowered = value.trim().toLowerCase();
		if (lowered === "full" || lowered === "seed" || lowered === "seeded") return "full";
	}
	return "none";
}

function asLayout(value: unknown): WorkerLayout {
	if (typeof value === "string" && value.trim().toLowerCase() === "split-events") return "split-events";
	return "single";
}

function asThinking(value: unknown): WorkerThinking | undefined {
	if (typeof value !== "string") return undefined;
	const lowered = value.trim().toLowerCase();
	if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(lowered)) return lowered as WorkerThinking;
	return undefined;
}

function asStringList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/\r?\n|;/) : [];
	const cleaned = raw.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8);
	return cleaned.length ? cleaned : undefined;
}

export function normalizeWorkerKindName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
	return trimmed.length > 0 ? trimmed.slice(0, 32) : undefined;
}

export function parseWorkerKindMarkdown(text: string, source: WorkerKind["source"], sourcePath?: string): WorkerKind | undefined {
	const parsed = parseFrontmatter<Record<string, unknown>>(text);
	const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
	const name = normalizeWorkerKindName(typeof fm.name === "string" ? fm.name : undefined);
	if (!name || name === DEFAULT_KIND_NAME) return undefined;
	const body = (parsed.body ?? "").trim();
	const description = typeof fm.description === "string" ? fm.description.trim() : undefined;
	const model = typeof fm.model === "string" ? fm.model.trim() : undefined;
	const thinking = asThinking(fm.thinking);
	const readOnly = asBool(fm.read_only ?? fm.readonly ?? fm.readOnly, false);
	const defaultWorktree = asBool(fm.default_worktree ?? fm.defaultWorktree ?? fm.worktree, true);
	const parentSeedPolicy = asSeedPolicy(fm.parent_seed ?? fm.parentSeedPolicy ?? fm.seed);
	const maxArtifacts = asInt(fm.max_artifacts ?? fm.maxArtifacts);
	const maxDurationSec = asInt(fm.max_duration_sec ?? fm.maxDurationSec ?? fm.timeout);
	const canSpawnRaw = fm.can_spawn ?? fm.canSpawn ?? fm.spawn_kinds ?? fm.subagent_agents;
	const canSpawn = Array.isArray(canSpawnRaw) ? canSpawnRaw.map(String) : csv(typeof canSpawnRaw === "string" ? canSpawnRaw : undefined);
	const planGate = asBool(fm.plan_gate ?? fm.planGate, false);
	const decisionRights = asStringList(fm.decision_rights ?? fm.decisionRights ?? fm.rights);
	const guardrailsAppend = typeof fm.guardrails_append === "string" ? fm.guardrails_append : undefined;
	const layout = asLayout(fm.layout);
	return {
		name,
		...(description ? { description } : {}),
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		readOnly,
		defaultWorktree,
		parentSeedPolicy,
		...(maxArtifacts !== undefined ? { maxArtifacts } : {}),
		...(maxDurationSec !== undefined ? { maxDurationSec } : {}),
		canSpawn: canSpawn.map(normalizeWorkerKindName).filter((value): value is string => typeof value === "string"),
		...(planGate ? { planGate } : {}),
		...(decisionRights ? { decisionRights } : {}),
		...(guardrailsAppend ? { guardrailsAppend } : {}),
		...(body.length > 0 ? { systemPrompt: body } : {}),
		layout,
		source,
		...(sourcePath ? { sourcePath } : {}),
	};
}

function bundledKindsDir(): string {
	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	return path.join(extensionDir, "worker-kinds");
}

function userKindsDir(cwd: string): string[] {
	const out: string[] = [];
	out.push(path.join(getAgentDir(), "docket", "worker-kinds"));
	out.push(path.join(cwd, ".pi", "docket", "worker-kinds"));
	return out;
}

async function readKindFiles(dir: string, source: WorkerKind["source"]): Promise<WorkerKind[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return [];
	}
	const out: WorkerKind[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(dir, entry);
		try {
			const text = await fs.readFile(filePath, "utf8");
			const kind = parseWorkerKindMarkdown(text, source, filePath);
			if (kind) out.push(kind);
		} catch {
			// skip broken files
		}
	}
	return out;
}

export function createWorkerKindRegistry(): WorkerKindRegistry {
	const kinds = new Map<string, WorkerKind>();
	kinds.set(BUILTIN_DEFAULT.name, BUILTIN_DEFAULT);

	const set = (kind: WorkerKind): void => {
		kinds.set(kind.name, kind);
	};

	const reload = async (cwd: string): Promise<void> => {
		// Preserve runtime-registered kinds across reload; refresh builtin + user kinds from disk.
		const preservedRuntime: WorkerKind[] = [];
		for (const k of kinds.values()) if (k.source === "runtime") preservedRuntime.push(k);
		kinds.clear();
		kinds.set(BUILTIN_DEFAULT.name, BUILTIN_DEFAULT);
		const bundled = await readKindFiles(bundledKindsDir(), "builtin");
		for (const k of bundled) set(k);
		for (const dir of userKindsDir(cwd)) {
			const userKinds = await readKindFiles(dir, "user");
			for (const k of userKinds) set(k);
		}
		for (const k of preservedRuntime) set(k);
	};

	const reloadSync = (cwd: string): void => {
		// Only used as a best-effort sync fallback. Reads bundled MDs from disk so the
		// worker-side, which doesn't await config load, can still resolve its kind.
		try {
			const entries = fsSync.readdirSync(bundledKindsDir());
			for (const entry of entries) {
				if (!entry.endsWith(".md")) continue;
				try {
					const filePath = path.join(bundledKindsDir(), entry);
					const text = fsSync.readFileSync(filePath, "utf8");
					const kind = parseWorkerKindMarkdown(text, "builtin", filePath);
					if (kind && !kinds.has(kind.name)) set(kind);
				} catch { /* skip */ }
			}
		} catch { /* dir missing is fine */ }
		try {
			for (const dir of userKindsDir(cwd)) {
				const entries = fsSync.readdirSync(dir);
				for (const entry of entries) {
					if (!entry.endsWith(".md")) continue;
					try {
						const filePath = path.join(dir, entry);
						const text = fsSync.readFileSync(filePath, "utf8");
						const kind = parseWorkerKindMarkdown(text, "user", filePath);
						if (kind) set(kind);
					} catch { /* skip */ }
				}
			}
		} catch { /* skip */ }
	};

	return {
		get(name: string | undefined): WorkerKind {
			if (!name) return BUILTIN_DEFAULT;
			return kinds.get(name) ?? BUILTIN_DEFAULT;
		},
		list(): WorkerKind[] {
			return Array.from(kinds.values()).sort((a, b) => {
				if (a.name === DEFAULT_KIND_NAME) return -1;
				if (b.name === DEFAULT_KIND_NAME) return 1;
				return a.name.localeCompare(b.name);
			});
		},
		names(): string[] {
			return Array.from(kinds.keys()).sort();
		},
		register(kind: WorkerKind): () => void {
			const normalized = normalizeWorkerKindName(kind.name);
			if (!normalized || normalized === DEFAULT_KIND_NAME) {
				throw new Error(`Docket: invalid worker kind name "${kind.name}"`);
			}
			const normalizedKind: WorkerKind = { ...kind, name: normalized, source: kind.source ?? "runtime" };
			set(normalizedKind);
			return () => {
				const current = kinds.get(normalized);
				if (current && current === normalizedKind) kinds.delete(normalized);
			};
		},
		unregister(name: string): boolean {
			const normalized = normalizeWorkerKindName(name);
			if (!normalized || normalized === DEFAULT_KIND_NAME) return false;
			return kinds.delete(normalized);
		},
		reload,
		defaultKind(projectDefault?: string): WorkerKind {
			if (projectDefault) {
				const explicit = kinds.get(normalizeWorkerKindName(projectDefault) ?? "");
				if (explicit) return explicit;
			}
			return BUILTIN_DEFAULT;
		},
		// Expose sync fallback for the worker-side path that runs before config loads.
		// Not part of the public type to avoid leaking blocking I/O affordances.
		...({ _reloadSync: reloadSync } as Record<string, unknown>),
	};
}

export function workerKindGuardrailsAppendix(kind: WorkerKind): string {
	const parts: string[] = [];
	if (kind.readOnly) parts.push("- This worker is **read-only** by configuration. Do not edit files. If the task requires edits, call `docket_wait` and ask the parent to spawn a writable worker instead.");
	if (kind.decisionRights?.length) parts.push(["Decision rights for this kind:", ...kind.decisionRights.map((right) => `  - ${right}`)].join("\n"));
	if (kind.planGate) parts.push("- Plan gate required: before the first file edit, mutating shell command, migration, paid/external write, or broad refactor, call `docket_wait` with a concise plan, concrete options, and your recommendation. Wait for the parent reply before crossing that boundary. Read-only discovery and harmless checks are allowed before the gate.");
	if (kind.maxArtifacts !== undefined) parts.push(`- Artifact cap for this kind: ${kind.maxArtifacts}. Stay focused.`);
	if (kind.maxDurationSec !== undefined) parts.push(`- Soft time budget for this kind: ${kind.maxDurationSec}s. If you exceed it, call \`docket_done\` with partial findings rather than continuing silently.`);
	if (kind.canSpawn.length > 0) parts.push(`- You may dispatch child workers via \`docket_spawn_child\` using only these kinds: ${kind.canSpawn.join(", ")}. Children inherit fleet/depth caps. Children's results return to you, not to the human user.`);
	if (kind.guardrailsAppend) parts.push(kind.guardrailsAppend.trim());
	if (kind.systemPrompt) parts.push(`\n${kind.systemPrompt.trim()}`);
	if (parts.length === 0) return "";
	return `\n\n## Kind-specific rules (kind: \`${kind.name}\`)\n\n${parts.join("\n")}\n`;
}
