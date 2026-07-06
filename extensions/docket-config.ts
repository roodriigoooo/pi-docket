import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { CheckpointSummarizerConfig } from "./checkpoint-summarizer.js";

export type DocketWorkerConfig = {
	guardrailsPath?: string;
	/** Hide ended workers from the dock once they go untouched for this many minutes. Set 0 to keep them visible. */
	dockIdleHideMinutes?: number;
	/** Auto-prune ended worker dirs once they go untouched for this many hours. Set 0 to disable. */
	pruneAfterHours?: number;
	/** Max simultaneously active workers (across the whole tmux session). Excess /docket spawn calls are rejected. */
	maxActive?: number;
	/** Max child-spawn depth. Top-level parent is depth 0; its children are depth 1; etc. */
	maxSpawnDepth?: number;
	/** Project-default kind picked when /docket spawn is invoked without --as. */
	defaultKind?: string;
	/** When true, dock writes a compact worker line to tmux status-right so attached panes still see fleet state. */
	tmuxStatusLine?: boolean;
	/** When true, every spawned worker also runs tmux pipe-pane to <worker-dir>/pane.log for post-hoc debug. */
	captureTerminal?: boolean;
	/** Default parent-seed policy when neither `--seed`/`--fresh` nor the kind sets one. `"none"` (default) spawns fresh workers; `"full"` seeds the worker with the parent session JSONL. */
	parentSeedPolicy?: "full" | "none";
	/** When true, a short summary message is appended to the parent session when a worker reaches ready. Default false: nothing enters the parent JSONL automatically — the inbox card still surfaces the ready worker. */
	autoEmbedSummary?: boolean;
};

export type DocketConfig = {
	maxArtifacts: number;
	maxBodyChars: number;
	/** Canonical resolved field: initial artifact pool a saved bundle considers before user prune. */
	checkpointArtifacts: number;
	/** Public alias for checkpointArtifacts. Preferred in user config; checkpointArtifacts still accepted for back-compat. */
	bundleArtifacts?: number;
	consumedRetentionDays: number;
	summarizer: CheckpointSummarizerConfig;
	worker?: DocketWorkerConfig;
};

export const DEFAULT_CONFIG: DocketConfig = {
	maxArtifacts: 300,
	maxBodyChars: 6000,
	checkpointArtifacts: 24,
	consumedRetentionDays: 7,
	summarizer: {
		enabled: true,
		maxOutputTokens: 1200,
		maxInputChars: 36000,
		timeoutMs: 120000,
	},
	worker: {
		dockIdleHideMinutes: 30,
		pruneAfterHours: 24,
		maxActive: 8,
		maxSpawnDepth: 2,
		tmuxStatusLine: false,
		captureTerminal: false,
		autoEmbedSummary: false,
		parentSeedPolicy: "none",
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

export async function loadConfig(cwd: string): Promise<DocketConfig> {
	const globalConfig = await readJsonFile<Partial<DocketConfig>>(path.join(getAgentDir(), "docket.json"), {});
	const projectConfig = await readJsonFile<Partial<DocketConfig>>(path.join(cwd, ".pi", "docket.json"), {});
	// `bundleArtifacts` is the public name; `checkpointArtifacts` stays accepted for back-compat. Project overrides global.
	const bundleArtifacts =
		projectConfig.bundleArtifacts ?? projectConfig.checkpointArtifacts ??
		globalConfig.bundleArtifacts ?? globalConfig.checkpointArtifacts ??
		DEFAULT_CONFIG.checkpointArtifacts;
	return {
		...DEFAULT_CONFIG,
		...globalConfig,
		...projectConfig,
		checkpointArtifacts: bundleArtifacts,
		summarizer: {
			...DEFAULT_CONFIG.summarizer,
			...(globalConfig.summarizer ?? {}),
			...(projectConfig.summarizer ?? {}),
		},
		worker: {
			...DEFAULT_CONFIG.worker,
			...(globalConfig.worker ?? {}),
			...(projectConfig.worker ?? {}),
		},
	};
}
