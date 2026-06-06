import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { workerSourceLabel, workerSummaryName, type WorkerStatus } from "./background-work.js";
import type { Artifact } from "./types.js";

export type WorkerChangedFile = {
	path: string;
	additions?: number;
	deletions?: number;
};

export type WorkerChangeSet = {
	workerId: string;
	workerLabel: string;
	files: WorkerChangedFile[];
	stat: string;
	patch: string;
	hunkCount: number;
};

export type PromoteWorkerChangeSetResult =
	| { ok: true; fileCount: number; message: string }
	| { ok: false; needsConfirmation?: boolean; message: string };

function gitOutput(cwd: string, args: string[], input?: string): string | undefined {
	const result = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout;
}

function gitStatus(cwd: string, args: string[], input?: string): { status: number | null; stderr: string; error?: Error } {
	const result = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
	return { status: result.status, stderr: result.stderr.trim(), ...(result.error ? { error: result.error } : {}) };
}

function gitBuffer(cwd: string, args: string[]): Buffer | undefined {
	const result = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout;
}

function repoRoot(cwd: string): string {
	return gitOutput(cwd, ["rev-parse", "--show-toplevel"])?.trim() || cwd;
}

function stageWorkerWorkspace(worker: WorkerStatus): string | undefined {
	const workspace = worker.worktree?.path;
	if (!workspace || !fs.existsSync(workspace)) return undefined;
	gitStatus(workspace, ["add", "-A"]);
	return workspace;
}

function parseNumstat(text: string): WorkerChangedFile[] {
	return text.split(/\r?\n/).map((line) => {
		const [adds, dels, ...rest] = line.split("\t");
		const file = rest.join("\t").trim();
		if (!file) return undefined;
		const additions = adds === "-" ? undefined : Number(adds);
		const deletions = dels === "-" ? undefined : Number(dels);
		return {
			path: file,
			...(Number.isFinite(additions) ? { additions } : {}),
			...(Number.isFinite(deletions) ? { deletions } : {}),
		};
	}).filter((file): file is WorkerChangedFile => file !== undefined);
}

function changeFileLine(file: WorkerChangedFile): string {
	const stats = file.additions === undefined && file.deletions === undefined ? "binary" : `+${file.additions ?? 0}/-${file.deletions ?? 0}`;
	return `${file.path} ${stats}`;
}

export function readWorkerChangeSet(worker: WorkerStatus): WorkerChangeSet | undefined {
	const workspace = stageWorkerWorkspace(worker);
	if (!workspace) return undefined;
	const patch = gitOutput(workspace, ["diff", "--cached", "--binary", "HEAD"]);
	if (!patch?.trim()) return undefined;
	const stat = gitOutput(workspace, ["diff", "--cached", "--stat", "--compact-summary", "HEAD"])?.trimEnd() ?? "";
	const files = parseNumstat(gitOutput(workspace, ["diff", "--cached", "--numstat", "HEAD"])?.trimEnd() ?? "");
	const hunkCount = patch.match(/^@@ /gm)?.length ?? 0;
	return { workerId: worker.id, workerLabel: workerSourceLabel(worker), files, stat, patch, hunkCount };
}

export function workerChangeSetArtifact(worker: WorkerStatus): Artifact | undefined {
	const changeSet = readWorkerChangeSet(worker);
	if (!changeSet) return undefined;
	const label = workerSourceLabel(worker);
	const fileCount = changeSet.files.length;
	const fileLines = changeSet.files.slice(0, 12).map((file) => `- ${changeFileLine(file)}`);
	if (changeSet.files.length > fileLines.length) fileLines.push(`- … ${changeSet.files.length - fileLines.length} more`);
	const body = [
		`worker: ${label}`,
		`task: ${worker.task}`,
		`changes: ${fileCount} file${fileCount === 1 ? "" : "s"}`,
		"",
		"Files:",
		...fileLines,
		changeSet.stat ? "\nDiffstat:" : undefined,
		changeSet.stat || undefined,
		"\nPatch:",
		changeSet.patch,
	].filter((line): line is string => line !== undefined).join("\n");
	return {
		id: "changes",
		displayId: "changes",
		ref: `worker-changes:${worker.id}:0`,
		kind: "response",
		title: `${label} change set · ${fileCount} file${fileCount === 1 ? "" : "s"}`,
		subtitle: workerSummaryName(worker),
		body,
		timestamp: Date.parse(worker.updatedAt),
		meta: {
			workerChangeSet: true,
			workerId: worker.id,
			workerLabel: label,
			workerStatus: "ready",
			changedFiles: changeSet.files,
			diffStat: changeSet.stat,
			hunkCount: changeSet.hunkCount,
		},
	};
}

function markWorkspacePromoted(worker: WorkerStatus): void {
	const workspace = worker.worktree?.path;
	if (!workspace || !fs.existsSync(workspace)) return;
	gitStatus(workspace, ["add", "-A"]);
	const tree = gitOutput(workspace, ["write-tree"])?.trim();
	const parent = gitOutput(workspace, ["rev-parse", "HEAD"])?.trim();
	if (!tree || !parent) return;
	const commit = spawnSync("git", ["commit-tree", tree, "-p", parent, "-m", "Docket promoted worker changes"], {
		cwd: workspace,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Docket",
			GIT_AUTHOR_EMAIL: "docket@example.invalid",
			GIT_COMMITTER_NAME: "Docket",
			GIT_COMMITTER_EMAIL: "docket@example.invalid",
		},
	});
	const promotedHead = commit.status === 0 ? commit.stdout.trim() : undefined;
	if (promotedHead) gitStatus(workspace, ["reset", "--hard", promotedHead]);
}

function parentChangedSinceSnapshot(worker: WorkerStatus, parentRoot: string): boolean {
	const snapshot = worker.worktree?.snapshotHead ?? worker.worktree?.baseHead;
	if (!snapshot) return false;
	const diff = gitOutput(parentRoot, ["diff", "--name-status", snapshot, "--"])?.trim();
	if (!diff) return false;
	for (const line of diff.split(/\r?\n/)) {
		const [status, ...rest] = line.split("\t");
		const rel = rest.join("\t");
		if (status === "D" && rel) {
			const currentPath = path.join(parentRoot, rel);
			if (fs.existsSync(currentPath)) {
				const baseline = gitBuffer(parentRoot, ["show", `${snapshot}:${rel}`]);
				if (baseline && Buffer.compare(baseline, fs.readFileSync(currentPath)) === 0) continue;
			}
		}
		return true;
	}
	return false;
}

export function promoteWorkerChangeSet(worker: WorkerStatus, parentCwd: string, options: { force?: boolean } = {}): PromoteWorkerChangeSetResult {
	const changeSet = readWorkerChangeSet(worker);
	if (!changeSet) return { ok: false, message: "Worker has no change set to promote." };
	const parentRoot = repoRoot(parentCwd);
	if (!options.force && parentChangedSinceSnapshot(worker, parentRoot)) {
		return { ok: false, needsConfirmation: true, message: "Parent tree changed since this worker started. Review risk before promoting." };
	}
	const check = gitStatus(parentRoot, ["apply", "--check", "--whitespace=nowarn"], changeSet.patch);
	if (check.status !== 0) return { ok: false, message: check.stderr || "Worker change set does not apply cleanly." };
	const applied = gitStatus(parentRoot, ["apply", "--whitespace=nowarn"], changeSet.patch);
	if (applied.status !== 0) return { ok: false, message: applied.stderr || "Worker change set apply failed." };
	markWorkspacePromoted(worker);
	return { ok: true, fileCount: changeSet.files.length, message: `Promoted ${changeSet.files.length} file${changeSet.files.length === 1 ? "" : "s"} from ${workerSourceLabel(worker)}.` };
}
