import test from "node:test";
import assert from "node:assert/strict";
import type { WorkerStatus } from "../extensions/background-work.js";
import type { Artifact } from "../extensions/types.js";
import type { WorkerDeliverable } from "../extensions/worker-deliverable.js";
import {
	displayWorkerSummary,
	formatWorkerReportText,
	projectWorkerReport,
	verdictReadyPreview,
} from "../extensions/worker-report.js";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "worker-1",
		index: 1,
		tmuxSession: "docket-workers:w1",
		task: "map auth call sites",
		cwd: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:05:00.000Z",
		state: "ready",
		...partial,
	};
}

function changeSet(files: Array<{ path: string; additions: number; deletions: number }>): Artifact {
	return {
		id: "changes",
		displayId: "changes",
		ref: "worker-changes:worker-1:0",
		kind: "response",
		title: "w1 change set",
		subtitle: "",
		body: "diff omitted",
		timestamp: 1,
		meta: { workerChangeSet: true, workerId: "worker-1", changedFiles: files, hunkCount: files.length },
	};
}

test("projectWorkerReport keeps full multiline summary without Recommended block", () => {
	const report = projectWorkerReport(worker({
		summary: "Line one finds callers.\nLine two details risk.\n\nRecommended:\n- skip this",
		recommended: ["audit src/auth.ts", "add boundary tests"],
	}));
	assert.equal(report.summary, "Line one finds callers.\nLine two details risk.");
	assert.deepEqual(report.recommendations, ["audit src/auth.ts", "add boundary tests"]);
	assert.doesNotMatch(report.summary, /Recommended/);
});

test("projectWorkerReport separates structured recommendations from summary", () => {
	const report = projectWorkerReport(worker({
		summary: "Limiter landed.",
		recommended: ["promote", "watch flaky suite"],
		evidence: ["src/auth.ts:12", "tests/auth.test.ts"],
	}));
	assert.equal(report.summary, "Limiter landed.");
	assert.deepEqual(report.recommendations, ["promote", "watch flaky suite"]);
	assert.deepEqual(report.evidence, ["src/auth.ts:12", "tests/auth.test.ts"]);
});

test("displayWorkerSummary normalizes legacy combined summaries without duplicating recommendations", () => {
	const legacy = worker({
		summary: "Safe overall.\n\nRecommended:\n- merge as-is\n- add changelog",
	});
	assert.equal(displayWorkerSummary(legacy), "Safe overall.");
	const report = projectWorkerReport(legacy);
	assert.equal(report.summary, "Safe overall.");
	assert.deepEqual(report.recommendations, ["merge as-is", "add changelog"]);
	const text = formatWorkerReportText(report);
	assert.equal((text.match(/merge as-is/g) ?? []).length, 1);
});

test("projectWorkerReport includes change totals, evidence, command statuses, and caps", () => {
	const files = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.ts`, additions: i, deletions: 1 }));
	const commands: Artifact[] = Array.from({ length: 10 }, (_, i) => ({
		id: `c${i}`,
		displayId: `c${i}`,
		ref: `command:${i}`,
		kind: "command" as const,
		title: `cmd ${i}`,
		subtitle: i % 3 === 0 ? "failed · cwd /repo" : i % 3 === 1 ? "ok · cwd /repo" : "unknown",
		body: "",
		timestamp: 100 - i,
		meta: i % 3 === 0 ? { exitCode: 1 } : i % 3 === 1 ? { exitCode: 0 } : {},
	}));
	const response: Artifact = { id: "r1", displayId: "r1", ref: "response:1", kind: "response", title: "answer", subtitle: "", body: "body", timestamp: 2 };
	const report = projectWorkerReport(
		worker({
			summary: "Patched auth.",
			evidence: ["a", "b", "c", "d"],
			outcome: "completed",
			scopeConfidence: "clear",
			kind: "patcher",
		}),
		[response, ...commands],
		changeSet(files),
	);

	assert.equal(report.changeTotals.files, 7);
	assert.equal(report.changeTotals.additions, 21);
	assert.equal(report.changeTotals.deletions, 7);
	assert.equal(report.recentCommands.length, 8);
	assert.equal(report.commandsOverflow, 2);
	assert.equal(report.checks.total, 10);
	assert.ok(report.checks.ok > 0);
	assert.ok(report.checks.failed > 0);
	assert.equal(report.refs[0]?.ref, "worker-changes:worker-1:0");
	assert.ok(report.refs.some((ref) => ref.displayId === "w1.r1"));
	const text = formatWorkerReportText(report);
	assert.match(text, /Kind: patcher/);
	assert.match(text, /Scope confidence: clear/);
	assert.match(text, /Patched auth\./);
	assert.doesNotMatch(text, /body/); // no transcript/output bodies
	assert.doesNotMatch(text, /cmd output/);
});

test("report reads full immutable deliverable body and handoff provenance", () => {
	const deliverable: WorkerDeliverable = {
		schemaVersion: 1,
		id: "worker-deliverable:worker-1",
		version: 2,
		ref: "worker-deliverable:worker-1:2",
		createdAt: "2026-01-01T00:06:00.000Z",
		source: { workerId: "worker-1", workerLabel: "w1", task: "map auth call sites" },
		body: "# Reviewed implementation\n\nExact result body",
		summary: "Reviewed implementation",
		outcome: "proposal",
		evidence: ["src/auth.ts"],
		recommendations: ["implement plan"],
		refs: [],
		sourceHandoff: {
			sourceDeliverableId: "worker-deliverable:planner",
			sourceVersion: 1,
			sourceRef: "worker-deliverable:planner:1",
			sourceWorkerId: "planner",
			sourceWorkerLabel: "w2",
			approvingDecisionId: "decision-1",
			approvedAt: "2026-01-01T00:05:00.000Z",
			sidecarPath: "source-deliverable.md",
		},
	};
	const report = projectWorkerReport(worker({ summary: "mutable summary" }), [], undefined, deliverable);
	const text = formatWorkerReportText(report);

	assert.equal(report.summary, deliverable.body);
	assert.match(text, /Deliverable: worker-deliverable:worker-1:2 \(v2\)/);
	assert.match(text, /Handoff source: worker-deliverable:planner:1/);
	assert.match(text, /Exact result body/);
});

test("projectWorkerReport falls back to edited file artifacts when change set is missing", () => {
	const edited: Artifact = {
		id: "f1",
		displayId: "f1",
		ref: "file:1",
		kind: "file",
		title: "src/auth.ts",
		subtitle: "",
		body: "",
		timestamp: 1,
		meta: { tool: "edit", path: "src/auth.ts" },
	};
	const report = projectWorkerReport(worker({ summary: "touched auth" }), [edited], undefined);
	assert.equal(report.changeTotals.files, 1);
	assert.equal(report.changedFiles[0]?.path, "src/auth.ts");
});

test("verdictReadyPreview caps evidence and recommendations with overflow hints", () => {
	const files = Array.from({ length: 8 }, (_, i) => ({ path: `p${i}.ts`, additions: 1, deletions: 0 }));
	const report = projectWorkerReport(
		worker({
			summary: "headline claim",
			evidence: ["e1", "e2", "e3", "e4"],
			recommended: ["r1", "r2", "r3"],
		}),
		[],
		changeSet(files),
	);
	const preview = verdictReadyPreview(report);
	assert.equal(preview.evidence.fileLines.length, 5);
	assert.equal(preview.evidence.filesOverflow, 3);
	assert.equal(preview.evidence.evidenceLines.length, 3);
	assert.equal(preview.evidence.evidenceOverflow, 1);
	assert.equal(preview.workerSays.recommendations.length, 2);
	assert.equal(preview.workerSays.recommendationsOverflow, 1);
	assert.equal(preview.workerSays.headline, "headline claim");
});

test("formatWorkerReportText deduplicates refs and omits event telemetry", () => {
	const change = changeSet([{ path: "a.ts", additions: 1, deletions: 0 }]);
	const dup: Artifact = { ...change, id: "dup", displayId: "dup" };
	const report = projectWorkerReport(worker({ summary: "done" }), [dup], change);
	const text = formatWorkerReportText(report);
	assert.equal((text.match(/worker-changes:worker-1:0/g) ?? []).length, 0); // refs use @displayId
	assert.equal((text.match(/@w1\.changes/g) ?? []).length, 1);
	assert.doesNotMatch(text, /events\.ndjson|structured event/i);
});
