import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isReconcileFailure, openReconcileSession, type ReconcileSession, type ReconcileSide } from "../extensions/worker-reconcile.js";

/**
 * The adapter half of reconciliation, against a real repository.
 *
 * The pure half is covered without git in `worker-reconcile.test.ts`. What this file exists to
 * prove is the claim the whole lane rests on: two change sets over one base are a three-way merge,
 * git computes it exactly, and what comes back applies to the human's working copy.
 */

function git(cwd: string, args: string[], input?: string): string {
	const result = spawnSync("git", args, { cwd, input, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	return result.stdout.trim();
}

const BASE_FILE = [
	"import { authenticate } from \"../auth/middleware.js\";",
	"",
	"export function limitFor(token: string): number {",
	"\tconst context = authenticate(token);",
	"\treturn context.scopes.includes(\"write\") ? 1000 : 100;",
	"}",
	"",
].join("\n");

async function makeRepo(): Promise<{ root: string; head: string; patchFor: (contents: Record<string, string>) => Promise<string>; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "docket-reconcile-"));
	git(root, ["init"]);
	git(root, ["config", "user.name", "Test"]);
	git(root, ["config", "user.email", "test@example.invalid"]);
	await writeFile(path.join(root, "limit.ts"), BASE_FILE, "utf8");
	await writeFile(path.join(root, "notes.md"), "notes\n", "utf8");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-m", "initial"]);
	const head = git(root, ["rev-parse", "HEAD"]);
	return {
		root,
		head,
		// A patch is captured the way a worker freezes one: edit, diff against the base, revert.
		patchFor: async (contents) => {
			for (const [file, body] of Object.entries(contents)) await writeFile(path.join(root, file), body, "utf8");
			const patch = spawnSync("git", ["diff", "--binary", "HEAD"], { cwd: root, encoding: "utf8" }).stdout;
			git(root, ["checkout", "--", "."]);
			return patch;
		},
		cleanup: async () => { await rm(root, { recursive: true, force: true }); },
	};
}

function side(partial: Partial<ReconcileSide> & { workerId: string; label: string; patch: string }): ReconcileSide {
	return { taskLabel: `${partial.label}'s task`, ...partial };
}

function opened(value: ReconcileSession | { kind: "unavailable"; reason: string }): ReconcileSession {
	assert.equal(isReconcileFailure(value), false, isReconcileFailure(value) ? value.reason : "");
	return value as ReconcileSession;
}

test("two change sets that do not meet merge clean, and the result carries both", async () => {
	const repo = await makeRepo();
	try {
		const mine = await repo.patchFor({ "limit.ts": BASE_FILE.replace("import { authenticate }", "import { authenticate, type AuthContext }") });
		const theirs = await repo.patchFor({ "notes.md": "notes\nrate limits are per tenant\n" });

		const session = opened(openReconcileSession(repo.root, side({ workerId: "w2", label: "w2", patch: mine, base: repo.head }), side({ workerId: "w3", label: "w3", patch: theirs, base: repo.head })));
		try {
			assert.equal(session.summary.kind, "clean");
			assert.deepEqual(session.summary.conflicts, []);
			assert.deepEqual(session.summary.paths, ["limit.ts", "notes.md"]);

			const built = session.changeSet();
			assert.ok(built.ok);
			// Both sides are in one patch, and it applies to the human's working copy.
			assert.match(built.changeSet!.patch, /type AuthContext/);
			assert.match(built.changeSet!.patch, /rate limits are per tenant/);
			assert.equal(spawnSync("git", ["apply", "--check", "--whitespace=nowarn"], { cwd: repo.root, input: built.changeSet!.patch, encoding: "utf8" }).status, 0);
			assert.deepEqual(built.changeSet!.files.map((file) => file.path).sort(), ["limit.ts", "notes.md"]);
		} finally {
			session.close();
		}
	} finally {
		await repo.cleanup();
	}
});

test("edits that meet leave the human a labelled residue, and the resolved file promotes", async () => {
	const repo = await makeRepo();
	try {
		// The collision from the demo: one side changes the body, the other the signature.
		const mine = await repo.patchFor({
			"limit.ts": BASE_FILE.replace(
				"\treturn context.scopes.includes(\"write\") ? 1000 : 100;",
				"\tconst tenantLimit = tenantLimits.get(context.tenantId) ?? 100;\n\treturn Math.min(context.scopes.includes(\"write\") ? 1000 : 100, tenantLimit);",
			),
		});
		const theirs = await repo.patchFor({
			"limit.ts": BASE_FILE
				.replace("export function limitFor(token: string): number {", "export function limitFor(token: string, context: AuthContext): number {")
				.replace("\tconst context = authenticate(token);", "\tconst authenticated = authenticate(token, context);")
				.replace("context.scopes", "authenticated.scopes"),
		});

		const mineSide = side({ workerId: "w2", label: "w2", taskLabel: "add a per-tenant rate limit", patch: mine, base: repo.head });
		const theirSide = side({ workerId: "w3", label: "w3", taskLabel: "give authenticate() an AuthContext", patch: theirs, base: repo.head });
		const session = opened(openReconcileSession(repo.root, mineSide, theirSide));
		try {
			assert.equal(session.summary.kind, "conflicted");
			assert.deepEqual(session.summary.conflicts.map((conflict) => conflict.path), ["limit.ts"]);

			const residue = session.merged("limit.ts");
			assert.ok(residue);
			// Every marker names a worker and its task, and diff3 shows what both started from.
			assert.match(residue!, /<<<<<<< w2 · add a per-tenant rate limit/);
			assert.match(residue!, /\|\|\|\|\|\|\| base · what both started from/);
			assert.match(residue!, />>>>>>> w3 · give authenticate\(\) an AuthContext/);

			// The gate: a file handed back with its markers intact never reaches the working copy.
			session.resolve("limit.ts", residue!);
			const refused = session.changeSet();
			assert.equal(refused.ok, false);
			assert.deepEqual(refused.ok === false ? refused.unresolved : undefined, ["limit.ts"]);

			session.resolve("limit.ts", "export function limitFor(token: string, context: AuthContext): number {\n\treturn 100;\n}\n");
			const built = session.changeSet();
			assert.ok(built.ok);
			assert.equal(spawnSync("git", ["apply", "--check", "--whitespace=nowarn"], { cwd: repo.root, input: built.changeSet!.patch, encoding: "utf8" }).status, 0);
		} finally {
			session.close();
		}
	} finally {
		await repo.cleanup();
	}
});

test("resolving a conflict keeps the file's mode", async () => {
	const repo = await makeRepo();
	try {
		// On disk as well as in the index: a patch captured against a file git thinks is 755 while
		// the worktree says 644 carries a mode change of its own, which is not what is under test.
		await chmod(path.join(repo.root, "limit.ts"), 0o755);
		git(repo.root, ["add", "-A"]);
		git(repo.root, ["commit", "-m", "make it executable"]);
		const head = git(repo.root, ["rev-parse", "HEAD"]);
		const mine = await repo.patchFor({ "limit.ts": BASE_FILE.replace("\treturn context", "\t// mine\n\treturn context") });
		const theirs = await repo.patchFor({ "limit.ts": BASE_FILE.replace("\treturn context", "\t// theirs\n\treturn context") });

		const session = opened(openReconcileSession(repo.root, side({ workerId: "w2", label: "w2", patch: mine, base: head }), side({ workerId: "w3", label: "w3", patch: theirs, base: head })));
		try {
			assert.equal(session.summary.kind, "conflicted");
			session.resolve("limit.ts", BASE_FILE.replace("\treturn context", "\t// both\n\treturn context"));
			const built = session.changeSet();
			assert.ok(built.ok);
			// Resolving a conflict in a script must not quietly un-execute it.
			assert.equal(built.changeSet!.patch.includes("100644"), false, built.changeSet!.patch);
		} finally {
			session.close();
		}
	} finally {
		await repo.cleanup();
	}
});

test("a side whose patch does not fit the recorded base is a stated reason, never a silent promotion", async () => {
	const repo = await makeRepo();
	try {
		const mine = await repo.patchFor({ "limit.ts": `${BASE_FILE}// tail\n` });
		// A patch against text that is not in this repository at all.
		const theirs = [
			"diff --git a/limit.ts b/limit.ts",
			"--- a/limit.ts",
			"+++ b/limit.ts",
			"@@ -1,1 +1,1 @@",
			"-something that was never here",
			"+something else",
			"",
		].join("\n");

		const result = openReconcileSession(repo.root, side({ workerId: "w2", label: "w2", patch: mine, base: repo.head }), side({ workerId: "w3", label: "w3", patch: theirs, base: repo.head }));

		assert.equal(isReconcileFailure(result), true);
		assert.match(isReconcileFailure(result) ? result.reason : "", /do not share a base/);
	} finally {
		await repo.cleanup();
	}
});

test("reconciling touches nothing: no worktree, no index, no working-copy write", async () => {
	const repo = await makeRepo();
	try {
		const mine = await repo.patchFor({ "limit.ts": `${BASE_FILE}// mine\n` });
		const theirs = await repo.patchFor({ "notes.md": "notes\ntheirs\n" });
		const before = git(repo.root, ["status", "--porcelain"]);

		const session = opened(openReconcileSession(repo.root, side({ workerId: "w2", label: "w2", patch: mine, base: repo.head }), side({ workerId: "w3", label: "w3", patch: theirs, base: repo.head })));
		session.changeSet();
		session.close();

		// Merging is an observation. Nothing lands until a promotion applies the patch.
		assert.equal(git(repo.root, ["status", "--porcelain"]), before);
		assert.equal(git(repo.root, ["rev-parse", "HEAD"]), repo.head);
	} finally {
		await repo.cleanup();
	}
});
