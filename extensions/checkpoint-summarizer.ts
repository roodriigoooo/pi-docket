import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { CheckpointMode } from "./types.js";

export type CheckpointSummarizerConfig = {
	enabled: boolean;
	provider?: string;
	model?: string;
	maxOutputTokens: number;
	maxInputChars: number;
	timeoutMs: number;
	systemPrompt?: string;
};

type CheckpointSummarizerInput = {
	id: string;
	mode: CheckpointMode;
	note: string;
	consumeOnUse: boolean;
	cwd: string;
	sourceSession?: string;
	artifactsFile: string;
	payload: Array<Record<string, unknown>>;
	references: string;
	activeModel: ExtensionCommandContext["model"];
	modelRegistry: ExtensionCommandContext["modelRegistry"];
	config: CheckpointSummarizerConfig;
	overrides: { model?: string; maxOutputTokens?: number };
};

export type CheckpointSummarizer = {
	summarize(input: CheckpointSummarizerInput): Promise<string>;
};

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[Trail truncated ${text.length - max} chars]`;
}

function checkpointSystemPrompt(mode: CheckpointMode, maxOutputTokens: number): string {
	const modeGuidance: Record<CheckpointMode, string> = {
		handoff: "Preserve continuity for a fresh coding-agent session. Prioritize current goal, decisions, edited/important files, and next steps.",
		compact: "Make the smallest useful continuation note. Ruthlessly remove transcript noise and low-value details.",
		debug: "Focus on failing commands, error messages, hypotheses already tried, likely root causes, and safest next debugging steps.",
		review: "Focus on review state: changed files, design decisions, risks, test status, and what a reviewer should inspect next.",
	};
	return [
		"You are Trail, a context distillation assistant for Pi coding sessions.",
		"Summarize session artifacts into a fresh-session checkpoint.",
		"Do not produce a transcript search result or artifact dump.",
		"Preserve continuity, discard noise, and prevent repeated mistakes.",
		"Use compact markdown. Target the requested maximum output length.",
		"Reference artifacts by IDs like [file:f12] or [command:c8] when useful instead of copying large excerpts.",
		"Never invent files, commands, decisions, or outcomes not present in artifacts.",
		`Mode: ${mode}. ${modeGuidance[mode]}`,
		`Maximum output tokens: ${maxOutputTokens}.`,
	].join("\n");
}

function checkpointInput(input: CheckpointSummarizerInput): string {
	return truncate([
		`cwd: ${input.cwd}`,
		input.sourceSession ? `sourceSession: ${input.sourceSession}` : undefined,
		`mode: ${input.mode}`,
		input.note ? `userNote: ${input.note}` : undefined,
		"",
		"Write checkpoint markdown with these sections:",
		"## Summary",
		"## Decisions / constraints",
		"## Current state",
		"## Next steps",
		"## Avoid repeating",
		"## References",
		"",
		"References available:",
		input.references,
		"",
		"Artifacts JSON:",
		JSON.stringify(input.payload, null, 2),
	].filter((line): line is string => line !== undefined).join("\n"), input.config.maxInputChars);
}

export function createCheckpointSummarizer(): CheckpointSummarizer {
	return {
		async summarize(input: CheckpointSummarizerInput): Promise<string> {
			const maxOutputTokens = input.overrides.maxOutputTokens ?? input.config.maxOutputTokens;
			const modelName = input.overrides.model ?? (input.config.provider && input.config.model ? `${input.config.provider}/${input.config.model}` : undefined);
			const model = modelName
				? (() => {
					const [provider, ...rest] = modelName.split("/");
					return provider && rest.length ? input.modelRegistry.find(provider, rest.join("/")) : undefined;
				})()
				: input.activeModel;
			if (!model) throw new Error("No Trail summarizer model configured and no active model selected");

			const auth = await input.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);

			const userMessage: Message = {
				role: "user",
				content: [{ type: "text", text: checkpointInput(input) }],
				timestamp: Date.now(),
			};
			const response = await complete(
				model,
				{ systemPrompt: input.config.systemPrompt ?? checkpointSystemPrompt(input.mode, maxOutputTokens), messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: maxOutputTokens, timeoutMs: input.config.timeoutMs },
			);
			const summary = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n").trim();
			if (!summary) throw new Error("Trail summarizer returned empty checkpoint");

			const lines: string[] = [];
			lines.push(`# Trail checkpoint ${input.id}`);
			lines.push("");
			lines.push(`mode: ${input.mode}`);
			lines.push("summary: llm");
			lines.push(`cwd: ${input.cwd}`);
			lines.push(`created: ${new Date().toISOString()}`);
			if (input.sourceSession) lines.push(`sourceSession: ${input.sourceSession}`);
			if (input.note) lines.push(`note: ${input.note}`);
			if (input.consumeOnUse) lines.push("consumeOnUse: true");
			lines.push(`artifacts: ${input.artifactsFile}`);
			lines.push("");
			lines.push(summary);
			lines.push("");
			lines.push("## Trail artifact references");
			lines.push(input.references);
			return lines.join("\n");
		},
	};
}
