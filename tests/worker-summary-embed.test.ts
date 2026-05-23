import test from "node:test";
import assert from "node:assert/strict";
import { formatReadyEmbedMessage } from "../extensions/worker-summary-embed.js";
import type { WorkerStatus } from "../extensions/background-work.js";

function worker(partial: Partial<WorkerStatus> & { id: string; index: number }): WorkerStatus {
	return {
		id: partial.id,
		index: partial.index,
		tmuxSession: `trail-workers:w${partial.index}`,
		task: partial.task ?? "demo task",
		cwd: partial.cwd ?? "/repo",
		createdAt: partial.createdAt ?? "2026-05-01T00:00:00.000Z",
		updatedAt: partial.updatedAt ?? "2026-05-01T00:00:00.000Z",
		state: partial.state ?? "ready",
		...(partial.kind ? { kind: partial.kind } : {}),
		...(partial.summary ? { summary: partial.summary } : {}),
		...(partial.recommended ? { recommended: partial.recommended } : {}),
		...(partial.outcome ? { outcome: partial.outcome } : {}),
	};
}

test("returns undefined when there's no headline and no recommendations", () => {
	assert.equal(formatReadyEmbedMessage(worker({ id: "a", index: 1 })), undefined);
});

test("kind tag is suppressed for default kind", () => {
	const embed = formatReadyEmbedMessage(worker({
		id: "a", index: 1, kind: "default",
		summary: "Walked the repo and listed every exported function.",
	}));
	assert.ok(embed);
	assert.ok(embed!.content.startsWith("**w1 ready**"), embed!.content);
	assert.ok(!embed!.content.includes("·default"));
});

test("kind tag appears for non-default kinds", () => {
	const embed = formatReadyEmbedMessage(worker({
		id: "a", index: 1, kind: "scout",
		summary: "Found 12 callers across 4 files.",
	}));
	assert.ok(embed);
	assert.ok(embed!.content.startsWith("**w1·scout ready**"), embed!.content);
});

test("outcome label is appended in parentheses when present", () => {
	const embed = formatReadyEmbedMessage(worker({
		id: "a", index: 1, kind: "patcher", outcome: "completed",
		summary: "Boundary fix applied.",
	}));
	assert.ok(embed!.content.startsWith("**w1·patcher ready** (completed)"), embed!.content);
});

test("recommended bullets are emitted from worker.recommended array", () => {
	const embed = formatReadyEmbedMessage(worker({
		id: "a", index: 1, kind: "scout",
		summary: "Found 12 callers across 4 files.",
		recommended: [
			"audit src/auth.ts:42",
			"add boundary tests in tests/auth.test.ts",
			"review src/users.ts dead code",
		],
	}));
	assert.ok(embed!.content.includes("Recommended:"));
	assert.match(embed!.content, /- audit src\/auth\.ts:42/);
	assert.match(embed!.content, /- add boundary tests/);
});

test("recommended bullets parsed from a free-form summary when array is absent", () => {
	const embed = formatReadyEmbedMessage(worker({
		id: "a", index: 1, kind: "reviewer",
		summary: [
			"Diff looks safe overall.",
			"",
			"Recommended:",
			"- merge as-is",
			"- add a changelog entry",
		].join("\n"),
	}));
	assert.ok(embed!.content.includes("- merge as-is"));
	assert.ok(embed!.content.includes("- add a changelog entry"));
});

test("over five recommendations are truncated with an overflow hint", () => {
	const recs = ["a", "b", "c", "d", "e", "f", "g"];
	const embed = formatReadyEmbedMessage(worker({
		id: "a", index: 1, kind: "scout", summary: "headline.", recommended: recs,
	}));
	const lines = embed!.content.split("\n");
	const bullets = lines.filter((l) => l.startsWith("- "));
	assert.equal(bullets.length, 6); // 5 + overflow hint
	assert.match(bullets[5]!, /2 more/);
});

test("headline truncates at the recommended block", () => {
	const embed = formatReadyEmbedMessage(worker({
		id: "a", index: 1, kind: "scout",
		summary: "first line is the conclusion.\nMore detail follows.\n\nRecommended:\n- bullet one",
	}));
	const headline = embed!.content.split("\n")[1];
	assert.equal(headline, "first line is the conclusion.");
});

test("subject stays short for status-line use", () => {
	const longSummary = "a".repeat(300);
	const embed = formatReadyEmbedMessage(worker({
		id: "a", index: 1, kind: "scout", summary: longSummary,
	}));
	assert.ok(embed!.subject.length <= 80, embed!.subject);
});
