import type { CheckpointStore, CheckpointSummary } from "./checkpoint-store.js";
import type { CheckpointIndexEntry } from "./types.js";

export type ResumeAction = "continue" | "preview" | "edit" | "delete" | "load";
export type ResumeMode = "resume" | "delete" | "load";
export type ResumeSelection = { action: ResumeAction; summary: CheckpointSummary; index: number } | null;

type NotifyLevel = "info" | "warning" | "error";

type CheckpointCommandsDeps = {
	store: CheckpointStore;
	hasUI: boolean;
	notify(text: string, level: NotifyLevel): void;
	emitText(text: string, kind: "list", heading: string): void;
	confirmDelete(checkpoint: CheckpointIndexEntry): Promise<boolean>;
	selectCheckpoint(summaries: CheckpointSummary[], selected: number, mode?: ResumeMode): Promise<ResumeSelection>;
	showText(title: string, text: string): Promise<void>;
	editText(title: string, text: string): Promise<string | undefined>;
	startSession(checkpoint: CheckpointIndexEntry, content: string): Promise<void>;
};

export type CheckpointCommands = {
	continue(idOrLast?: string): Promise<void>;
	delete(idOrLast?: string): Promise<boolean>;
	list(includeConsumed?: boolean): Promise<void>;
};

export function createCheckpointCommands(deps: CheckpointCommandsDeps): CheckpointCommands {
	const deleteCheckpoint = async (idOrLast: string): Promise<boolean> => {
		const checkpoint = await deps.store.find(idOrLast || "last", { includeConsumed: true });
		if (!checkpoint) {
			deps.notify("Docket checkpoint not found", "error");
			return false;
		}
		if (!(await deps.confirmDelete(checkpoint))) {
			deps.notify("Docket delete cancelled", "info");
			return false;
		}
		await deps.store.purge(checkpoint);
		deps.notify(`Docket checkpoint deleted: ${checkpoint.id}`, "info");
		return true;
	};

	const continueCheckpoint = async (idOrLast: string): Promise<void> => {
		const checkpoint = await deps.store.find(idOrLast || "last");
		if (!checkpoint) {
			deps.notify("Docket checkpoint not found", "error");
			return;
		}
		await deps.startSession(checkpoint, await deps.store.readMarkdown(checkpoint));
	};

	const selectCheckpointToContinue = async (): Promise<void> => {
		if (!deps.hasUI) {
			await continueCheckpoint("last");
			return;
		}
		let summaries = await deps.store.listSummaries();
		if (summaries.length === 0) {
			deps.notify("Docket checkpoint not found", "error");
			return;
		}
		let selected = Math.max(0, summaries.length - 1);
		while (true) {
			const result = await deps.selectCheckpoint(summaries, selected);
			if (!result) return;
			selected = result.index;
			const checkpoint = result.summary.entry;
			if (result.action === "delete") {
				if (!(await deps.confirmDelete(checkpoint))) continue;
				await deps.store.purge(checkpoint);
				deps.notify(`Docket checkpoint deleted: ${checkpoint.id}`, "info");
				summaries = await deps.store.listSummaries();
				if (summaries.length === 0) return;
				selected = Math.min(selected, summaries.length - 1);
				continue;
			}
			const markdown = await deps.store.readMarkdown(checkpoint);
			if (result.action === "preview") {
				await deps.showText(`Docket checkpoint ${checkpoint.id}`, markdown);
				continue;
			}
			if (result.action === "edit") {
				const edited = await deps.editText("Edit Docket checkpoint", markdown);
				if (edited === undefined) {
					deps.notify("Docket continue cancelled", "info");
					return;
				}
				await deps.startSession(checkpoint, edited);
				return;
			}
			await deps.startSession(checkpoint, markdown);
			return;
		}
	};

	const selectCheckpointToDelete = async (): Promise<void> => {
		if (!deps.hasUI) {
			await deleteCheckpoint("last");
			return;
		}
		let summaries = await deps.store.listSummaries({ includeConsumed: true });
		if (summaries.length === 0) {
			deps.notify("Docket checkpoint not found", "error");
			return;
		}
		let selected = Math.max(0, summaries.length - 1);
		while (true) {
			const result = await deps.selectCheckpoint(summaries, selected, "delete");
			if (!result) return;
			selected = result.index;
			const checkpoint = result.summary.entry;
			if (result.action === "preview") {
				await deps.showText(`Docket checkpoint ${checkpoint.id}`, await deps.store.readMarkdown(checkpoint));
				continue;
			}
			if (!(await deps.confirmDelete(checkpoint))) continue;
			await deps.store.purge(checkpoint);
			deps.notify(`Docket checkpoint deleted: ${checkpoint.id}`, "info");
			summaries = await deps.store.listSummaries({ includeConsumed: true });
			if (summaries.length === 0) return;
			selected = Math.min(selected, summaries.length - 1);
		}
	};

	return {
		async continue(idOrLast?: string): Promise<void> {
			if (idOrLast) await continueCheckpoint(idOrLast);
			else await selectCheckpointToContinue();
		},
		async delete(idOrLast?: string): Promise<boolean> {
			if (idOrLast) return deleteCheckpoint(idOrLast);
			await selectCheckpointToDelete();
			return true;
		},
		async list(includeConsumed = false): Promise<void> {
			const index = await deps.store.list({ includeConsumed });
			const lines = index.length
				? index.map((c) => {
					const tag = `${c.mode}${c.consumeOnUse ? ":once" : ""}${c.consumedAt ? ":consumed" : ""}`;
					return `${c.id}\t${tag}\t${c.cwd}\t${c.note ?? ""}`;
				}).join("\n")
				: "No Docket checkpoints";
			deps.emitText(lines, "list", "docket · checkpoints");
		},
	};
}
