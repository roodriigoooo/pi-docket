import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { CheckpointSummarizerConfig } from "./checkpoint-summarizer.js";

export type TrailWorkerConfig = {
	guardrailsPath?: string;
};

export type TrailConfig = {
	maxArtifacts: number;
	maxBodyChars: number;
	checkpointArtifacts: number;
	consumedRetentionDays: number;
	summarizer: CheckpointSummarizerConfig;
	worker?: TrailWorkerConfig;
};

export const DEFAULT_CONFIG: TrailConfig = {
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
	worker: {},
};

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
	try {
		if (!existsSync(file)) return fallback;
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export async function loadConfig(cwd: string): Promise<TrailConfig> {
	const globalConfig = await readJsonFile<Partial<TrailConfig>>(path.join(getAgentDir(), "trail.json"), {});
	const projectConfig = await readJsonFile<Partial<TrailConfig>>(path.join(cwd, ".pi", "trail.json"), {});
	return {
		...DEFAULT_CONFIG,
		...globalConfig,
		...projectConfig,
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
