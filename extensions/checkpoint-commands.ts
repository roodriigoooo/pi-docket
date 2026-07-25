import type { CheckpointStore } from "./checkpoint-store.js";
import type { CheckpointIndexEntry } from "./types.js";

type NotifyLevel = "info" | "warning" | "error";

type CheckpointCommandsDeps = {
	store: CheckpointStore;
	notify(text: string, level: NotifyLevel): void;
	emitText(text: string, kind: "list", heading: string): void;
	confirmDelete(checkpoint: CheckpointIndexEntry): Promise<boolean>;
};

export type CheckpointCommands = {
	delete(idOrLast?: string): Promise<boolean>;
	list(includeConsumed?: boolean): Promise<void>;
};

export function createCheckpointCommands(deps: CheckpointCommandsDeps): CheckpointCommands {
	const deleteCheckpoint = async (idOrLast: string): Promise<boolean> => {
		const checkpoint = await deps.store.find(idOrLast || "last", { includeConsumed: true });
		if (!checkpoint) {
			deps.notify("Docket legacy bundle not found", "error");
			return false;
		}
		if (!(await deps.confirmDelete(checkpoint))) {
			deps.notify("Docket delete cancelled", "info");
			return false;
		}
		await deps.store.purge(checkpoint);
		deps.notify(`Docket legacy bundle deleted: ${checkpoint.id}`, "info");
		return true;
	};

	return {
		async delete(idOrLast?: string): Promise<boolean> {
			return deleteCheckpoint(idOrLast ?? "last");
		},
		async list(includeConsumed = false): Promise<void> {
			const index = await deps.store.list({ includeConsumed });
			const lines = index.length
				? index.map((c) => {
					const tag = `${c.mode}${c.consumeOnUse ? ":once" : ""}${c.consumedAt ? ":consumed" : ""}`;
					return `${c.id}\t${tag}\t${c.cwd}\t${c.note ?? ""}`;
				}).join("\n")
				: "No Docket legacy bundles";
			deps.emitText(lines, "list", "docket · legacy bundles");
		},
	};
}
