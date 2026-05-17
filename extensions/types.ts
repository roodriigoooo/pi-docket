export type ArtifactKind = "command" | "error" | "file" | "code" | "prompt" | "response" | "checkpoint";
export type CheckpointMode = "handoff" | "compact" | "debug" | "review";

export type GitSnapshot = {
	branch?: string;
	head?: string;
	dirty?: number;
	staged?: number;
	unstaged?: number;
	untracked?: number;
};

export type Artifact = {
	id: string; // displayId alias, kept for command compatibility
	displayId: string;
	ref: string;
	kind: ArtifactKind;
	title: string;
	subtitle: string;
	body: string;
	entryId?: string;
	timestamp?: number;
	meta?: Record<string, unknown>;
	source?: string; // undefined = current session; otherwise carryover slot id (e.g. "c1")
};

export type ArtifactSummary = Pick<Artifact, "displayId" | "ref" | "kind" | "title" | "subtitle" | "timestamp">;

export type CheckpointIndexEntry = {
	id: string;
	mode: CheckpointMode;
	file: string;
	createdAt: string;
	cwd: string;
	sourceSession?: string;
	note?: string;
	consumeOnUse?: boolean;
	consumedAt?: string;
	git?: GitSnapshot;
};
