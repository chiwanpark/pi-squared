import { truncateToWidth, visibleWidth, type EditorTheme, type MarkdownTheme } from "@earendil-works/pi-tui";

const ESC = "\u001b[";

function code(open: number, close: number): (text: string) => string {
  return (text) => `${ESC}${open}m${text}${ESC}${close}m`;
}

function color(hex: string): (text: string) => string {
  const [r, g, b] = hexToRgb(hex);
  return (text) => `${ESC}38;2;${r};${g};${b}m${text}${ESC}39m`;
}

function bg(hex: string): (text: string) => string {
  const [r, g, b] = hexToRgb(hex);
  return (text) => `${ESC}48;2;${r};${g};${b}m${text}${ESC}49m`;
}

function hexToRgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Invalid color: ${hex}`);
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function identity(text: string): string {
  return text;
}

function keepBackgroundAfterAnsiReset(text: string, bgColor: (text: string) => string): string {
  const backgroundOpen = bgColor("").replace("\u001b[49m", "");
  return text.replace(/\u001b\[(?:0|49)m/g, (reset) => reset + backgroundOpen);
}

function applyFullLineBackground(line: string, width: number, bgColor: (text: string) => string): string {
  const truncated = truncateToWidth(line, width, "");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  return bgColor(keepBackgroundAfterAnsiReset(truncated + padding, bgColor));
}

const palette = {
  markdownAccent: "#b8d3ff",
  markdownHeading: "#ffffff",
  accentBlue: "#b8d3ff",
  accentTeal: "#c7d2e0",
  successGreen: "#9fd59f",
  errorRed: "#ff9a9a",
  warningAmber: "#d2b48c",
  surface: "#000000",
  surfaceAlt: "#111111",
  surfaceMuted: "#1a1a1a",
  surfaceCustom: "#161616",
  surfaceToolPending: "#292929",
  surfaceToolError: "#2e1717",
  surfaceToolSuccess: "#172e17",
  gray: "#a7a7a7",
  toolSummaryText: "#cccccc",
  dimGray: "#8a8a8a",
  lightGray: "#3a3d42",
  borderGray: "#666666",
  borderBright: "#9a9a9a",
} as const;

export const style = {
  bold: code(1, 22),
  dim: code(2, 22),
  italic: code(3, 23),
  underline: code(4, 24),
  strikethrough: code(9, 29),

  // codex-dark foregrounds
  text: identity,
  accent: color(palette.accentBlue),
  border: color(palette.borderGray),
  borderAccent: color(palette.borderBright),
  cyan: color(palette.accentBlue),
  green: color(palette.successGreen),
  yellow: color(palette.warningAmber),
  red: color(palette.errorRed),
  magenta: color(palette.accentTeal),
  white: identity,
  gray: color(palette.gray),
  dimGray: color(palette.dimGray),
  toolTitle: color(palette.toolSummaryText),
  markdownAccent: color(palette.markdownAccent),
  markdownHeading: color(palette.markdownHeading),
  softBlue: color(palette.accentBlue),
  softGreen: color(palette.successGreen),
  softYellow: color(palette.warningAmber),
  softMagenta: color(palette.accentTeal),

  // codex-dark surfaces. Empty theme colors are represented by identity.
  bgAssistant: identity,
  bgThinking: bg(palette.surfaceMuted),
  bgUser: bg(palette.lightGray),
  bgTool: bg(palette.surfaceToolSuccess),
  bgToolPending: bg(palette.surfaceToolPending),
  bgError: bg(palette.surfaceToolError),
  bgCustom: bg(palette.surfaceCustom),
};

export const editorTheme: EditorTheme = {
  borderColor: style.border,
  selectList: {
    selectedPrefix: style.accent,
    selectedText: style.accent,
    description: style.gray,
    scrollInfo: style.gray,
    noMatch: style.yellow,
  },
};

export function applyEditorSurfaceBackground(line: string, width: number): string {
  return applyFullLineBackground(line, width, style.bgUser);
}

export const markdownTheme: MarkdownTheme = {
  heading: style.markdownHeading,
  link: style.markdownAccent,
  linkUrl: style.markdownAccent,
  code: style.markdownAccent,
  codeBlock: style.gray,
  codeBlockBorder: style.border,
  quote: style.gray,
  quoteBorder: style.border,
  hr: style.border,
  listBullet: style.markdownAccent,
  bold: style.bold,
  italic: style.italic,
  strikethrough: style.strikethrough,
  underline: style.underline,
  codeBlockIndent: "",
};
