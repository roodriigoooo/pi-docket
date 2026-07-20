export type KeyHintSlot = "card" | "footer" | "help";

export type KeyBinding<Action extends string> = {
	keys: string | readonly string[];
	action: Action;
	label: string;
	slots?: readonly KeyHintSlot[];
};

export type KeyHint<Action extends string> = {
	keys: string[];
	action: Action;
	label: string;
};

export type DocketKeymap<Action extends string> = {
	name: string;
	resolve(input: string): Action | undefined;
	hints(slot: KeyHintSlot): KeyHint<Action>[];
};

const KEY_ALIASES: Record<string, string> = {
	"\u001b": "escape",
	escape: "escape",
	esc: "escape",
	"\u0003": "ctrl+c",
	"ctrl+c": "ctrl+c",
	"\r": "enter",
	"\n": "enter",
	enter: "enter",
	"\t": "tab",
	tab: "tab",
	" ": "space",
	space: "space",
	"\u001b[A": "up",
	arrowup: "up",
	up: "up",
	"\u001b[B": "down",
	arrowdown: "down",
	down: "down",
	"\u001b[5~": "pageup",
	pgup: "pageup",
	pageup: "pageup",
	"\u001b[6~": "pagedown",
	pgdn: "pagedown",
	pagedown: "pagedown",
	"\u001b[H": "home",
	home: "home",
	"\u001b[F": "end",
	end: "end",
	"\u001b[D": "left",
	arrowleft: "left",
	left: "left",
	"\u001b[C": "right",
	arrowright: "right",
	right: "right",
	"\u0006": "ctrl+f",
	"ctrl+f": "ctrl+f",
	"\u0015": "ctrl+u",
	"ctrl+u": "ctrl+u",
	"\u0004": "ctrl+d",
	"ctrl+d": "ctrl+d",
};

export function normalizeDocketKey(input: string): string {
	const alias = KEY_ALIASES[input.toLowerCase()];
	if (alias) return alias;
	if (input.length === 1 && input !== " ") return input;
	return input.toLowerCase();
}

function displayKey(key: string): string {
	const normalized = normalizeDocketKey(key);
	if (normalized === "escape") return "Esc";
	if (normalized === "ctrl+c") return "Ctrl+C";
	if (normalized === "ctrl+d") return "Ctrl+D";
	if (normalized === "ctrl+f") return "Ctrl+F";
	if (normalized === "ctrl+u") return "Ctrl+U";
	if (normalized === "space") return "Space";
	if (normalized === "enter") return "Enter";
	if (normalized === "tab") return "Tab";
	if (normalized === "pageup") return "PgUp";
	if (normalized === "pagedown") return "PgDn";
	return key;
}

export function defineKeymap<Action extends string>(name: string, bindings: readonly KeyBinding<Action>[]): DocketKeymap<Action> {
	const actions = new Map<string, Action>();
	const hints = new Map<KeyHintSlot, KeyHint<Action>[]>();
	for (const binding of bindings) {
		const keys = (typeof binding.keys === "string" ? [binding.keys] : [...binding.keys]).map(normalizeDocketKey);
		for (const key of keys) {
			const prior = actions.get(key);
			if (prior && prior !== binding.action) throw new Error(`Docket keymap "${name}" assigns "${key}" to both "${prior}" and "${binding.action}"`);
			actions.set(key, binding.action);
		}
		for (const slot of binding.slots ?? []) {
			const entries = hints.get(slot) ?? [];
			entries.push({ keys: keys.map(displayKey), action: binding.action, label: binding.label });
			hints.set(slot, entries);
		}
	}
	return {
		name,
		resolve(input: string): Action | undefined {
			return actions.get(normalizeDocketKey(input));
		},
		hints(slot: KeyHintSlot): KeyHint<Action>[] {
			return hints.get(slot) ?? [];
		},
	};
}

export function formatKeyHints<Action extends string>(keymap: DocketKeymap<Action>, slot: KeyHintSlot, separator = " · "): string {
	return keymap.hints(slot).map((hint) => `${hint.keys.join("/")} ${hint.label}`).join(separator);
}

export type ScrollKeyAction = "close" | "down" | "up" | "downFast" | "upFast" | "pageDown" | "pageUp" | "top" | "bottom" | "left" | "right" | "leftmost";

export function createScrollingKeymap(): DocketKeymap<ScrollKeyAction> {
	return defineKeymap("scrolling viewer", [
		{ keys: ["escape", "q", "ctrl+c"], action: "close", label: "close", slots: ["footer"] },
		{ keys: ["j", "down"], action: "down", label: "down", slots: ["footer"] },
		{ keys: ["k", "up"], action: "up", label: "up", slots: ["footer"] },
		{ keys: "J", action: "downFast", label: "down 5" },
		{ keys: "K", action: "upFast", label: "up 5" },
		{ keys: [" ", "d", "pagedown", "ctrl+f"], action: "pageDown", label: "page", slots: ["footer"] },
		{ keys: ["b", "u", "pageup", "ctrl+u"], action: "pageUp", label: "page" },
		{ keys: "g", action: "top", label: "top", slots: ["footer"] },
		{ keys: "G", action: "bottom", label: "bottom", slots: ["footer"] },
		{ keys: ["h", "left"], action: "left", label: "left", slots: ["footer"] },
		{ keys: ["l", "right"], action: "right", label: "right", slots: ["footer"] },
		{ keys: "0", action: "leftmost", label: "left" },
	]);
}

export type DashboardKeyAction = "close" | "down" | "up" | "top" | "bottom" | "next" | "help" | "progress" | "peek" | "open" | "load" | "tell" | "attach" | "stop";

export function createWorkerDashboardKeymap(options: { enterLabel?: "verdict" | "details"; canLoad?: boolean } = {}): DocketKeymap<DashboardKeyAction> {
	const bindings: KeyBinding<DashboardKeyAction>[] = [
		{ keys: ["escape", "q", "ctrl+c"], action: "close", label: "close", slots: ["footer"] },
		{ keys: ["j", "down"], action: "down", label: "down", slots: ["footer"] },
		{ keys: ["k", "up"], action: "up", label: "up", slots: ["footer"] },
		{ keys: "g", action: "top", label: "top" },
		{ keys: "G", action: "bottom", label: "bottom" },
		{ keys: "tab", action: "next", label: "next worker", slots: ["help"] },
		{ keys: "?", action: "help", label: "more", slots: ["footer"] },
		{ keys: "t", action: "progress", label: "progress details", slots: ["help"] },
		{ keys: "p", action: "peek", label: "peek", slots: ["footer"] },
		{ keys: "r", action: "tell", label: "tell", slots: ["footer"] },
		{ keys: "enter", action: "open", label: options.enterLabel ?? "verdict/details", slots: ["footer"] },
		...(options.canLoad === false ? [] : [{ keys: "l", action: "load", label: "load", slots: ["footer"] } satisfies KeyBinding<DashboardKeyAction>]),
		{ keys: "a", action: "attach", label: "direct tmux control", slots: ["help"] },
		{ keys: "x", action: "stop", label: "stop", slots: ["footer"] },
	];
	return defineKeymap("worker dashboard", bindings);
}

export type PickerKeyAction = "close" | "down" | "up" | "top" | "bottom" | "select" | "preview" | "edit" | "delete" | "switchCheckpoint" | "switchWorker" | "switch";

export function createPickerKeymap(options: { mode: "resume" | "delete" | "load"; canSwitch?: boolean; canPreview?: boolean }): DocketKeymap<PickerKeyAction> {
	const bindings: KeyBinding<PickerKeyAction>[] = [
		{ keys: ["escape", "q", "ctrl+c"], action: "close", label: "close", slots: ["footer"] },
		{ keys: ["j", "down"], action: "down", label: "move", slots: ["footer"] },
		{ keys: ["k", "up"], action: "up", label: "move", slots: ["footer"] },
		{ keys: "g", action: "top", label: "top" },
		{ keys: "G", action: "bottom", label: "bottom" },
		{ keys: "enter", action: "select", label: options.mode === "resume" ? "Start session" : options.mode, slots: ["footer"] },
	];
	if (options.canPreview) bindings.push({ keys: "p", action: "preview", label: "preview", slots: ["footer"] });
	if (options.mode === "resume") {
		bindings.push({ keys: "e", action: "edit", label: "edit", slots: ["footer"] });
		bindings.push({ keys: "d", action: "delete", label: "delete", slots: ["footer"] });
	}
	if (options.mode === "delete") bindings.push({ keys: "d", action: "delete", label: "delete", slots: ["footer"] });
	if (options.canSwitch) {
		bindings.push({ keys: "tab", action: "switch", label: "switch", slots: ["footer"] });
		bindings.push({ keys: "1", action: "switchCheckpoint", label: "checkpoints" });
		bindings.push({ keys: "2", action: "switchWorker", label: "workers" });
	}
	return defineKeymap(`picker:${options.mode}`, bindings);
}

export type EvidenceBundleKeyAction = "close" | "down" | "up" | "top" | "bottom" | "toggle" | "all" | "none" | "save";

export function createEvidenceBundleKeymap(): DocketKeymap<EvidenceBundleKeyAction> {
	return defineKeymap("evidence bundle", [
		{ keys: ["escape", "q", "ctrl+c"], action: "close", label: "cancel", slots: ["footer"] },
		{ keys: ["j", "down"], action: "down", label: "move", slots: ["footer"] },
		{ keys: ["k", "up"], action: "up", label: "move", slots: ["footer"] },
		{ keys: "g", action: "top", label: "top" },
		{ keys: "G", action: "bottom", label: "bottom" },
		{ keys: "space", action: "toggle", label: "toggle", slots: ["footer"] },
		{ keys: "a", action: "all", label: "all", slots: ["footer"] },
		{ keys: "n", action: "none", label: "none", slots: ["footer"] },
		{ keys: "enter", action: "save", label: "Save", slots: ["footer"] },
	]);
}

export type VerdictKeyAction = "close" | "down" | "up" | "top" | "bottom" | "select" | "diff" | "hunk" | "report" | "use" | "option1" | "option2" | "option3" | "option4" | "option5" | "option6" | "option7" | "option8" | "option9";

export function createVerdictKeymap(options: { hasChangeSet: boolean; optionCount: number; canReport?: boolean; canUse?: boolean }): DocketKeymap<VerdictKeyAction> {
	const bindings: KeyBinding<VerdictKeyAction>[] = [
		{ keys: ["escape", "q", "ctrl+c"], action: "close", label: "close", slots: ["footer"] },
		{ keys: ["j", "down"], action: "down", label: "move", slots: ["footer"] },
		{ keys: ["k", "up"], action: "up", label: "move", slots: ["footer"] },
		{ keys: "g", action: "top", label: "top" },
		{ keys: "G", action: "bottom", label: "bottom" },
		{ keys: "enter", action: "select", label: "select", slots: ["footer"] },
	];
	if (options.canReport) {
		bindings.push({ keys: "r", action: "report", label: "Report", slots: ["footer"] });
	}
	if (options.canUse) bindings.push({ keys: "u", action: "use", label: "Use", slots: ["footer"] });
	if (options.hasChangeSet) {
		bindings.push({ keys: "d", action: "diff", label: "full diff", slots: ["footer"] });
		bindings.push({ keys: "h", action: "hunk", label: "Hunk review", slots: ["footer"] });
	}
	for (let index = 1; index <= Math.min(9, options.optionCount); index++) {
		bindings.push({ keys: String(index), action: `option${index}` as VerdictKeyAction, label: "pick", slots: ["footer"] });
	}
	return defineKeymap("verdict", bindings);
}
