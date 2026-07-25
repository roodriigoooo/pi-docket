import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_IMPLEMENT_KIND,
	formatPlanCoverageLine,
	handoffDestinations,
	isImplementableDeliverable,
	parsePlan,
	planCoverage,
	planHandoffTaskPrefill,
} from "../extensions/plan-contract.js";

const PLAN = [
	"## Goal",
	"Make worker handoffs carry an approved plan.",
	"",
	"## Constraints",
	"- Do not add a new artifact class.",
	"",
	"## Steps",
	"1. Add the plan contract — files: extensions/plan-contract.ts",
	"2. Discharge the gate on approved handoffs — files: `extensions/background-work.ts`, extensions/worker-store.ts",
	"3. Document the flow.",
	"",
	"## Verification",
	"- npm run check",
	"- npm test",
	"",
	"## Risks",
	"- Plan bodies in the wild may not follow the shape.",
].join("\n");

test("plan contract parses sections, numbered steps, and declared files", () => {
	const plan = parsePlan(PLAN);
	assert.ok(plan);
	assert.equal(plan.goal, "Make worker handoffs carry an approved plan.");
	assert.deepEqual(plan.constraints, ["Do not add a new artifact class."]);
	assert.equal(plan.steps.length, 3);
	assert.equal(plan.steps[0]!.n, 1);
	assert.equal(plan.steps[0]!.text, "Add the plan contract");
	assert.deepEqual(plan.steps[0]!.files, ["extensions/plan-contract.ts"]);
	// Backticks and multiple comma-separated paths both normalize.
	assert.deepEqual(plan.steps[1]!.files, ["extensions/background-work.ts", "extensions/worker-store.ts"]);
	assert.deepEqual(plan.steps[2]!.files, []);
	assert.deepEqual(plan.verification, ["npm run check", "npm test"]);
	assert.equal(plan.risks.length, 1);
});

test("plan contract accepts bare label lines used by plan-mode output", () => {
	const plan = parsePlan(["Goal:", "Ship it.", "", "**Plan:**", "1. First move — files: a.ts", "2. Second move"].join("\n"));
	assert.ok(plan);
	assert.equal(plan.goal, "Ship it.");
	assert.equal(plan.steps.length, 2);
	assert.deepEqual(plan.steps[0]!.files, ["a.ts"]);
});

test("plan contract collects a files clause from a step continuation line", () => {
	const plan = parsePlan(["## Steps", "1. Rework the store", "   - files: extensions/worker-store.ts"].join("\n"));
	assert.deepEqual(plan?.steps[0]?.files, ["extensions/worker-store.ts"]);
});

test("plan contract requires numbered steps", () => {
	assert.equal(parsePlan(undefined), undefined);
	assert.equal(parsePlan(""), undefined);
	assert.equal(parsePlan("Some prose about what we might do, with no plan in it."), undefined);
	// A files: line alone is content, never a section heading.
	assert.equal(parsePlan(["## Steps", "files: a.ts"].join("\n")), undefined);
});

test("plan contract ignores content under an unrecognized heading", () => {
	const plan = parsePlan(["## Steps", "1. Real step", "## Appendix", "2. Not a step"].join("\n"));
	assert.equal(plan?.steps.length, 1);
});

test("plan coverage separates on-plan, off-plan, and untouched files", () => {
	const plan = parsePlan(PLAN)!;
	const coverage = planCoverage(plan, ["extensions/plan-contract.ts", "extensions/worker-store.ts", "README.md"], "worker-deliverable:w1:2");
	assert.equal(coverage.steps, 3);
	assert.deepEqual(coverage.plannedFiles, ["extensions/plan-contract.ts", "extensions/background-work.ts", "extensions/worker-store.ts"]);
	assert.deepEqual(coverage.onPlan, ["extensions/plan-contract.ts", "extensions/worker-store.ts"]);
	assert.deepEqual(coverage.offPlan, ["README.md"]);
	assert.deepEqual(coverage.untouched, ["extensions/background-work.ts"]);
});

test("plan coverage tolerates a plan naming a bare filename", () => {
	const plan = parsePlan(["## Steps", "1. Fix auth — files: auth.ts"].join("\n"))!;
	const coverage = planCoverage(plan, ["src/auth.ts"], "deliverable:1:1");
	assert.deepEqual(coverage.onPlan, ["src/auth.ts"]);
	assert.deepEqual(coverage.untouched, []);
});

test("plan coverage line reports drift and clean execution differently", () => {
	const plan = parsePlan(PLAN)!;
	const drifted = planCoverage(plan, ["extensions/plan-contract.ts", "README.md"], "d:1");
	assert.equal(formatPlanCoverageLine(drifted), "plan d:1 · 3 steps · 1/3 planned files touched · 2 untouched · 1 off-plan");
	const clean = planCoverage(plan, ["extensions/plan-contract.ts", "extensions/background-work.ts", "extensions/worker-store.ts"], "d:1");
	assert.equal(formatPlanCoverageLine(clean), "plan d:1 · 3 steps · 3/3 planned files touched");
	const noFiles = planCoverage(parsePlan(["## Steps", "1. Think hard"].join("\n"))!, ["a.ts"], "d:2");
	assert.equal(formatPlanCoverageLine(noFiles), "plan d:2 · 1 step · no files named · 1 off-plan");
});

test("Implement is offered for plans and proposals, never for a frozen change set", () => {
	assert.equal(isImplementableDeliverable({ outcome: "findings", body: PLAN }), true);
	assert.equal(isImplementableDeliverable({ outcome: "proposal", body: "no steps here" }), true);
	assert.equal(isImplementableDeliverable({ outcome: "findings", body: "no steps here" }), false);
	assert.equal(isImplementableDeliverable({ outcome: "proposal", body: PLAN, changeSet: { patch: "diff --git a b" } }), false);
	assert.deepEqual(handoffDestinations(true), ["Implement", "Parent", "Worker"]);
	assert.deepEqual(handoffDestinations(false), ["Parent", "Worker"]);
});

test("Implement seeds a single-line task from the plan goal", () => {
	assert.equal(
		planHandoffTaskPrefill("worker-deliverable:w1:2", parsePlan(PLAN)),
		"Implement approved plan worker-deliverable:w1:2: Make worker handoffs carry an approved plan.",
	);
	assert.equal(planHandoffTaskPrefill("d:1", undefined), "Implement approved plan d:1.");
	assert.equal(DEFAULT_IMPLEMENT_KIND, "implementer");
});
