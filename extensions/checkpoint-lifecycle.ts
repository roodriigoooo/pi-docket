import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { createArtifactCatalog, buildReferenceList, type ArtifactCatalog } from "./artifact-catalog.js";
import { showCheckpointSelector } from "./checkpoint-selector.js";
import { createCheckpointStore, type CheckpointStore } from "./checkpoint-store.js";
import { createCheckpointSummarizer, type CheckpointSummarizer } from "./checkpoint-summarizer.js";
import { gitSnapshotLabel, readGitSnapshot } from "./git-context.js";
import { loadConfig, type TrailConfig } from "./trail-config.js";
import type { CheckpointCreateOptions } from "./trail-command-grammar.js";
import type { Artifact, CheckpointIndexEntry, GitSnapshot } from "./types.js";

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
	selectArtifactsForCheckpoint?: (artifacts: Artifact[], options: CheckpointCreateOptions) => Promise<Artifact[] | null> | Artifact[] | null;
	notify?: (text: string, level: NotifyLevel) => void;
};

function makeCheckpointId(): string {
	const d = new Date();
	const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	return stamp.replace("T", "-");
}

// Bundle-first checkpoint: a small deterministic orientation header. The artifact bundle
// (.artifacts.json) is the spine; it is mounted at zero token cost on continue/load. This header
// is all that enters a fresh session's context — never the artifact contents. Decisions and next
// steps are human-authored (the note + the editor pass), not model-guessed. See ADR-0001.
function buildOrientationHeader(
	ctx: ExtensionCommandContext,
	id: string,
	note: string,
	consumeOnUse: boolean,
	artifacts: Artifact[],
	references: string,
	git?: GitSnapshot,
): string {
	const usage = ctx.getContextUsage();
	const files = [...new Set(artifacts.filter((a) => a.kind === "file").map((a) => a.title.replace(/^(read|write|edit|grep|find|ls)\s+/, "")))];
	const errors = artifacts.filter((a) => a.kind === "error");

	const lines: string[] = [];
	lines.push(`# Trail checkpoint ${id}`);
	lines.push("");
	lines.push("mode: handoff");
	lines.push(`cwd: ${ctx.cwd}`);
	lines.push(`created: ${new Date().toISOString()}`);
	if (ctx.sessionManager.getSessionFile()) lines.push(`sourceSession: ${ctx.sessionManager.getSessionFile()}`);
	const gitLabel = gitSnapshotLabel(git);
	if (gitLabel) lines.push(`git: ${gitLabel}`);
	if (usage && usage.tokens !== null) lines.push(`context: ~${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`);
	if (note) lines.push(`note: ${note}`);
	if (consumeOnUse) lines.push("consumeOnUse: true");
	lines.push("");
	lines.push("## Resuming");
	lines.push(note || "(state the goal you are resuming)");
	lines.push("");
	lines.push("## Decisions");
	lines.push("<!-- decisions that constrain the continuation; state facts, not guesses -->");
	lines.push("");
	lines.push("## Next steps");
	lines.push("<!-- concrete, ordered -->");
	lines.push("");
	lines.push("## Files touched or inspected");
	lines.push(files.length ? files.map((f) => `- ${f}`).join("\n") : "- (none captured)");
	lines.push("");
	lines.push("## Errors to avoid repeating");
	lines.push(errors.length ? errors.slice(0, 8).map((a) => `- ${a.title}: ${a.subtitle}`).join("\n") : "- (none captured)");
	lines.push("");
	lines.push("## Mounted artifacts");
	lines.push("This checkpoint's artifacts are mounted at zero token cost. Read current file contents from disk; chip an artifact with `/trail ref <ref>` when you need its detail.");
	lines.push("");
	lines.push(references);
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

	const selectArtifacts = (): Artifact[] => {
		return catalog.selectForCheckpoint(config.checkpointArtifacts);
	};

	const reviewArtifactSelection = async (artifacts: Artifact[], options: CheckpointCreateOptions): Promise<Artifact[] | null> => {
		if (deps.selectArtifactsForCheckpoint) return deps.selectArtifactsForCheckpoint(artifacts, options);
		if (!ctx.hasUI) return artifacts;
		return showCheckpointSelector(ctx, artifacts, "handoff");
	};

	const draftMarkdown = async (id: string, options: CheckpointCreateOptions, artifacts: Artifact[], git?: GitSnapshot): Promise<string> => {
		const header = buildOrientationHeader(ctx, id, options.note, options.consumeOnUse, artifacts, buildReferenceList(artifacts, ctx.cwd), git);
		if (!options.summarize || !config.summarizer.enabled) return header;
		if (ctx.hasUI) ctx.ui.notify("Trail summarizing checkpoint...", "info");
		try {
			return await summarizer.summarize({
				id,
				mode: "handoff",
				note: options.note,
				consumeOnUse: options.consumeOnUse,
				cwd: ctx.cwd,
				sourceSession: ctx.sessionManager.getSessionFile(),
				git,
				artifactsFile: store.artifactsFile(id),
				payload: catalog.checkpointPayload(artifacts),
				references: buildReferenceList(artifacts, ctx.cwd),
				activeModel: ctx.model,
				modelRegistry: ctx.modelRegistry,
				config: config.summarizer,
				overrides: { model: options.model, maxOutputTokens: options.maxOutputTokens },
			});
		} catch (err) {
			notify(`Trail summarizer failed; using bundle header: ${String(err)}`, "warning");
			return header;
		}
	};

	const reviewMarkdown = async (markdown: string): Promise<string | null> => {
		if (deps.reviewMarkdown) return deps.reviewMarkdown(markdown);
		if (!ctx.hasUI) return markdown;
		const edited = await ctx.ui.editor("Edit Trail checkpoint", markdown);
		if (edited === undefined) return null;
		return edited;
	};

	const persistCheckpoint = async (id: string, options: CheckpointCreateOptions, markdown: string, artifacts: Artifact[], git?: GitSnapshot): Promise<CheckpointIndexEntry> => {
		return store.save({
			id,
			mode: "handoff",
			markdown,
			artifacts,
			cwd: ctx.cwd,
			sourceSession: ctx.sessionManager.getSessionFile(),
			git,
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
			const candidates = selectArtifacts();
			if (candidates.length === 0) {
				notify("Trail found no artifacts to checkpoint", "warning");
				return;
			}

			const artifacts = await reviewArtifactSelection(candidates, options);
			if (artifacts === null) {
				notify("Trail checkpoint cancelled", "info");
				return;
			}
			if (artifacts.length === 0) {
				notify("Trail found no artifacts to checkpoint", "warning");
				return;
			}

			const id = (deps.makeId ?? makeCheckpointId)();
			const git = readGitSnapshot(ctx.cwd);
			const draft = await draftMarkdown(id, options, artifacts, git);
			const markdown = await reviewMarkdown(draft);
			if (markdown === null) {
				notify("Trail checkpoint cancelled", "info");
				return;
			}

			const entry = await persistCheckpoint(id, options, markdown, artifacts, git);
			labelSession(id, entry);
			notify(`Trail checkpoint saved: ${id}${options.consumeOnUse ? " (once)" : ""}`, "info");
		},
	};
}
