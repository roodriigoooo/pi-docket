import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { workerSourceLabel, workerSummaryName, type WorkerStatus } from "./background-work.js";
import type { Artifact } from "./types.js";
import type { WorkerDeliverable, WorkerDeliverableChangeSet, WorkerChangedFile } from "./worker-deliverable.js";

export type { WorkerChangedFile } from "./worker-deliverable.js";

export type WorkerChangeSet = {
	workerId: string;
	workerLabel: string;
	ref: string;
	files: WorkerChangedFile[];
	stat: string;
	patch: string;
	hunkCount: number;
	deliverableId?: string;
	deliverableVersion?: number;
	deliverableRef?: string;
};

export type PromoteWorkerChangeSetResult =
	| { ok: true; fileCount: number; message: string }
	| { ok: false; needsConfirmation?: boolean; message: string };

function gitOutput(cwd: string, args: string[], input?: string): string | undefined {
	const result = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout;
}

function requiredGitOutput(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
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

function stageWorkerWorkspace(worker: WorkerStatus, strict = false): string | undefined {
	const workspace = worker.worktree?.path;
	if (!workspace) return undefined;
	if (!fs.existsSync(workspace)) {
		if (strict) throw new Error(`Worker workspace missing: ${workspace}`);
		return undefined;
	}
	const staged = gitStatus(workspace, ["add", "-A"]);
	if (staged.error || staged.status !== 0) {
		if (strict) throw staged.error ?? new Error(`git add -A failed: ${staged.stderr || `exit ${staged.status}`}`);
		return undefined;
	}
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

export function workerChangeSetRef(workerId: string, version = 0): string {
	return `worker-changes:${workerId}:${version}`;
}

/** Capture the staged workspace once. Call only while publishing a deliverable. */
export function readWorkerChangeSet(worker: WorkerStatus, options: { version?: number; strict?: boolean } = {}): WorkerChangeSet | undefined {
	const workspace = stageWorkerWorkspace(worker, options.strict);
	if (!workspace) return undefined;
	const read = options.strict ? (args: string[]) => requiredGitOutput(workspace, args) : (args: string[]) => gitOutput(workspace, args);
	const patch = read(["diff", "--cached", "--binary", "HEAD"]);
	if (!patch?.trim()) return undefined;
	const stat = read(["diff", "--cached", "--stat", "--compact-summary", "HEAD"])?.trimEnd() ?? "";
	const files = parseNumstat(read(["diff", "--cached", "--numstat", "HEAD"])?.trimEnd() ?? "");
	const hunkCount = patch.match(/^@@ /gm)?.length ?? 0;
	return {
		workerId: worker.id,
		workerLabel: workerSourceLabel(worker),
		ref: workerChangeSetRef(worker.id, options.version ?? 0),
		files,
		stat,
		patch,
		hunkCount,
	};
}

export function freezeWorkerChangeSet(worker: WorkerStatus, version: number): WorkerDeliverableChangeSet | undefined {
	const changeSet = readWorkerChangeSet(worker, { version, strict: true });
	if (!changeSet) return undefined;
	return { ref: changeSet.ref, files: changeSet.files, stat: changeSet.stat, patch: changeSet.patch, hunkCount: changeSet.hunkCount };
}

export function workerChangeSetFromDeliverable(deliverable: WorkerDeliverable | undefined): WorkerChangeSet | undefined {
	if (!deliverable?.changeSet) return undefined;
	return {
		workerId: deliverable.source.workerId,
		workerLabel: deliverable.source.workerLabel,
		ref: deliverable.changeSet.ref,
		files: deliverable.changeSet.files,
		stat: deliverable.changeSet.stat,
		patch: deliverable.changeSet.patch,
		hunkCount: deliverable.changeSet.hunkCount,
		deliverableId: deliverable.id,
		deliverableVersion: deliverable.version,
		deliverableRef: deliverable.ref,
	};
}

function changeSetBody(worker: Pick<WorkerStatus, "task">, changeSet: WorkerChangeSet): string {
	const fileCount = changeSet.files.length;
	const fileLines = changeSet.files.slice(0, 12).map((file) => `- ${changeFileLine(file)}`);
	if (changeSet.files.length > fileLines.length) fileLines.push(`- … ${changeSet.files.length - fileLines.length} more`);
	return [
		`worker: ${changeSet.workerLabel}`,
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
}

/**
 * Adapt a frozen deliverable change set. Without a deliverable this preserves the
 * legacy live-workspace behavior for old workers only.
 */
export function workerChangeSetArtifact(worker: WorkerStatus, deliverable?: WorkerDeliverable): Artifact | undefined {
	const changeSet = deliverable ? workerChangeSetFromDeliverable(deliverable) : readWorkerChangeSet(worker);
	if (!changeSet) return undefined;
	const fileCount = changeSet.files.length;
	return {
		id: "changes",
		displayId: "changes",
		ref: changeSet.ref,
		kind: "response",
		title: `${changeSet.workerLabel} change set · ${fileCount} file${fileCount === 1 ? "" : "s"}`,
		subtitle: workerSummaryName(worker),
		body: changeSetBody(worker, changeSet),
		timestamp: deliverable ? Date.parse(deliverable.createdAt) : Date.parse(worker.updatedAt),
		meta: {
			workerChangeSet: true,
			workerId: changeSet.workerId,
			workerLabel: changeSet.workerLabel,
			workerStatus: "ready",
			changedFiles: changeSet.files,
			diffStat: changeSet.stat,
			hunkCount: changeSet.hunkCount,
			patch: changeSet.patch,
			...(changeSet.deliverableId ? {
				deliverableId: changeSet.deliverableId,
				deliverableVersion: changeSet.deliverableVersion,
				deliverableRef: changeSet.deliverableRef,
			} : {}),
		},
	};
}

export function workerChangeSetFromArtifact(artifact: Artifact): WorkerChangeSet | undefined {
	if (artifact.meta?.workerChangeSet !== true) return undefined;
	const workerId = typeof artifact.meta.workerId === "string" ? artifact.meta.workerId : undefined;
	const workerLabel = typeof artifact.meta.workerLabel === "string" ? artifact.meta.workerLabel : undefined;
	const patch = typeof artifact.meta.patch === "string" ? artifact.meta.patch : patchFromBody(artifact.body);
	if (!workerId || !workerLabel || !patch?.trim()) return undefined;
	const rawFiles = artifact.meta.changedFiles;
	const files = Array.isArray(rawFiles) ? rawFiles.map((entry) => {
		if (!entry || typeof entry !== "object") return undefined;
		const file = entry as { path?: unknown; additions?: unknown; deletions?: unknown };
		if (typeof file.path !== "string" || !file.path) return undefined;
		return {
			path: file.path,
			...(typeof file.additions === "number" ? { additions: file.additions } : {}),
			...(typeof file.deletions === "number" ? { deletions: file.deletions } : {}),
		};
	}).filter((file): file is WorkerChangedFile => file !== undefined) : [];
	return {
		workerId,
		workerLabel,
		ref: typeof artifact.meta.changeSetRef === "string" ? artifact.meta.changeSetRef : artifact.ref,
		files,
		stat: typeof artifact.meta.diffStat === "string" ? artifact.meta.diffStat : "",
		patch,
		hunkCount: typeof artifact.meta.hunkCount === "number" ? artifact.meta.hunkCount : patch.match(/^@@ /gm)?.length ?? 0,
		...(typeof artifact.meta.deliverableId === "string" ? { deliverableId: artifact.meta.deliverableId } : {}),
		...(typeof artifact.meta.deliverableVersion === "number" ? { deliverableVersion: artifact.meta.deliverableVersion } : {}),
		...(typeof artifact.meta.deliverableRef === "string" ? { deliverableRef: artifact.meta.deliverableRef } : {}),
	};
}

function patchFromBody(body: string): string | undefined {
	const marker = "\nPatch:\n";
	const idx = body.indexOf(marker);
	if (idx < 0) return undefined;
	const patch = body.slice(idx + marker.length).trim();
	return patch || undefined;
}

function liveWorkspacePatch(worker: WorkerStatus): string | undefined {
	const workspace = stageWorkerWorkspace(worker);
	return workspace ? gitOutput(workspace, ["diff", "--cached", "--binary", "HEAD"]) : undefined;
}

/** Commit/reset only the exact frozen generation. Newer worker edits stay untouched. */
function markWorkspacePromoted(worker: WorkerStatus, frozenPatch: string): void {
	const workspace = worker.worktree?.path;
	if (!workspace || !fs.existsSync(workspace)) return;
	const livePatch = liveWorkspacePatch(worker);
	if (livePatch !== frozenPatch) return;
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

function parentChangedSinceSnapshot(worker: WorkerStatus, parentRoot: string, files: WorkerChangedFile[]): boolean {
	const snapshot = worker.worktree?.snapshotHead ?? worker.worktree?.baseHead;
	if (!snapshot) return false;
	const paths = files.map((file) => file.path).filter(Boolean);
	const diff = gitOutput(parentRoot, ["diff", "--name-status", snapshot, "--", ...(paths.length ? paths : ["."])])?.trim();
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

function asFrozenChangeSet(value: WorkerChangeSet | WorkerDeliverableChangeSet | Artifact | undefined, worker: WorkerStatus): WorkerChangeSet | undefined {
	if (!value) return undefined;
	if ("kind" in value) return workerChangeSetFromArtifact(value);
	if ("workerId" in value) return value;
	return {
		workerId: worker.id,
		workerLabel: workerSourceLabel(worker),
		ref: value.ref,
		files: value.files,
		stat: value.stat,
		patch: value.patch,
		hunkCount: value.hunkCount,
	};
}

/**
 * Promotion always applies supplied frozen patch. Omit `changeSet` only for a
 * legacy worker that predates deliverables.
 */
export function promoteWorkerChangeSet(
	worker: WorkerStatus,
	parentCwd: string,
	options: { force?: boolean; changeSet?: WorkerChangeSet | WorkerDeliverableChangeSet | Artifact } = {},
): PromoteWorkerChangeSetResult {
	const changeSet = asFrozenChangeSet(options.changeSet, worker) ?? readWorkerChangeSet(worker);
	if (!changeSet) return { ok: false, message: "Worker has no change set to promote." };
	const parentRoot = repoRoot(parentCwd);
	if (!options.force && parentChangedSinceSnapshot(worker, parentRoot, changeSet.files)) {
		return { ok: false, needsConfirmation: true, message: "Parent changed files in this reviewed patch since worker start. Review risk before promoting." };
	}
	const check = gitStatus(parentRoot, ["apply", "--check", "--whitespace=nowarn"], changeSet.patch);
	if (check.status !== 0) return { ok: false, message: check.stderr || "Worker change set does not apply cleanly." };
	const applied = gitStatus(parentRoot, ["apply", "--whitespace=nowarn"], changeSet.patch);
	if (applied.status !== 0) return { ok: false, message: applied.stderr || "Worker change set apply failed." };
	markWorkspacePromoted(worker, changeSet.patch);
	return { ok: true, fileCount: changeSet.files.length, message: `Promoted ${changeSet.files.length} file${changeSet.files.length === 1 ? "" : "s"} from ${workerSourceLabel(worker)}.` };
}
