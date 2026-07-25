/**
 * Plan contract.
 *
 * A plan is not a new artifact class: it is a Worker Deliverable whose body follows
 * a small, forgiving shape. Everything here is pure so the shape can be parsed and
 * checked without a worker, a store, or a TUI. Nothing in Docket requires a body to
 * parse — an unparseable proposal stays an ordinary deliverable.
 */

export type PlanStep = {
	n: number;
	text: string;
	/** Paths the step declares through a `files:` clause. Never inferred from prose. */
	files: string[];
};

export type PlanOutline = {
	goal?: string;
	constraints: string[];
	steps: PlanStep[];
	verification: string[];
	risks: string[];
};

/** Derived comparison between an approved plan and the change set that claims to execute it. */
export type PlanCoverage = {
	planRef: string;
	steps: number;
	plannedFiles: string[];
	onPlan: string[];
	offPlan: string[];
	untouched: string[];
};

export const DEFAULT_IMPLEMENT_KIND = "implementer";

type SectionName = "goal" | "constraints" | "steps" | "verification" | "risks";

const SECTION_PATTERNS: Array<{ name: SectionName; test: RegExp }> = [
	{ name: "goal", test: /^(goals?|objectives?|intent)\b/ },
	{ name: "constraints", test: /^(constraints?|non-?goals?|out of scope)\b/ },
	{ name: "steps", test: /^(steps?|plan|implementation|approach)\b/ },
	{ name: "verification", test: /^(verification|verify|checks?|tests?|validation)\b/ },
	{ name: "risks", test: /^(risks?|open questions?|unknowns?|caveats?)\b/ },
];

const STEP_LINE = /^\s*(\d{1,3})[.)]\s+(.+)$/;
const FILES_CLAUSE = /\bfiles?\s*:\s*(.+)$/i;
const BULLET_PREFIX = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;

const MAX_STEPS = 40;
const MAX_BULLETS = 12;

/**
 * Recognizes `## Steps`, `**Steps:**`, and a bare `Steps:` label line. The bare form
 * matters because plan-mode output in the wild uses `Plan:` rather than a heading.
 * A line with content after the colon (`files: a.ts`) is never a heading.
 */
function headingText(line: string): string | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	const hashed = /^#{1,6}\s*(.+)$/.exec(trimmed);
	const candidate = hashed ? hashed[1]!.trim() : trimmed;
	const stripped = candidate.replace(/^[*_]{1,2}/, "").replace(/[*_]{1,2}$/, "").trim();
	const withoutColon = stripped.replace(/:$/, "").trim();
	if (!hashed && !stripped.endsWith(":")) return undefined;
	if (withoutColon.length === 0 || withoutColon.length > 48) return undefined;
	if (!hashed && !/^[A-Za-z][A-Za-z0-9 /&-]*$/.test(withoutColon)) return undefined;
	return withoutColon;
}

function sectionFor(heading: string): SectionName | undefined {
	const normalized = heading.toLowerCase();
	return SECTION_PATTERNS.find((entry) => entry.test.test(normalized))?.name;
}

function normalizePlanPath(raw: string): string {
	return raw
		.replace(/[`"'*]/g, "")
		.trim()
		.replace(/^\.\//, "")
		.replace(/[.,;:]+$/, "")
		.trim();
}

function filesIn(text: string): string[] {
	const match = FILES_CLAUSE.exec(text);
	if (!match) return [];
	return match[1]!.split(/[,;]/).map(normalizePlanPath).filter(Boolean);
}

function stripFilesClause(text: string): string {
	const withoutClause = text.replace(FILES_CLAUSE, "").replace(/[\s—–|-]+$/, "").trim();
	return withoutClause || text.trim();
}

function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

function parseSteps(lines: string[]): PlanStep[] {
	const steps: PlanStep[] = [];
	for (const line of lines) {
		const match = STEP_LINE.exec(line);
		if (match) {
			if (steps.length >= MAX_STEPS) break;
			const text = match[2]!.trim();
			steps.push({ n: Number(match[1]), text: stripFilesClause(text), files: filesIn(text) });
			continue;
		}
		// Continuation lines only contribute declared paths; prose stays in the body.
		const current = steps[steps.length - 1];
		if (current) current.files.push(...filesIn(line));
	}
	return steps.map((step) => ({ ...step, files: dedupe(step.files) }));
}

function bullets(lines: string[] | undefined): string[] {
	if (!lines) return [];
	return lines
		.map((line) => line.replace(BULLET_PREFIX, "").trim())
		.filter(Boolean)
		.slice(0, MAX_BULLETS);
}

/** Returns undefined unless the body declares at least one numbered step. */
export function parsePlan(body: string | undefined): PlanOutline | undefined {
	if (typeof body !== "string" || !body.trim()) return undefined;
	const sections = new Map<SectionName, string[]>();
	let current: SectionName | undefined;
	for (const line of body.split(/\r?\n/)) {
		const heading = headingText(line);
		if (heading !== undefined) {
			// An unrecognized heading closes the open section rather than absorbing into it.
			current = sectionFor(heading);
			if (current && !sections.has(current)) sections.set(current, []);
			continue;
		}
		if (current) sections.get(current)!.push(line);
	}
	const steps = parseSteps(sections.get("steps") ?? []);
	if (steps.length === 0) return undefined;
	const goal = bullets(sections.get("goal"))[0];
	return {
		...(goal ? { goal } : {}),
		constraints: bullets(sections.get("constraints")),
		steps,
		verification: bullets(sections.get("verification")),
		risks: bullets(sections.get("risks")),
	};
}

/** Tolerates a plan naming `auth.ts` for a change set reporting `src/auth.ts`. */
function samePlanPath(a: string, b: string): boolean {
	if (a === b) return true;
	return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function planCoverage(plan: PlanOutline, changedPaths: string[], planRef: string): PlanCoverage {
	const plannedFiles = dedupe(plan.steps.flatMap((step) => step.files));
	const changed = dedupe(changedPaths.map(normalizePlanPath).filter(Boolean));
	return {
		planRef,
		steps: plan.steps.length,
		plannedFiles,
		onPlan: changed.filter((path) => plannedFiles.some((entry) => samePlanPath(entry, path))),
		offPlan: changed.filter((path) => !plannedFiles.some((entry) => samePlanPath(entry, path))),
		untouched: plannedFiles.filter((entry) => !changed.some((path) => samePlanPath(entry, path))),
	};
}

export function formatPlanCoverageLine(coverage: PlanCoverage): string {
	const parts = [`plan ${coverage.planRef}`, `${coverage.steps} step${coverage.steps === 1 ? "" : "s"}`];
	if (coverage.plannedFiles.length === 0) {
		parts.push("no files named");
	} else {
		parts.push(`${coverage.onPlan.length}/${coverage.plannedFiles.length} planned file${coverage.plannedFiles.length === 1 ? "" : "s"} touched`);
		if (coverage.untouched.length > 0) parts.push(`${coverage.untouched.length} untouched`);
	}
	if (coverage.offPlan.length > 0) parts.push(`${coverage.offPlan.length} off-plan`);
	return parts.join(" · ");
}

/**
 * A deliverable worth offering the Implement handoff for: it proposes work rather than
 * carrying it. A frozen change set means the work already happened.
 */
export function isImplementableDeliverable(deliverable: { outcome?: string; body?: string; changeSet?: { patch?: string } | undefined }): boolean {
	if (deliverable.changeSet?.patch) return false;
	return deliverable.outcome === "proposal" || parsePlan(deliverable.body) !== undefined;
}

export function handoffDestinations(implementable: boolean): string[] {
	return implementable ? ["Implement", "Parent", "Worker"] : ["Parent", "Worker"];
}

/** Single-line task seed; it becomes `worker.task` and is shown in every dock row. */
export function planHandoffTaskPrefill(ref: string, outline?: PlanOutline): string {
	const goal = outline?.goal?.trim();
	return goal ? `Implement approved plan ${ref}: ${goal}` : `Implement approved plan ${ref}.`;
}
