import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export const DEFAULT_KIND_NAME = "default";

export type WorkerParentSeedPolicy = "full" | "none";
export type WorkerLayout = "single" | "split-events";

/** Public kind shape: task intent and authority only. */
export type WorkerKind = {
	name: string;
	description?: string;
	readOnly: boolean;
	/** Opt-in gate: worker must ask the parent to approve its plan before first edit/mutating command. */
	planGate?: boolean;
	/** Scope-specific rights surfaced in task.md and guardrails. */
	decisionRights?: string[];
	maxArtifacts?: number;
	maxDurationSec?: number;
	guardrailsAppend?: string;
	systemPrompt?: string;
	source: "builtin" | "user" | "runtime";
	sourcePath?: string;
};

/** Execution keys accepted only while migrating pre-0.8 kinds. */
export type WorkerLegacyExecution = {
	model?: string;
	thinking?: string;
	parentSeedPolicy?: WorkerParentSeedPolicy;
	defaultWorktree?: boolean;
	layout?: WorkerLayout;
};

export type WorkerKindCompatibility = {
	legacyExecution?: WorkerLegacyExecution;
	legacyExecutionFields: string[];
	diagnostics: string[];
};

export type WorkerKindRegistration = Omit<WorkerKind, "source"> & {
	source?: WorkerKind["source"];
	/** @deprecated Use per-spawn --model. */
	model?: string;
	/** @deprecated Use per-spawn --thinking. */
	thinking?: string;
	/** @deprecated Use worker.parentSeedPolicy or per-spawn context flags. */
	parentSeedPolicy?: WorkerParentSeedPolicy;
	/** @deprecated Workspace now derives from readOnly intent. */
	defaultWorktree?: boolean;
	/** @deprecated Compatibility-only until tmux layout work lands. */
	layout?: WorkerLayout;
	/** @deprecated Ignored. Worker creation is human-only. */
	canSpawn?: string[];
};

export type WorkerKindRegistry = {
	get(name: string | undefined): WorkerKind;
	list(): WorkerKind[];
	names(): string[];
	register(kind: WorkerKindRegistration): () => void;
	unregister(name: string): boolean;
	reload(cwd: string): Promise<void>;
	defaultKind(projectDefault?: string): WorkerKind;
};

const compatibilityByKind = new WeakMap<WorkerKind, WorkerKindCompatibility>();

const BUILTIN_DEFAULT: WorkerKind = {
	name: DEFAULT_KIND_NAME,
	description: "General work: inspect freely; ask before the first mutation.",
	readOnly: false,
	planGate: true,
	source: "builtin",
};

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

function asStringList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/\r?\n|;/) : [];
	const cleaned = raw.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8);
	return cleaned.length ? cleaned : undefined;
}

function firstPresent(record: Record<string, unknown>, keys: string[]): { present: boolean; value?: unknown } {
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(record, key)) return { present: true, value: record[key] };
	}
	return { present: false };
}

function compatibilityDiagnostics(executionFields: string[], canSpawnPresent: boolean): string[] {
	const diagnostics: string[] = [];
	if (executionFields.length > 0) {
		diagnostics.push(`deprecated execution frontmatter (${executionFields.join(", ")}); move execution choices to /docket spawn flags or worker config before the next major release.`);
	}
	if (canSpawnPresent) diagnostics.push("can_spawn ignored; worker creation is human-only.");
	return diagnostics;
}

function attachCompatibility(kind: WorkerKind, compatibility: WorkerKindCompatibility | undefined): WorkerKind {
	if (compatibility) compatibilityByKind.set(kind, compatibility);
	return kind;
}

function frontmatterCompatibility(fm: Record<string, unknown>): WorkerKindCompatibility | undefined {
	const legacyExecution: WorkerLegacyExecution = {};
	const legacyExecutionFields: string[] = [];

	const model = firstPresent(fm, ["model"]);
	if (model.present) {
		legacyExecution.model = typeof model.value === "string" ? model.value.trim() : String(model.value ?? "");
		legacyExecutionFields.push("model");
	}
	const thinking = firstPresent(fm, ["thinking"]);
	if (thinking.present) {
		legacyExecution.thinking = typeof thinking.value === "string" ? thinking.value.trim().toLowerCase() : String(thinking.value ?? "");
		legacyExecutionFields.push("thinking");
	}
	const parentSeed = firstPresent(fm, ["parent_seed", "parentSeedPolicy", "seed"]);
	if (parentSeed.present) {
		legacyExecution.parentSeedPolicy = asSeedPolicy(parentSeed.value);
		legacyExecutionFields.push("parent_seed");
	}
	const defaultWorktree = firstPresent(fm, ["default_worktree", "defaultWorktree", "worktree"]);
	if (defaultWorktree.present) {
		legacyExecution.defaultWorktree = asBool(defaultWorktree.value, true);
		legacyExecutionFields.push("default_worktree");
	}
	const layout = firstPresent(fm, ["layout"]);
	if (layout.present) {
		legacyExecution.layout = asLayout(layout.value);
		legacyExecutionFields.push("layout");
	}
	const canSpawn = firstPresent(fm, ["can_spawn", "canSpawn", "spawn_kinds", "subagent_agents"]);
	const diagnostics = compatibilityDiagnostics(legacyExecutionFields, canSpawn.present);
	if (diagnostics.length === 0) return undefined;
	return {
		...(legacyExecutionFields.length > 0 ? { legacyExecution } : {}),
		legacyExecutionFields,
		diagnostics,
	};
}

function registrationCompatibility(input: WorkerKindRegistration): WorkerKindCompatibility | undefined {
	const record = input as WorkerKindRegistration & Record<string, unknown>;
	const legacyExecution: WorkerLegacyExecution = {};
	const legacyExecutionFields: string[] = [];
	if (Object.prototype.hasOwnProperty.call(record, "model")) {
		legacyExecution.model = typeof record.model === "string" ? record.model.trim() : String(record.model ?? "");
		legacyExecutionFields.push("model");
	}
	if (Object.prototype.hasOwnProperty.call(record, "thinking")) {
		legacyExecution.thinking = typeof record.thinking === "string" ? record.thinking.trim().toLowerCase() : String(record.thinking ?? "");
		legacyExecutionFields.push("thinking");
	}
	if (Object.prototype.hasOwnProperty.call(record, "parentSeedPolicy")) {
		legacyExecution.parentSeedPolicy = asSeedPolicy(record.parentSeedPolicy);
		legacyExecutionFields.push("parent_seed");
	}
	if (Object.prototype.hasOwnProperty.call(record, "defaultWorktree")) {
		legacyExecution.defaultWorktree = asBool(record.defaultWorktree, true);
		legacyExecutionFields.push("default_worktree");
	}
	if (Object.prototype.hasOwnProperty.call(record, "layout")) {
		legacyExecution.layout = asLayout(record.layout);
		legacyExecutionFields.push("layout");
	}
	const canSpawnPresent = Object.prototype.hasOwnProperty.call(record, "canSpawn");
	const diagnostics = compatibilityDiagnostics(legacyExecutionFields, canSpawnPresent);
	if (diagnostics.length === 0) return undefined;
	return {
		...(legacyExecutionFields.length > 0 ? { legacyExecution } : {}),
		legacyExecutionFields,
		diagnostics,
	};
}

export function workerKindCompatibility(kind: WorkerKind): WorkerKindCompatibility | undefined {
	return compatibilityByKind.get(kind);
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
	const readOnly = asBool(fm.read_only ?? fm.readonly ?? fm.readOnly, false);
	const maxArtifacts = asInt(fm.max_artifacts ?? fm.maxArtifacts);
	const maxDurationSec = asInt(fm.max_duration_sec ?? fm.maxDurationSec ?? fm.timeout);
	const planGate = asBool(fm.plan_gate ?? fm.planGate, false);
	const decisionRights = asStringList(fm.decision_rights ?? fm.decisionRights ?? fm.rights);
	const guardrailsAppend = typeof fm.guardrails_append === "string" ? fm.guardrails_append : undefined;
	const kind: WorkerKind = {
		name,
		...(description ? { description } : {}),
		readOnly,
		...(planGate ? { planGate } : {}),
		...(decisionRights ? { decisionRights } : {}),
		...(maxArtifacts !== undefined ? { maxArtifacts } : {}),
		...(maxDurationSec !== undefined ? { maxDurationSec } : {}),
		...(guardrailsAppend ? { guardrailsAppend } : {}),
		...(body.length > 0 ? { systemPrompt: body } : {}),
		source,
		...(sourcePath ? { sourcePath } : {}),
	};
	return attachCompatibility(kind, frontmatterCompatibility(fm));
}

function normalizeRegistration(input: WorkerKindRegistration, name: string): WorkerKind {
	const kind: WorkerKind = {
		name,
		...(input.description?.trim() ? { description: input.description.trim() } : {}),
		readOnly: input.readOnly === true,
		...(input.planGate ? { planGate: true } : {}),
		...(input.decisionRights?.length ? { decisionRights: [...input.decisionRights] } : {}),
		...(input.maxArtifacts !== undefined ? { maxArtifacts: input.maxArtifacts } : {}),
		...(input.maxDurationSec !== undefined ? { maxDurationSec: input.maxDurationSec } : {}),
		...(input.guardrailsAppend ? { guardrailsAppend: input.guardrailsAppend } : {}),
		...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
		source: input.source ?? "runtime",
		...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
	};
	return attachCompatibility(kind, registrationCompatibility(input));
}

function bundledKindsDir(): string {
	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	return path.join(extensionDir, "worker-kinds");
}

function userKindsDir(cwd: string): string[] {
	return [
		path.join(getAgentDir(), "docket", "worker-kinds"),
		path.join(cwd, ".pi", "docket", "worker-kinds"),
	];
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
		for (const kind of kinds.values()) if (kind.source === "runtime") preservedRuntime.push(kind);
		kinds.clear();
		kinds.set(BUILTIN_DEFAULT.name, BUILTIN_DEFAULT);
		const bundled = await readKindFiles(bundledKindsDir(), "builtin");
		for (const kind of bundled) set(kind);
		for (const dir of userKindsDir(cwd)) {
			const userKinds = await readKindFiles(dir, "user");
			for (const kind of userKinds) set(kind);
		}
		for (const kind of preservedRuntime) set(kind);
	};

	const reloadSync = (cwd: string): void => {
		// Best-effort worker-side fallback used before async config load completes.
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
			const normalized = normalizeWorkerKindName(name);
			return normalized ? kinds.get(normalized) ?? BUILTIN_DEFAULT : BUILTIN_DEFAULT;
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
		register(input: WorkerKindRegistration): () => void {
			const normalized = normalizeWorkerKindName(input.name);
			if (!normalized || normalized === DEFAULT_KIND_NAME) {
				throw new Error(`Docket: invalid worker kind name "${input.name}"`);
			}
			const normalizedKind = normalizeRegistration(input, normalized);
			set(normalizedKind);
			return () => {
				const current = kinds.get(normalized);
				if (current === normalizedKind) kinds.delete(normalized);
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
		// Sync fallback remains internal to the worker bootstrap path.
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
	if (kind.guardrailsAppend) parts.push(kind.guardrailsAppend.trim());
	if (kind.systemPrompt) parts.push(`\n${kind.systemPrompt.trim()}`);
	if (parts.length === 0) return "";
	return `\n\n## Kind-specific rules (kind: \`${kind.name}\`)\n\n${parts.join("\n")}\n`;
}
