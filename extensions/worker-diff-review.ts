import { execFileSync, spawn } from "node:child_process";
import type { WorkerStatus } from "./background-work.js";
import type { Artifact } from "./types.js";

export type HunkReviewAction = "send" | "copy" | "ignore";

export type HunkReviewComment = {
	id?: string;
	filePath: string;
	newLine?: number;
	oldLine?: number;
	summary: string;
	rationale?: string;
	author?: string;
};

export type HunkReviewResult =
	| { available: false; comments: []; message: string }
	| { available: true; comments: HunkReviewComment[]; message?: string };

export type HunkReviewOptions = {
	hunkBin?: string;
	env?: NodeJS.ProcessEnv;
};

type RawHunkComment = Record<string, unknown>;

function hunkBin(options: HunkReviewOptions = {}): string {
	return options.hunkBin ?? "hunk";
}

function positiveNumber(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function rawCommentArray(parsed: unknown): RawHunkComment[] {
	if (Array.isArray(parsed)) return parsed.filter((item): item is RawHunkComment => item !== null && typeof item === "object");
	if (parsed && typeof parsed === "object" && Array.isArray((parsed as { comments?: unknown }).comments)) {
		return (parsed as { comments: unknown[] }).comments.filter((item): item is RawHunkComment => item !== null && typeof item === "object");
	}
	return [];
}

export function parseHunkComments(rawJson: string): HunkReviewComment[] {
	try {
		const parsed = JSON.parse(rawJson) as unknown;
		return rawCommentArray(parsed).map((item) => {
			const filePath = optionalString(item.filePath) ?? optionalString(item.file_path) ?? optionalString(item.file) ?? "unknown";
			const summary = optionalString(item.summary) ?? optionalString(item.comment) ?? optionalString(item.body) ?? "";
			return {
				...(optionalString(item.id) ? { id: optionalString(item.id) } : {}),
				filePath,
				...(positiveNumber(item.newLine) ?? positiveNumber(item.new_line) ? { newLine: positiveNumber(item.newLine) ?? positiveNumber(item.new_line) } : {}),
				...(positiveNumber(item.oldLine) ?? positiveNumber(item.old_line) ? { oldLine: positiveNumber(item.oldLine) ?? positiveNumber(item.old_line) } : {}),
				summary,
				...(optionalString(item.rationale) ? { rationale: optionalString(item.rationale) } : {}),
				...(optionalString(item.author) ? { author: optionalString(item.author) } : {}),
			};
		}).filter((comment) => comment.summary.length > 0);
	} catch {
		return [];
	}
}

export function workerChangeSetPatch(changeSet: Artifact): string | undefined {
	const marker = "\nPatch:\n";
	const idx = changeSet.body.indexOf(marker);
	if (idx < 0) return undefined;
	const patch = changeSet.body.slice(idx + marker.length).trim();
	return patch.length > 0 ? patch : undefined;
}

export async function checkHunkAvailable(options: HunkReviewOptions = {}): Promise<boolean> {
	try {
		execFileSync(hunkBin(options), ["--version"], { stdio: "ignore", timeout: 5000, env: options.env });
		return true;
	} catch {
		return false;
	}
}

export function extractHunkComments(cwd: string, options: HunkReviewOptions = {}): HunkReviewComment[] {
	try {
		const stdout = execFileSync(hunkBin(options), ["session", "comment", "list", "--repo", cwd, "--json"], {
			cwd,
			encoding: "utf8",
			timeout: 15_000,
			maxBuffer: 1024 * 1024,
			env: options.env,
		});
		return parseHunkComments(stdout);
	} catch {
		return [];
	}
}

export async function launchHunkPatch(cwd: string, patch: string, options: HunkReviewOptions = {}): Promise<HunkReviewResult> {
	if (!(await checkHunkAvailable(options))) {
		return { available: false, comments: [], message: "Hunk not found. Install with: npm i -g hunkdiff" };
	}
	try {
		await new Promise<number | null>((resolve, reject) => {
			const proc = spawn(hunkBin(options), ["patch", "-"], { cwd, stdio: ["pipe", "inherit", "inherit"], env: options.env });
			proc.stdin?.write(patch);
			proc.stdin?.end();
			proc.on("close", resolve);
			proc.on("error", reject);
		});
	} catch (err) {
		return { available: true, comments: [], message: `Hunk review failed: ${String(err)}` };
	}
	return { available: true, comments: extractHunkComments(cwd, options) };
}

export async function reviewWorkerChangeSetInHunk(worker: WorkerStatus, changeSet: Artifact, options: HunkReviewOptions = {}): Promise<HunkReviewResult> {
	const patch = workerChangeSetPatch(changeSet);
	if (!patch) return { available: true, comments: [], message: "Docket change set has no patch to review." };
	const cwd = worker.worktree?.path ?? worker.cwd;
	return launchHunkPatch(cwd, patch, options);
}

export function formatHunkCommentLocation(comment: HunkReviewComment): string {
	const line = comment.newLine ? `:${comment.newLine}` : comment.oldLine ? `:${comment.oldLine}` : "";
	const old = comment.oldLine && comment.newLine && comment.oldLine !== comment.newLine ? ` (old ${comment.oldLine})` : comment.oldLine && !comment.newLine ? " (old line)" : "";
	return `${comment.filePath}${line}${old}`;
}

export function formatHunkReviewComments(comments: HunkReviewComment[]): string {
	const header = `revise from Hunk review (${comments.length} comment${comments.length === 1 ? "" : "s"}):`;
	const lines = comments.flatMap((comment, index) => [
		`${index + 1}. ${formatHunkCommentLocation(comment)}`,
		`   ${comment.summary}`,
		...(comment.rationale ? [`   rationale: ${comment.rationale}`] : []),
	]);
	return [
		header,
		...lines,
		"",
		"Please address these comments in your worker workspace, then call docket_done with updated summary and evidence.",
	].join("\n");
}
