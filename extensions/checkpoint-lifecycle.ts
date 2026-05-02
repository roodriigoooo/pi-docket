import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { createArtifactCatalog, buildReferenceList, truncateText, type ArtifactCatalog } from "./artifact-catalog.js";
import { createCheckpointStore, type CheckpointStore } from "./checkpoint-store.js";
import { createCheckpointSummarizer, type CheckpointSummarizer } from "./checkpoint-summarizer.js";
import { loadConfig, type TrailConfig } from "./trail-config.js";
import type { CheckpointCreateOptions } from "./trail-command-grammar.js";
import type { Artifact, CheckpointIndexEntry, CheckpointMode } from "./types.js";

export type CheckpointLifecycle = {
	create(options: CheckpointCreateOptions): Promise<void>;
};

type NotifyLevel = "info" | "warning" | "error";

type CheckpointLifecycleDeps = {
	loadConfig?: (cwd: string) => Promise<TrailConfig>;
	createCatalog?: (ctx: ExtensionCommandContext, config: TrailConfig) => ArtifactCatalog;
	store?: CheckpointStore;
	summarizer?: CheckpointSummarizer;
	makeId?: () => string;
	reviewMarkdown?: (markdown: string) => Promise<string | null>;
	notify?: (text: string, level: NotifyLevel) => void;
};

function makeCheckpointId(): string {
	const d = new Date();
	const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	return stamp.replace("T", "-");
}

function buildRawCheckpointMarkdown(
	ctx: ExtensionCommandContext,
	id: string,
	mode: CheckpointMode,
	note: string,
	consumeOnUse: boolean,
	artifacts: Artifact[],
): string {
	const usage = ctx.getContextUsage();
	const files = [...new Set(artifacts.filter((a) => a.kind === "file").map((a) => a.title.replace(/^(read|write|edit|grep|find|ls)\s+/, "")))];
	const errors = artifacts.filter((a) => a.kind === "error");
	const commands = artifacts.filter((a) => a.kind === "command");

	const lines: string[] = [];
	lines.push(`# Trail checkpoint ${id}`);
	lines.push("");
	lines.push(`mode: ${mode}`);
	lines.push(`cwd: ${ctx.cwd}`);
	lines.push(`created: ${new Date().toISOString()}`);
	if (ctx.sessionManager.getSessionFile()) lines.push(`sourceSession: ${ctx.sessionManager.getSessionFile()}`);
	if (usage && usage.tokens !== null) lines.push(`context: ~${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`);
	if (note) lines.push(`note: ${note}`);
	if (consumeOnUse) lines.push("consumeOnUse: true");
	lines.push("");
	lines.push("## Intent");
	lines.push(note || "Continue from preserved session artifacts. Preserve continuity, discard noise, avoid repeated mistakes.");
	lines.push("");
	lines.push("## Files touched or inspected");
	lines.push(files.length ? files.map((f) => `- ${f}`).join("\n") : "- (none captured)");
	lines.push("");
	lines.push("## Errors and failed attempts");
	lines.push(errors.length ? errors.map((a) => `- ${a.title}: ${a.subtitle}`).join("\n") : "- (none captured)");
	lines.push("");
	lines.push("## Commands worth preserving");
	lines.push(commands.length ? commands.slice(0, 10).map((a) => `- ${a.title} (${a.subtitle})`).join("\n") : "- (none captured)");
	lines.push("");
	lines.push("## Artifact excerpts");
	for (const artifact of artifacts) {
		lines.push("");
		lines.push(`### ${artifact.kind}: ${artifact.title}`);
		if (artifact.subtitle) lines.push(`_${artifact.subtitle}_`);
		lines.push("");
		lines.push(truncateText(artifact.body.trim(), mode === "compact" ? 900 : 1800));
	}
	lines.push("");
	lines.push("## Fresh-session instruction");
	lines.push("Use checkpoint above as source of truth. Continue work without assuming full prior transcript exists. Do not repeat failed attempts listed above unless explicitly correcting them.");
	return lines.join("\n");
}

function defaultNotify(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string, level: NotifyLevel): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else pi.sendMessage({ customType: "trail", content: text, display: true, details: { kind: level === "error" ? "error" : "notice" } }, { triggerTurn: false });
}

export async function createCheckpointLifecycle(pi: ExtensionAPI, ctx: ExtensionCommandContext, deps: CheckpointLifecycleDeps = {}): Promise<CheckpointLifecycle> {
	const config = await (deps.loadConfig ?? loadConfig)(ctx.cwd);
	const catalog = deps.createCatalog ? deps.createCatalog(ctx, config) : createArtifactCatalog(ctx, config);
	const store = deps.store ?? createCheckpointStore();
	const summarizer = deps.summarizer ?? createCheckpointSummarizer();
	const notify = deps.notify ?? ((text: string, level: NotifyLevel) => defaultNotify(pi, ctx, text, level));

	const selectArtifacts = (options: CheckpointCreateOptions): Artifact[] => {
		return catalog.selectForCheckpoint(options.mode, config.checkpointArtifacts);
	};

	const draftMarkdown = async (id: string, options: CheckpointCreateOptions, artifacts: Artifact[]): Promise<string> => {
		if (options.raw || !config.summarizer.enabled) {
			return buildRawCheckpointMarkdown(ctx, id, options.mode, options.note, options.consumeOnUse, artifacts);
		}
		if (ctx.hasUI) ctx.ui.notify("Trail summarizing checkpoint...", "info");
		try {
			return await summarizer.summarize({
				id,
				mode: options.mode,
				note: options.note,
				consumeOnUse: options.consumeOnUse,
				cwd: ctx.cwd,
				sourceSession: ctx.sessionManager.getSessionFile(),
				artifactsFile: store.artifactsFile(id),
				payload: catalog.checkpointPayload(artifacts, options.mode),
				references: buildReferenceList(artifacts, ctx.cwd),
				activeModel: ctx.model,
				modelRegistry: ctx.modelRegistry,
				config: config.summarizer,
				overrides: { model: options.model, maxOutputTokens: options.maxOutputTokens },
			});
		} catch (err) {
			notify(`Trail summarizer failed; using raw checkpoint: ${String(err)}`, "warning");
			return buildRawCheckpointMarkdown(ctx, id, options.mode, options.note, options.consumeOnUse, artifacts);
		}
	};

	const reviewMarkdown = async (markdown: string): Promise<string | null> => {
		if (deps.reviewMarkdown) return deps.reviewMarkdown(markdown);
		if (!ctx.hasUI) return markdown;
		const edited = await ctx.ui.editor("Edit Trail checkpoint", markdown);
		if (edited === undefined) return null;
		return edited;
	};

	const persistCheckpoint = async (id: string, options: CheckpointCreateOptions, markdown: string, artifacts: Artifact[]): Promise<CheckpointIndexEntry> => {
		return store.save({
			id,
			mode: options.mode,
			markdown,
			artifacts,
			cwd: ctx.cwd,
			sourceSession: ctx.sessionManager.getSessionFile(),
			note: options.note,
			consumeOnUse: options.consumeOnUse,
		});
	};

	const labelSession = (id: string, entry: CheckpointIndexEntry): void => {
		pi.appendEntry("trail:checkpoint", entry);
		const leaf = ctx.sessionManager.getLeafId();
		if (leaf) pi.setLabel(leaf, `trail:${id}`);
	};

	return {
		async create(options: CheckpointCreateOptions): Promise<void> {
			const artifacts = selectArtifacts(options);
			if (artifacts.length === 0) {
				notify("Trail found no artifacts to checkpoint", "warning");
				return;
			}

			const id = (deps.makeId ?? makeCheckpointId)();
			const draft = await draftMarkdown(id, options, artifacts);
			const markdown = await reviewMarkdown(draft);
			if (markdown === null) {
				notify("Trail checkpoint cancelled", "info");
				return;
			}

			const entry = await persistCheckpoint(id, options, markdown, artifacts);
			labelSession(id, entry);
			notify(`Trail checkpoint saved: ${id}${options.consumeOnUse ? " (once)" : ""}`, "info");
		},
	};
}
