import { spawnSync } from "node:child_process";
import type { GitSnapshot } from "./types.js";

function runGit(cwd: string, args: string[]): string | undefined {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim();
}

export function parseGitPorcelain(output: string): Pick<GitSnapshot, "dirty" | "staged" | "unstaged" | "untracked"> {
	const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	for (const line of lines) {
		if (line.startsWith("??")) {
			untracked++;
			continue;
		}
		if (line[0] && line[0] !== " ") staged++;
		if (line[1] && line[1] !== " ") unstaged++;
	}
	return { dirty: lines.length, staged, unstaged, untracked };
}

export function readGitSnapshot(cwd: string): GitSnapshot | undefined {
	if (runGit(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") return undefined;
	const branch = runGit(cwd, ["branch", "--show-current"]);
	const head = runGit(cwd, ["rev-parse", "--short", "HEAD"]);
	const porcelain = runGit(cwd, ["status", "--porcelain"]);
	const counts = parseGitPorcelain(porcelain ?? "");
	return {
		branch: branch || undefined,
		head: head || undefined,
		...counts,
	};
}

export function gitSnapshotLabel(git: GitSnapshot | undefined): string | undefined {
	if (!git) return undefined;
	const base = git.branch || (git.head ? `@${git.head}` : undefined);
	if (!base) return undefined;
	return git.dirty && git.dirty > 0 ? `${base} ±${git.dirty}` : base;
}
