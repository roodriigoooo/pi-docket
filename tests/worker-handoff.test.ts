import test from "node:test";
import assert from "node:assert/strict";
import {
	availableHandoffModels,
	createWorkerHandoffProvenance,
	handoffModelRef,
	handoffThinkingChoices,
} from "../extensions/worker-handoff.js";
import type { WorkerDeliverable } from "../extensions/worker-deliverable.js";

const deliverable: WorkerDeliverable = {
	schemaVersion: 1,
	id: "worker-deliverable:source",
	version: 2,
	ref: "worker-deliverable:source:2",
	createdAt: "2026-01-01T00:00:00.000Z",
	source: { workerId: "source", workerLabel: "w3", task: "draft plan" },
	body: "# Reviewed plan\n\nExact body",
	summary: "Reviewed plan",
	outcome: "proposal",
	evidence: [],
	recommendations: [],
	refs: [],
};

test("handoff provenance binds source version and approving decision", () => {
	assert.deepEqual(createWorkerHandoffProvenance(deliverable, { id: "decision-1", timestamp: "2026-01-01T00:02:00.000Z" }), {
		sourceDeliverableId: "worker-deliverable:source",
		sourceVersion: 2,
		sourceRef: "worker-deliverable:source:2",
		sourceWorkerId: "source",
		sourceWorkerLabel: "w3",
		approvingDecisionId: "decision-1",
		approvedAt: "2026-01-01T00:02:00.000Z",
		sidecarPath: "source-deliverable.md",
	});
});

test("handoff model choices dedupe and constrain non-reasoning models", () => {
	assert.deepEqual(availableHandoffModels([
		{ provider: "openai", id: "gpt", name: "GPT", reasoning: true },
		{ provider: "openai", id: "gpt", name: "duplicate", reasoning: true },
		{ provider: "anthropic", id: "claude", reasoning: false },
	]).map((model) => `${model.provider}/${model.id}`), ["openai/gpt", "anthropic/claude"]);
	assert.deepEqual(handoffThinkingChoices({ reasoning: false }), ["off"]);
	assert.ok(handoffThinkingChoices({ reasoning: true }).includes("high"));
	assert.ok(handoffThinkingChoices({ reasoning: true }).includes("max"));
});

test("handoff model refs stay canonical when model ids contain slashes", () => {
	assert.equal(handoffModelRef({ provider: "openai", id: "team/gpt" }), "openai/team/gpt");
});
