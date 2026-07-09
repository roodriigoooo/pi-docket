import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export type BorderOptions = {
	fill?: (s: string) => string;
	left?: string;
	right?: string;
};

export const TOP_CORNERS: BorderOptions = { left: "╭", right: "╮" };
export const BOTTOM_CORNERS: BorderOptions = { left: "╰", right: "╯" };

export function fitBorder(left: string, right: string, width: number, border: (s: string) => string, options: BorderOptions = {}): string {
	const cornerL = options.left ?? "─";
	const cornerR = options.right ?? "─";
	const fill = options.fill ?? border;
	if (width <= 0) return "";
	if (width === 1) return border(cornerL);
	let leftText = left;
	let rightText = right;
	const fixedWidth = 2;
	const minimumGap = leftText || rightText ? 3 : 0;
	while (fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width && visibleWidth(rightText) > 0) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width && visibleWidth(leftText) > 0) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}
	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${border(cornerL)}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border(cornerR)}`;
}

export function padAnsi(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

export function wrapPlainText(text: string, width: number, maxLines = Infinity): string[] {
	const limit = Math.max(12, width);
	const out: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		let line = raw.trim();
		if (!line) {
			out.push("");
			continue;
		}
		while (visibleWidth(line) > limit && out.length < maxLines) {
			let slice = truncateToWidth(line, limit, "");
			const breakAt = slice.lastIndexOf(" ");
			if (breakAt > limit * 0.45) slice = slice.slice(0, breakAt);
			out.push(slice.trimEnd());
			line = line.slice(slice.length).trimStart();
		}
		if (out.length < maxLines) out.push(line);
	}
	return out.length > maxLines ? out.slice(0, maxLines) : out;
}
