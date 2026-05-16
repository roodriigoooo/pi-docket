import test from "node:test";
import assert from "node:assert/strict";
import { gitSnapshotLabel, parseGitPorcelain } from "../extensions/git-context.js";

test("Git context parses porcelain counts", () => {
	assert.deepEqual(parseGitPorcelain("M  src/a.ts\n M src/b.ts\n?? src/c.ts\nA  src/d.ts\n"), {
		dirty: 4,
		staged: 2,
		unstaged: 1,
		untracked: 1,
	});
});

test("Git context labels branch with dirty count", () => {
	assert.equal(gitSnapshotLabel({ branch: "main", head: "abc123", dirty: 0 }), "main");
	assert.equal(gitSnapshotLabel({ branch: "main", head: "abc123", dirty: 3 }), "main ±3");
	assert.equal(gitSnapshotLabel({ head: "abc123", dirty: 1 }), "@abc123 ±1");
	assert.equal(gitSnapshotLabel(undefined), undefined);
});
