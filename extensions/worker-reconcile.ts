import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitRepoRoot } from "./worker-changes.js";
import type { WorkerChangedFile } from "./worker-deliverable.js";

/**
 * Reconciling two workers' change sets.
 *
 * `worker-overlap.ts` grades a collision and `worker-changes.ts` observes whether one patch
 * survives another. Both stop in the same place: they can tell the human that two workers hold
 * the same lines, and the only exits are to promote one and leave the other building on a base
 * that moved, or to ask one to do its work again.
 *
 * Neither is forced. Both workers branched from one base, so their two change sets over that base
 * are a three-way merge, and git computes it exactly. For most overlaps there is no decision at
 * all — the edits do not meet and both land. Where they do meet, the merge leaves conflict
 * regions, and those are the residue a human has to judge.
 *
 * The rule this module keeps: **Docket computes the mechanical part of a reconciliation and hands
 * the human the residue. It never decides one.** A merge is an observation about which lines both
 * sides changed — the same kind of fact as `git apply --check` — while the judgment stays with the
 * human who writes the resolved file, or with a worker the human explicitly hands it to.
 *
 * Everything above the adapter boundary is pure and unit-tested without git, fs, or tmux.
 */

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/** One worker's side of a reconciliation. `label` is never shown without `taskLabel`. */
export type ReconcileSide = {
	workerId: string;
	label: string;
	taskLabel: string;
	patch: string;
	/** The commit this worker branched from, when Docket recorded one. */
	base?: string;
};

export type ReconcileConflict = { path: string; regions: number };

export type ReconcileSummary = {
	/** `clean` means git merged both sides with nothing left to decide. */
	kind: "clean" | "conflicted";
	/** Every path the reconciled result changes, from both sides. */
	paths: string[];
	/** Paths git could not merge, and how many regions each left. Empty when `clean`. */
	conflicts: ReconcileConflict[];
};

/**
 * Conflict markers, matched by shape rather than by the label git wrote after them.
 *
 * `=======` is deliberately not one of them: seven equals signs is an ordinary markdown heading
 * underline, and a gate that reads it as an unresolved conflict would refuse to promote prose.
 * The three that are matched are rare enough in real content to be worth treating as structure,
 * and a file that genuinely contains them ends up relabelled — which the leftover-marker gate
 * then catches rather than promoting quietly.
 */
const CONFLICT_OURS = /^<{7}(?: .*)?$/;
const CONFLICT_BASE = /^\|{7}(?: .*)?$/;
const CONFLICT_THEIRS = /^>{7}(?: .*)?$/;

export type ConflictLabels = { ours: string; base: string; theirs: string };

/**
 * Rewrite git's marker labels into Docket's vocabulary.
 *
 * `merge-tree` labels a conflict with the commit it was handed, which here is a throwaway object
 * id — `<<<<<<< 0c78c5c4…` tells a human nothing. The roles are fixed by the marker glyph, not by
 * the label, so the rewrite is positional and needs no parsing of what git wrote. Every label
 * carries a worker *and* its task, because a bare `w3` is not a handle a human can resolve.
 */
export function relabelConflictMarkers(text: string, labels: ConflictLabels): string {
	return text.split("\n").map((line) => {
		if (CONFLICT_OURS.test(line)) return `<<<<<<< ${labels.ours}`;
		if (CONFLICT_BASE.test(line)) return `||||||| ${labels.base}`;
		if (CONFLICT_THEIRS.test(line)) return `>>>>>>> ${labels.theirs}`;
		return line;
	}).join("\n");
}

/** How many regions of a merged file are still two-sided. One `<<<<<<<` opens one region. */
export function countConflictRegions(text: string): number {
	return text.split("\n").filter((line) => CONFLICT_OURS.test(line)).length;
}

/**
 * 1-based line numbers of every marker still in a resolved file.
 *
 * This is the gate, and it is hard rather than advisory: a conflict marker applied into the
 * human's working copy is a worse outcome than any collision this whole lane exists to settle.
 */
export function unresolvedConflictLines(text: string): number[] {
	const lines: number[] = [];
	text.split("\n").forEach((line, index) => {
		if (CONFLICT_OURS.test(line) || CONFLICT_BASE.test(line) || CONFLICT_THEIRS.test(line)) lines.push(index + 1);
	});
	return lines;
}

const MERGE_TREE_STAGE = /^\d{6} [0-9a-f]{40,64} [1-3]\t(.+)$/;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

export type MergeTreeOutput = { tree?: string; conflicted: string[]; messages: string[] };

/**
 * `git merge-tree --write-tree` prints the merged tree id, then one line per conflicted index
 * stage, then a blank line and its own messages. Parsed defensively: an unrecognised shape yields
 * no tree rather than a throw, and no tree is read everywhere as "could not tell".
 */
export function parseMergeTreeOutput(stdout: string): MergeTreeOutput {
	const conflicted = new Set<string>();
	const messages: string[] = [];
	let tree: string | undefined;
	let inMessages = false;
	for (const raw of stdout.split(/\r?\n/)) {
		const line = raw.replace(/\r$/, "");
		if (inMessages) {
			if (line.trim()) messages.push(line.trim());
			continue;
		}
		if (!line.trim()) {
			if (tree) inMessages = true;
			continue;
		}
		if (!tree && OBJECT_ID.test(line.trim())) {
			tree = line.trim();
			continue;
		}
		const stage = MERGE_TREE_STAGE.exec(line);
		if (stage?.[1]) conflicted.add(unquoteGitPath(stage[1]));
		else if (tree) { inMessages = true; if (line.trim()) messages.push(line.trim()); }
	}
	return { ...(tree ? { tree } : {}), conflicted: [...conflicted].sort(), messages };
}

/**
 * git C-quotes a path with unusual bytes, escaping each byte in octal — `"src/\303\251t\303\251.ts"`
 * for `src/été.ts`. Decoded as bytes and then as UTF-8, because the escapes are per byte and a
 * multi-byte character is several of them. Anything unquoted is already the path.
 *
 * Getting this wrong would leave a conflicted file unofferable for resolution, which the leftover
 * gate would then refuse to promote — safe, but baffling.
 */
export function unquoteGitPath(value: string): string {
	if (!value.startsWith("\"") || !value.endsWith("\"") || value.length < 2) return value;
	const body = value.slice(1, -1);
	const bytes: number[] = [];
	for (let index = 0; index < body.length; index++) {
		if (body[index] !== "\\") {
			bytes.push(...Buffer.from(body[index]!, "utf8"));
			continue;
		}
		const next = body[++index];
		if (next === undefined) break;
		const octal = /[0-7]/.test(next) ? body.slice(index, index + 3) : undefined;
		if (octal && /^[0-7]{3}$/.test(octal)) {
			bytes.push(Number.parseInt(octal, 8));
			index += 2;
			continue;
		}
		const named: Record<string, number> = { n: 10, t: 9, r: 13, f: 12, b: 8, v: 11, a: 7 };
		bytes.push(named[next] ?? Buffer.from(next, "utf8")[0]!);
	}
	return Buffer.from(bytes).toString("utf8");
}

/** Paths a patch changes, in the order git wrote them. Used to describe a reconciled result. */
export function reconcileSummaryOf(paths: readonly string[], conflicts: readonly ReconcileConflict[]): ReconcileSummary {
	return {
		kind: conflicts.length > 0 ? "conflicted" : "clean",
		paths: [...paths].sort(),
		conflicts: [...conflicts].sort((a, b) => a.path.localeCompare(b.path)),
	};
}

function fileCount(count: number): string {
	return `${count} file${count === 1 ? "" : "s"}`;
}

/**
 * The picker row. It states the consequence before the human commits to it: a clean merge says
 * so, and a conflicted one says how much judgment it is asking for, so neither is a surprise
 * discovered halfway through an editor session.
 */
export function reconcileChoiceLabel(side: Pick<ReconcileSide, "label" | "taskLabel">, summary: ReconcileSummary): string {
	const who = `Combine with ${side.label} · ${side.taskLabel}`;
	if (summary.kind === "clean") return `${who} · merges clean, ${fileCount(summary.paths.length)}`;
	const regions = summary.conflicts.reduce((total, entry) => total + entry.regions, 0);
	return `${who} · ${regions} conflict${regions === 1 ? "" : "s"} to resolve in ${fileCount(summary.conflicts.length)}`;
}

/** The body of the reconcile confirmation: what lands, and what is still owed a decision. */
export function reconcileResultLines(mine: Pick<ReconcileSide, "label" | "taskLabel">, theirs: Pick<ReconcileSide, "label" | "taskLabel">, summary: ReconcileSummary): string[] {
	const lines = [
		`${mine.label} · ${mine.taskLabel}`,
		`${theirs.label} · ${theirs.taskLabel}`,
		"",
		summary.kind === "clean"
			? `git merged both change sets with nothing contested · ${fileCount(summary.paths.length)}`
			: `git merged what it could · ${fileCount(summary.conflicts.length)} left contested`,
	];
	for (const conflict of summary.conflicts) {
		lines.push(`  ${conflict.path} · ${conflict.regions} region${conflict.regions === 1 ? "" : "s"}`);
	}
	lines.push("", "Both workers' changes land together, and both are told their work is already in.");
	return lines;
}

/**
 * What to say when a merge could not be opened at all.
 *
 * Silence here would be the one dishonest degrade in this lane: the human would see the older
 * exits, assume combining was never possible for this collision, and never learn that Docket
 * tried. The reason is always specific to the peer it failed on.
 */
export function reconcileUnavailableLine(failures: readonly string[]): string | undefined {
	if (failures.length === 0) return undefined;
	return `Docket could not merge ${failures.length === 1 ? "this overlap" : "these overlaps"} · ${failures.join(" · ")}`;
}

/** The editor title a human resolves a contested file under. Names both sides, never an index. */
export function reconcileEditorTitle(filePath: string, mine: Pick<ReconcileSide, "label">, theirs: Pick<ReconcileSide, "label">): string {
	return `Resolve ${filePath} · ${mine.label} + ${theirs.label}`;
}

/**
 * The ledger row for a worker whose work landed inside someone else's promotion. Names the other
 * party by task, so `/docket log decisions` reads as a sentence rather than as two indices.
 */
export function reconcileDecisionOption(other: Pick<ReconcileSide, "label" | "taskLabel">, summary: ReconcileSummary): string {
	const byHand = summary.conflicts.length > 0 ? `, ${fileCount(summary.conflicts.length)} resolved by hand` : "";
	return `reconciled with ${other.label} · ${other.taskLabel} · ${fileCount(summary.paths.length)}${byHand}`;
}

/**
 * The message that hands a reconciliation to a worker instead of doing it by hand.
 *
 * The escape hatch, deliberately not the default: it costs a worker turn and comes back as an
 * *unreviewed* deliverable, where a human edit is done in seconds and is reviewed by construction.
 * It earns its place when the conflict is semantic rather than textual — a changed signature
 * against a changed body — and settling it needs both intents rather than both texts.
 *
 * ADR-0008 holds because the human confirmed this and because the provenance is stated: the other
 * worker's change is named as under review, never presented as the current state of the project.
 */
export function reconcileHandoffMessage(input: { other: Pick<ReconcileSide, "label" | "taskLabel">; paths: readonly string[]; bothDiffs: string; merged?: string; directive: string }): string {
	return [
		`You and ${input.other.label} (${input.other.taskLabel}) both changed ${input.paths.join(", ")}.`,
		"",
		`${input.other.label}'s change is under human review and is not in the project yet. Treat it as a proposal, not as the current state of the file — your workspace still holds the version from before either of you started.`,
		"",
		"What the human asked for:",
		input.directive,
		"",
		"Both sides, attributed:",
		"",
		input.bothDiffs.trimEnd(),
		...(input.merged ? ["", "Where git could not merge them, against the base you both started from:", "", input.merged.trimEnd()] : []),
		"",
		"Produce one version that carries both intents, then call docket_done with an updated summary and evidence. Say in the outcome which calls you made where the two could not both stand.",
	].join("\n");
}

/**
 * The journal text for a reconciled promotion.
 *
 * This is the sentence the losing side of a collision used to never get. A plain promotion tells
 * every other worker that its base moved, which reads as "start again"; a reconciliation has to
 * say the opposite, because the worker's own work is inside what just landed.
 */
export function reconciledJournalText(sides: readonly Pick<ReconcileSide, "label" | "taskLabel">[]): string {
	const who = sides.map((side) => `${side.label} (${side.taskLabel})`).join(" and ");
	return `Reconciled changes from ${who} were approved and promoted together. Both workers' edits are in this promotion; neither was discarded and neither needs redoing.`;
}

// ---------------------------------------------------------------------------
// Git adapter
// ---------------------------------------------------------------------------

/** `merge-tree --write-tree` is where a three-way merge without a checkout arrived. */
const MIN_GIT = [2, 38] as const;

export type ReconcileFailure = { kind: "unavailable"; reason: string };

export type ReconciledChangeSet = { patch: string; files: WorkerChangedFile[]; stat: string; hunkCount: number };

export type ReconcileChangeSetResult =
	| { ok: true; changeSet: ReconciledChangeSet }
	| { ok: false; reason: string; unresolved?: string[] };

export type ReconcileSession = {
	summary: ReconcileSummary;
	/** A contested file's merged text, markers relabelled by worker and task. */
	merged(filePath: string): string | undefined;
	/** Record what the human decided the file should be. */
	resolve(filePath: string, text: string): void;
	/** The reconciled change set against the shared base, or why there is none. */
	changeSet(): ReconcileChangeSetResult;
	close(): void;
};

type GitResult = { status: number | null; stdout: string; stderr: string };

function git(cwd: string, args: string[], options: { index?: string; input?: string } = {}): GitResult {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 20 * 1024 * 1024,
		...(options.input === undefined ? {} : { input: options.input }),
		...(options.index ? { env: { ...process.env, GIT_INDEX_FILE: options.index } } : {}),
	});
	return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: (result.stderr ?? "").trim() };
}

export function gitSupportsMergeTree(cwd: string): boolean {
	const raw = git(cwd, ["--version"]).stdout.match(/(\d+)\.(\d+)/);
	if (!raw) return false;
	const major = Number(raw[1]);
	const minor = Number(raw[2]);
	if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
	return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]);
}

function terminated(patch: string): string {
	return patch.endsWith("\n") ? patch : `${patch}\n`;
}

/**
 * Build the post-image tree of one side, in a scratch index.
 *
 * Applying to an index rather than a checkout is what keeps this hermetic: no worktree is
 * created, no file is written, and every object produced is unreferenced and collected by git's
 * own housekeeping. A patch that does not apply to the candidate base is how this function says
 * "that is not the base this side branched from".
 */
function sideTree(root: string, baseTree: string, patch: string, indexFile: string): string | undefined {
	try {
		fs.rmSync(indexFile, { force: true });
	} catch { /* a missing scratch index is the state we wanted */ }
	if (git(root, ["read-tree", baseTree], { index: indexFile }).status !== 0) return undefined;
	if (git(root, ["apply", "--cached", "--whitespace=nowarn"], { index: indexFile, input: terminated(patch) }).status !== 0) return undefined;
	const tree = git(root, ["write-tree"], { index: indexFile }).stdout.trim();
	return OBJECT_ID.test(tree) ? tree : undefined;
}

/**
 * The bases worth trying, most likely first.
 *
 * Docket records what each worker branched from, but two workers spawned minutes apart can hold
 * different heads. Rather than reason about ancestry, each candidate is tested by whether *both*
 * patches apply to it — a patch that applies is proof the tree is a correct pre-image for it, and
 * proof is the only thing this codebase lets a surface act on.
 */
function candidateBases(root: string, mine: ReconcileSide, theirs: ReconcileSide): string[] {
	const heads = [mine.base, theirs.base].filter((head): head is string => typeof head === "string" && head.length > 0);
	const bases = [...new Set(heads)];
	if (bases.length === 2) {
		const merged = git(root, ["merge-base", bases[0]!, bases[1]!]).stdout.trim();
		if (merged && !bases.includes(merged)) bases.push(merged);
	}
	return bases;
}

function commitTree(root: string, tree: string, parents: string[], message: string): string | undefined {
	const args = ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message];
	const result = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		input: "",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Docket",
			GIT_AUTHOR_EMAIL: "docket@example.invalid",
			GIT_COMMITTER_NAME: "Docket",
			GIT_COMMITTER_EMAIL: "docket@example.invalid",
		},
	});
	const oid = result.status === 0 ? result.stdout.trim() : "";
	return OBJECT_ID.test(oid) ? oid : undefined;
}

function parseNumstat(text: string): WorkerChangedFile[] {
	return text.split(/\r?\n/).map((line) => {
		const [adds, dels, ...rest] = line.split("\t");
		const file = unquoteGitPath(rest.join("\t").trim());
		if (!file) return undefined;
		const additions = adds === "-" ? undefined : Number(adds);
		const deletions = dels === "-" ? undefined : Number(dels);
		return {
			path: file,
			...(Number.isFinite(additions) ? { additions: additions as number } : {}),
			...(Number.isFinite(deletions) ? { deletions: deletions as number } : {}),
		};
	}).filter((file): file is WorkerChangedFile => file !== undefined);
}

/**
 * Merge two frozen change sets over the base they share.
 *
 * Returns a session rather than a result because a conflicted merge is not finished: the human
 * still writes the resolved files, and only then is there a change set to promote. A failure is
 * always a stated reason, never a silent fallback to promoting one side — "we could not combine"
 * and "they do not need combining" are different facts and no surface may conflate them.
 */
export function openReconcileSession(parentCwd: string, mine: ReconcileSide, theirs: ReconcileSide): ReconcileSession | ReconcileFailure {
	const root = gitRepoRoot(parentCwd);
	if (!gitSupportsMergeTree(root)) {
		return { kind: "unavailable", reason: "this git predates 2.38, where merging without a checkout arrived" };
	}
	const bases = candidateBases(root, mine, theirs);
	if (bases.length === 0) {
		return { kind: "unavailable", reason: "Docket did not record what these workers branched from" };
	}
	let temp: string | undefined;
	try {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "docket-reconcile-"));
		const mineIndex = path.join(temp, "mine.idx");
		const theirsIndex = path.join(temp, "theirs.idx");
		const finalIndex = path.join(temp, "final.idx");

		let resolved: { baseTree: string; mineTree: string; theirsTree: string } | undefined;
		for (const base of bases) {
			const baseTree = git(root, ["rev-parse", `${base}^{tree}`]).stdout.trim();
			if (!OBJECT_ID.test(baseTree)) continue;
			const mineTree = sideTree(root, baseTree, mine.patch, mineIndex);
			if (!mineTree) continue;
			const theirsTree = sideTree(root, baseTree, theirs.patch, theirsIndex);
			if (!theirsTree) continue;
			resolved = { baseTree, mineTree, theirsTree };
			break;
		}
		if (!resolved) {
			fs.rmSync(temp, { recursive: true, force: true });
			return { kind: "unavailable", reason: "these two change sets do not share a base Docket can reconstruct" };
		}

		const baseCommit = commitTree(root, resolved.baseTree, [], "docket reconcile base");
		const mineCommit = baseCommit ? commitTree(root, resolved.mineTree, [baseCommit], "docket reconcile ours") : undefined;
		const theirsCommit = baseCommit ? commitTree(root, resolved.theirsTree, [baseCommit], "docket reconcile theirs") : undefined;
		if (!baseCommit || !mineCommit || !theirsCommit) {
			fs.rmSync(temp, { recursive: true, force: true });
			return { kind: "unavailable", reason: "git could not stage these change sets for a merge" };
		}

		// diff3 rather than the repo's default: the human is deciding between two intents, and the
		// base is the only thing that shows which of them changed what.
		const merge = git(root, ["-c", "merge.conflictStyle=diff3", "merge-tree", "--write-tree", mineCommit, theirsCommit]);
		if (merge.status !== 0 && merge.status !== 1) {
			fs.rmSync(temp, { recursive: true, force: true });
			return { kind: "unavailable", reason: merge.stderr || "git could not merge these change sets" };
		}
		const parsed = parseMergeTreeOutput(merge.stdout);
		if (!parsed.tree) {
			fs.rmSync(temp, { recursive: true, force: true });
			return { kind: "unavailable", reason: "git reported no merged tree" };
		}
		const mergedTree = parsed.tree;

		const labels: ConflictLabels = {
			ours: `${mine.label} · ${mine.taskLabel}`,
			base: "base · what both started from",
			theirs: `${theirs.label} · ${theirs.taskLabel}`,
		};
		const mergedText = (filePath: string): string | undefined => {
			const blob = git(root, ["cat-file", "-p", `${mergedTree}:${filePath}`]);
			return blob.status === 0 ? relabelConflictMarkers(blob.stdout, labels) : undefined;
		};

		const changedPaths = parseNumstat(git(root, ["diff", "--numstat", resolved.baseTree, mergedTree]).stdout.trimEnd()).map((file) => file.path);
		const conflicts: ReconcileConflict[] = parsed.conflicted.map((filePath) => ({
			path: filePath,
			regions: countConflictRegions(mergedText(filePath) ?? ""),
		}));
		const summary = reconcileSummaryOf(changedPaths, conflicts);
		const resolvedBlobs = new Map<string, string>();
		// Modes of the contested paths as the merge left them, so a resolved file keeps the one it
		// had rather than being written back as a plain 100644.
		const fileModes = new Map<string, string>();
		for (const conflict of conflicts) {
			const listed = git(root, ["ls-tree", mergedTree, "--", conflict.path]).stdout.trim();
			const mode = /^(\d{6}) /.exec(listed)?.[1];
			if (mode) fileModes.set(conflict.path, mode);
		}

		return {
			summary,
			merged: mergedText,
			resolve(filePath: string, text: string): void {
				const hashed = git(root, ["hash-object", "-w", "--stdin"], { input: text });
				const oid = hashed.stdout.trim();
				if (hashed.status === 0 && OBJECT_ID.test(oid)) resolvedBlobs.set(filePath, oid);
			},
			changeSet(): ReconcileChangeSetResult {
				try {
					fs.rmSync(finalIndex, { force: true });
				} catch { /* a missing scratch index is the state we wanted */ }
				if (git(root, ["read-tree", mergedTree], { index: finalIndex }).status !== 0) {
					return { ok: false, reason: "git could not read the merged result" };
				}
				for (const [filePath, oid] of resolvedBlobs) {
					// The mode comes from the merged tree, never from a default: resolving a
					// conflict in a shell script must not quietly un-execute it. `--add` because a
					// path the human resolved into existence may not be in that tree at all.
					const mode = fileModes.get(filePath) ?? "100644";
					git(root, ["update-index", "--add", "--cacheinfo", `${mode},${oid},${filePath}`], { index: finalIndex });
				}
				const finalTree = git(root, ["write-tree"], { index: finalIndex }).stdout.trim();
				if (!OBJECT_ID.test(finalTree)) return { ok: false, reason: "git could not write the reconciled result" };

				// The gate. Every contested path is re-read from what is actually about to be
				// promoted, not from what the human was handed, so a file closed without saving
				// fails here rather than landing markers in the working copy.
				const unresolved = summary.conflicts
					.map((conflict) => conflict.path)
					.filter((filePath) => {
						const blob = git(root, ["cat-file", "-p", `${finalTree}:${filePath}`]);
						return blob.status !== 0 || unresolvedConflictLines(blob.stdout).length > 0;
					});
				if (unresolved.length > 0) return { ok: false, reason: "conflict markers are still in the reconciled files", unresolved };

				const patch = git(root, ["diff", "--binary", resolved!.baseTree, finalTree]).stdout;
				if (!patch.trim()) return { ok: false, reason: "the reconciled result changes nothing" };
				const files = parseNumstat(git(root, ["diff", "--numstat", resolved!.baseTree, finalTree]).stdout.trimEnd());
				const stat = git(root, ["diff", "--stat", "--compact-summary", resolved!.baseTree, finalTree]).stdout.trimEnd();
				return { ok: true, changeSet: { patch, files, stat, hunkCount: patch.match(/^@@ /gm)?.length ?? 0 } };
			},
			close(): void {
				if (temp) fs.rmSync(temp, { recursive: true, force: true });
			},
		};
	} catch (err) {
		if (temp) fs.rmSync(temp, { recursive: true, force: true });
		return { kind: "unavailable", reason: `git could not merge these change sets: ${String(err)}` };
	}
}

export function isReconcileFailure(value: ReconcileSession | ReconcileFailure): value is ReconcileFailure {
	return "kind" in value && value.kind === "unavailable";
}
