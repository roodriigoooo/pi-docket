import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export type DocketWorkerConfig = {
	guardrailsPath?: string;
	/** Hide ended workers from the dock once they go untouched for this many minutes. Set 0 to keep them visible. */
	dockIdleHideMinutes?: number;
	/** Auto-prune ended worker dirs once they go untouched for this many hours. Set 0 to disable. */
	pruneAfterHours?: number;
	/** Max simultaneously active workers (across the whole tmux session). Excess /docket spawn calls are rejected. */
	maxActive?: number;
	/** Project-default kind picked when /docket spawn is invoked without --as. */
	defaultKind?: string;
	/** Parent-seed policy below per-spawn flags and above legacy kind `parent_seed`. Absence resolves fresh after compatibility checks. */
	parentSeedPolicy?: "full" | "none";
};

export type DocketConfig = {
	maxArtifacts: number;
	maxBodyChars: number;
	worker?: DocketWorkerConfig;
	/** One-shot migration notices discovered while reading legacy config. */
	migrationWarnings?: string[];
};

export const DEFAULT_CONFIG: DocketConfig = {
	maxArtifacts: 300,
	maxBodyChars: 6000,
	worker: {
		dockIdleHideMinutes: 30,
		pruneAfterHours: 24,
		maxActive: 8,
	},
};

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
	try {
		if (!existsSync(file)) return fallback;
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function withoutRemovedTmuxKeys(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const worker = { ...(value as Record<string, unknown>) };
	delete worker.tmuxStatusLine;
	delete worker.captureTerminal;
	delete worker.layout;
	delete worker.pipePane;
	delete worker.statusRight;
	return worker;
}

function withoutRemovedBundleKeys(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const config = { ...(value as Record<string, unknown>) };
	delete config.bundleArtifacts;
	delete config.checkpointArtifacts;
	delete config.consumedRetentionDays;
	delete config.summarizer;
	delete config.migrationWarnings;
	return config;
}

export async function loadConfig(cwd: string): Promise<DocketConfig> {
	const globalConfig = await readJsonFile<Record<string, any>>(path.join(getAgentDir(), "docket.json"), {});
	const projectConfig = await readJsonFile<Record<string, any>>(path.join(cwd, ".pi", "docket.json"), {});
	const migrationWarnings: string[] = [];
	const hasRemovedTmuxKey = [globalConfig, projectConfig].some((config) => {
		const worker = config.worker;
		return worker && typeof worker === "object" && ["tmuxStatusLine", "captureTerminal", "layout", "pipePane", "statusRight"].some((key) => Object.prototype.hasOwnProperty.call(worker, key));
	});
	if (hasRemovedTmuxKey) migrationWarnings.push("obsolete worker tmux config ignored; operator layouts moved out of core.");
	const hasObsoleteBundleConfig = [globalConfig, projectConfig].some((config) => ["bundleArtifacts", "checkpointArtifacts", "consumedRetentionDays", "summarizer"].some((key) => Object.prototype.hasOwnProperty.call(config, key)));
	if (hasObsoleteBundleConfig) migrationWarnings.push("obsolete bundle and summarizer config ignored; /docket save now writes durable deliverables.");
	return {
		...DEFAULT_CONFIG,
		...withoutRemovedBundleKeys(globalConfig),
		...withoutRemovedBundleKeys(projectConfig),
		worker: {
			...DEFAULT_CONFIG.worker,
			...withoutRemovedTmuxKeys(globalConfig.worker),
			...withoutRemovedTmuxKeys(projectConfig.worker),
		},
		...(migrationWarnings.length ? { migrationWarnings } : {}),
	};
}
