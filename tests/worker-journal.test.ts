import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkerStatus } from "../extensions/background-work.js";
import {
	appendJournalEntry,
	deriveStaleBase,
	journalFile,
	journalViewFile,
	parseJournal,
	promotionJournalEntry,
	readJournalEntries,
	reconciledPromotionJournalEntry,
	renderJournal,
	staleBaseLine,
	staleBaseVerdictLine,
	type JournalEntry,
} from "../extensions/worker-journal.js";

const STARTED = "2026-01-01T10:00:00.000Z";

function worker(partial: Partial<WorkerStatus> = {}): WorkerStatus {
	return {
		id: "w2-abcd",
		index: 2,
		tmuxSession: "docket-workers",
		task: "add a per-tenant rate limit to src/api/limit.ts",
		cwd: "/tmp/orchard",
		createdAt: STARTED,
		updatedAt: "2026-01-01T11:00:00.000Z",
		state: "active",
		...partial,
	};
}

function promoted(partial: Partial<JournalEntry> = {}): JournalEntry {
	return {
		at: "2026-01-01T10:30:00.000Z",
		kind: "promoted",
		from: "w1",
		text: "w1's changes were approved and promoted into the project.",
		paths: ["src/auth/middleware.ts"],
		workerId: "w1-zzzz",
		...partial,
	};
}

test("a promotion propagates as an entry, without being addressed to anyone", () => {
	const entry = promotionJournalEntry({
		worker: worker({ id: "w1-zzzz", index: 1, task: "give authenticate() a context arg" }),
		paths: ["src/auth/middleware.ts", "tests/auth.test.ts"],
		ref: "d3",
		summary: "authenticate() now takes a context argument",
	});

	assert.equal(entry.kind, "promoted");
	assert.deepEqual(entry.paths, ["src/auth/middleware.ts", "tests/auth.test.ts"]);
	assert.equal(entry.ref, "d3");
	// The source worker is recorded so its own promotion never makes its own base look stale.
	assert.equal(entry.workerId, "w1-zzzz");
});

test("a reconciled promotion credits every worker inside it, and still reads to an old Docket", () => {
	const entry = reconciledPromotionJournalEntry({
		workers: [
			worker({ id: "w3-yyyy", index: 3, task: "give authenticate() a context arg" }),
			worker({ id: "w2-abcd", index: 2 }),
		],
		paths: ["src/api/limit.ts"],
		text: "Reconciled changes from w3 and w2 were approved and promoted together.",
		ref: "d4",
	});

	assert.equal(entry.kind, "promoted");
	assert.equal(entry.from, "w3 + w2");
	assert.deepEqual(entry.workerIds, ["w3-yyyy", "w2-abcd"]);
	// `workerId` is written alongside rather than dropped, so an entry appended today still reads
	// correctly to a Docket that predates reconciliation.
	assert.equal(entry.workerId, "w3-yyyy");
	// A round trip through the ndjson keeps every contributor.
	assert.deepEqual(parseJournal(`${JSON.stringify(entry)}\n`)[0]?.workerIds, ["w3-yyyy", "w2-abcd"]);
});

test("a worker whose evidence names a promoted path is working from a base that moved", () => {
	const w = worker();
	const stale = deriveStaleBase({
		worker: w,
		candidate: { worker: w, touchedPaths: ["src/auth/middleware.ts", "src/api/limit.ts"] },
		entries: [promoted()],
	});

	assert.ok(stale);
	assert.deepEqual(stale!.paths, ["src/auth/middleware.ts"]);
	assert.equal(stale!.entries, 1);
	assert.match(staleBaseLine(stale!), /^base moved · 1 file it works on landed since it started$/);
});

test("an approved plan is evidence too, even before the worker has touched anything", () => {
	const w = worker();
	const stale = deriveStaleBase({
		worker: w,
		candidate: { worker: w, plannedPaths: ["src/auth/middleware.ts"] },
		entries: [promoted()],
	});

	assert.ok(stale);
});

test("staleness stays silent on everything that is not evidence of overlap", () => {
	const w = worker();
	const candidate = { worker: w, touchedPaths: ["docs/deploy.md"] };

	// No overlap at all.
	assert.equal(deriveStaleBase({ worker: w, candidate, entries: [promoted()] }), undefined);
	// Task-text overlap alone scores `maybe`, which is a fine reason to propose a recipient to a
	// human and a poor reason to tell a worker its ground has shifted.
	assert.equal(deriveStaleBase({
		worker: w,
		candidate,
		entries: [promoted({ paths: [], text: "we changed the rate limit tenant story" })],
	}), undefined);
	// A promotion older than the worker is part of the base it started from.
	assert.equal(deriveStaleBase({
		worker: w,
		candidate: { worker: w, touchedPaths: ["src/auth/middleware.ts"] },
		entries: [promoted({ at: "2026-01-01T09:00:00.000Z" })],
	}), undefined);
	// A worker's own promotion is the source, not a surprise.
	assert.equal(deriveStaleBase({
		worker: w,
		candidate: { worker: w, touchedPaths: ["src/auth/middleware.ts"] },
		entries: [promoted({ workerId: w.id })],
	}), undefined);
	// So is a promotion this worker's work was reconciled into: its edits are what landed, and
	// telling it its base moved would read as "start again" about work that is already in.
	assert.equal(deriveStaleBase({
		worker: w,
		candidate: { worker: w, touchedPaths: ["src/auth/middleware.ts"] },
		entries: [promoted({ workerId: "w1-zzzz", workerIds: ["w1-zzzz", w.id] })],
	}), undefined);
	// Standing notes are not landed code.
	assert.equal(deriveStaleBase({
		worker: w,
		candidate: { worker: w, touchedPaths: ["src/auth/middleware.ts"] },
		entries: [promoted({ kind: "standing" })],
	}), undefined);
});

test("a finished worker's deliverable still carries the fact, because approving it is the decision", () => {
	// `ready` is not a broadcast recipient — it can no longer act — but the human is about to
	// apply its diff against a base that has since moved.
	const w = worker({ state: "ready", summary: "rate limit added" });
	const stale = deriveStaleBase({
		worker: w,
		candidate: { worker: w, touchedPaths: ["src/auth/middleware.ts"] },
		entries: [promoted()],
	});

	assert.ok(stale);
	assert.match(staleBaseVerdictLine(stale!), /^produced before src\/auth\/middleware\.ts landed · re-check before promoting$/);
});

test("several promotions collapse into one fact", () => {
	const w = worker();
	const stale = deriveStaleBase({
		worker: w,
		candidate: { worker: w, touchedPaths: ["src/auth/middleware.ts", "src/api/limit.ts"] },
		entries: [
			promoted({ at: "2026-01-01T10:30:00.000Z", paths: ["src/auth/middleware.ts"] }),
			promoted({ at: "2026-01-01T10:45:00.000Z", paths: ["src/api/limit.ts"], workerId: "w3-yyyy" }),
		],
	});

	assert.equal(stale!.entries, 2);
	assert.deepEqual(stale!.paths.sort(), ["src/api/limit.ts", "src/auth/middleware.ts"]);
	assert.equal(stale!.since, "2026-01-01T10:30:00.000Z");
});

test("the worker-facing view says the workspace does not contain the change", () => {
	const rendered = renderJournal([promoted()]);

	assert.match(rendered, /# Docket project journal/);
	assert.match(rendered, /promoted from w1 · 1 file/);
	assert.match(rendered, /Files now changed on the project's base: src\/auth\/middleware\.ts/);
	// Without this the worker re-reads its own isolated copy, sees the old bytes, and concludes
	// nothing happened.
	assert.match(rendered, /Your workspace still holds the version from before this landed/);
	// A standing note is not a landed change and must not borrow that language.
	assert.doesNotMatch(renderJournal([promoted({ kind: "standing", paths: [] })]), /still holds the version/);
});

test("the view is generated and never read back as truth", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "docket-journal-"));
	try {
		await appendJournalEntry(root, "orchard", promoted());
		await appendJournalEntry(root, "orchard", { at: "2026-01-01T11:00:00.000Z", kind: "standing", from: "you", text: "two-space indentation" });

		const source = await readFile(journalFile(root, "orchard"), "utf8");
		assert.equal(parseJournal(source).length, 2);

		const view = await readFile(journalViewFile(root, "orchard"), "utf8");
		assert.match(view, /This file is generated\. Editing it changes nothing\./);
		// Newest first, so a worker skimming hits current constraints before historical ones.
		assert.ok(view.indexOf("two-space indentation") < view.indexOf("promoted from w1"));

		// Hand-editing the view survives exactly one append, because it is regenerated in full.
		await writeFile(journalViewFile(root, "orchard"), "nonsense", "utf8");
		await appendJournalEntry(root, "orchard", { at: "2026-01-01T12:00:00.000Z", kind: "standing", from: "you", text: "third" });
		const regenerated = await readFile(journalViewFile(root, "orchard"), "utf8");
		assert.doesNotMatch(regenerated, /nonsense/);
		assert.equal((await readJournalEntries(root, "orchard")).length, 3);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an existing bulletin migrates instead of looking thrown away", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "docket-journal-"));
	try {
		// A legacy bulletin, written before the journal existed.
		await mkdir(path.dirname(journalViewFile(root, "orchard")), { recursive: true });
		await writeFile(journalViewFile(root, "orchard"), "# Docket bulletin\n\n## 2026-01-01T09:00:00.000Z · from you\n\nno force pushes\n", "utf8");

		const migrated = await readJournalEntries(root, "orchard");
		assert.equal(migrated.length, 1);
		assert.equal(migrated[0]!.kind, "standing");
		assert.equal(migrated[0]!.text, "no force pushes");

		// And it survives the first append rather than being replaced by it.
		await appendJournalEntry(root, "orchard", promoted());
		const entries = await readJournalEntries(root, "orchard");
		assert.deepEqual(entries.map((entry) => entry.kind), ["promoted", "standing"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the journal is bounded, oldest first out", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "docket-journal-"));
	try {
		for (let i = 0; i < 130; i++) {
			await appendJournalEntry(root, "orchard", {
				at: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 60_000).toISOString(),
				kind: "standing",
				from: "you",
				text: `note ${i}`,
			});
		}
		const entries = await readJournalEntries(root, "orchard");

		assert.equal(entries.length, 120);
		// Newest kept, oldest dropped: an entry that aged out is also the least likely to bind.
		assert.equal(entries[0]!.text, "note 129");
		assert.ok(!entries.some((entry) => entry.text === "note 0"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a half-written line reads as fewer entries, never as a throw", () => {
	const entries = parseJournal(`${JSON.stringify(promoted())}\n{"at":"broken`);
	assert.equal(entries.length, 1);
	assert.equal(parseJournal("").length, 0);
});
