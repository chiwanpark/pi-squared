import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { style } from "./theme.js";

export interface DrawBoxOptions {
  indent?: string;
  paddingX?: number;
  maxWidth?: number;
  preferredContentWidth?: number;
  minContentWidth?: number;
  borderStyle?: (text: string) => string;
}

export function fitVisible(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

export function drawBox(contents: readonly string[], options: DrawBoxOptions = {}): string[] {
  const indent = options.indent ?? "";
  const paddingX = Math.max(0, options.paddingX ?? 0);
  const naturalContentWidth = contents.length === 0 ? 0 : Math.max(...contents.map((line) => visibleWidth(line)));
  const preferredContentWidth = Math.max(
    0,
    options.preferredContentWidth ?? naturalContentWidth,
    options.minContentWidth ?? 0,
  );
  const reservedWidth = visibleWidth(indent) + 2 + paddingX * 2;
  const maxContentWidth =
    options.maxWidth == null ? preferredContentWidth : Math.max(0, options.maxWidth - reservedWidth);
  const contentWidth = Math.min(preferredContentWidth, maxContentWidth);
  const padding = " ".repeat(paddingX);
  const horizontal = "─".repeat(contentWidth + paddingX * 2);
  const border = options.borderStyle ?? style.border;

  return [
    `${indent}${border(`╭${horizontal}╮`)}`,
    ...contents.map(
      (line) => `${indent}${border("│")}${padding}${fitVisible(line, contentWidth)}${padding}${border("│")}`,
    ),
    `${indent}${border(`╰${horizontal}╯`)}`,
  ];
}
