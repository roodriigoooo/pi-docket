import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkerStatus } from "./background-work.js";
import type { WorkerDeliverable } from "./worker-deliverable.js";
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
type RawHunkSession = Record<string, unknown>;

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

function rawSessionArray(parsed: unknown): RawHunkSession[] {
	if (Array.isArray(parsed)) return parsed.filter((item): item is RawHunkSession => item !== null && typeof item === "object");
	if (parsed && typeof parsed === "object" && Array.isArray((parsed as { sessions?: unknown }).sessions)) {
		return (parsed as { sessions: unknown[] }).sessions.filter((item): item is RawHunkSession => item !== null && typeof item === "object");
	}
	return [];
}

function normalizedPath(value: string): string {
	return resolve(value);
}

function rangeStart(value: unknown): number | undefined {
	return Array.isArray(value) ? positiveNumber(value[0]) : undefined;
}

export function parseHunkSessionId(rawJson: string, cwd: string): string | undefined {
	try {
		const sessions = rawSessionArray(JSON.parse(rawJson) as unknown);
		const wanted = normalizedPath(cwd);
		const exact = sessions.find((session) => {
			const cwdValue = optionalString(session.cwd);
			const repoRoot = optionalString(session.repoRoot);
			return (cwdValue && normalizedPath(cwdValue) === wanted) || (repoRoot && normalizedPath(repoRoot) === wanted);
		});
		const session = exact ?? (sessions.length === 1 ? sessions[0] : undefined);
		return session ? optionalString(session.sessionId) : undefined;
	} catch {
		return undefined;
	}
}

export function parseHunkComments(rawJson: string): HunkReviewComment[] {
	try {
		const parsed = JSON.parse(rawJson) as unknown;
		return rawCommentArray(parsed).map((item) => {
			const filePath = optionalString(item.filePath) ?? optionalString(item.file_path) ?? optionalString(item.file) ?? "unknown";
			const summary = optionalString(item.summary) ?? optionalString(item.comment) ?? optionalString(item.body) ?? optionalString(item.title) ?? "";
			const id = optionalString(item.id) ?? optionalString(item.commentId) ?? optionalString(item.noteId);
			const newLine = positiveNumber(item.newLine) ?? positiveNumber(item.new_line) ?? rangeStart(item.newRange) ?? rangeStart(item.new_range);
			const oldLine = positiveNumber(item.oldLine) ?? positiveNumber(item.old_line) ?? rangeStart(item.oldRange) ?? rangeStart(item.old_range);
			return {
				...(id ? { id } : {}),
				filePath,
				...(newLine ? { newLine } : {}),
				...(oldLine ? { oldLine } : {}),
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
	const frozen = changeSet.meta?.patch;
	if (typeof frozen === "string" && frozen.trim()) return frozen;
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

function findHunkSessionId(cwd: string, options: HunkReviewOptions = {}): string | undefined {
	try {
		const stdout = execFileSync(hunkBin(options), ["session", "list", "--json"], {
			cwd,
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 1024 * 1024,
			env: options.env,
		});
		return parseHunkSessionId(stdout, cwd);
	} catch {
		return undefined;
	}
}

function readHunkComments(cwd: string, options: HunkReviewOptions = {}, sessionId?: string): HunkReviewComment[] | undefined {
	const target = sessionId ? [sessionId] : ["--repo", cwd];
	try {
		const stdout = execFileSync(hunkBin(options), ["session", "comment", "list", ...target, "--type", "user", "--json"], {
			cwd,
			encoding: "utf8",
			timeout: 15_000,
			maxBuffer: 1024 * 1024,
			env: options.env,
		});
		return parseHunkComments(stdout);
	} catch {
		return undefined;
	}
}

export function extractHunkComments(cwd: string, options: HunkReviewOptions = {}, sessionId?: string): HunkReviewComment[] {
	return readHunkComments(cwd, options, sessionId) ?? [];
}

export async function launchHunkPatch(cwd: string, patch: string, options: HunkReviewOptions = {}): Promise<HunkReviewResult> {
	if (!(await checkHunkAvailable(options))) {
		return { available: false, comments: [], message: "Hunk not found. Install with: npm i -g hunkdiff" };
	}
	let tempDir: string | undefined;
	let sessionId: string | undefined;
	let comments: HunkReviewComment[] = [];
	try {
		tempDir = await mkdtemp(join(tmpdir(), "docket-hunk-"));
		const patchPath = join(tempDir, "worker.patch");
		await writeFile(patchPath, patch, "utf8");
		// Keep stdin attached to terminal so Hunk can receive navigation/comment keys.
		await new Promise<number | null>((resolve, reject) => {
			const proc = spawn(hunkBin(options), ["patch", patchPath], { cwd, stdio: "inherit", env: options.env });
			const harvest = () => {
				sessionId ??= findHunkSessionId(cwd, options);
				if (!sessionId) return;
				const next = readHunkComments(cwd, options, sessionId);
				if (next) comments = next;
			};
			const timer = setInterval(harvest, 250);
			const initialTimer = setTimeout(harvest, 100);
			timer.unref?.();
			initialTimer.unref?.();
			proc.on("close", (code) => {
				clearInterval(timer);
				clearTimeout(initialTimer);
				harvest();
				resolve(code);
			});
			proc.on("error", (err) => {
				clearInterval(timer);
				clearTimeout(initialTimer);
				reject(err);
			});
		});
	} catch (err) {
		return { available: true, comments: [], message: `Hunk review failed: ${String(err)}` };
	} finally {
		if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
	return { available: true, comments };
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

export function formatHunkReviewComments(comments: HunkReviewComment[], deliverable?: Pick<WorkerDeliverable, "ref" | "version">): string {
	const source = deliverable ? `Request revision for ${deliverable.ref} (version ${deliverable.version}):` : undefined;
	const header = `revise from Hunk review (${comments.length} comment${comments.length === 1 ? "" : "s"}):`;
	const lines = comments.flatMap((comment, index) => [
		`${index + 1}. ${formatHunkCommentLocation(comment)}`,
		`   ${comment.summary}`,
		...(comment.rationale ? [`   rationale: ${comment.rationale}`] : []),
	]);
	return [
		source,
		header,
		...lines,
		"",
		"Please address these comments in your worker workspace, then call docket_done with updated summary and evidence.",
	].filter((line): line is string => line !== undefined).join("\n");
}
