import { homedir } from "node:os";
import {
  Editor,
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type DefaultTextStyle,
  type TUI,
} from "@earendil-works/pi-tui";

export interface ScreenPanel {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { contentToText, isAssistantError, messageRole, messageToMarkdownBlocks } from "../runtime/messages.js";
import type { PiSquaredAgentRuntime } from "../runtime/pi-agent.js";
import type { AgentStatusSnapshot } from "../runtime/status-store.js";
import { editorTheme, markdownTheme, style } from "./theme.js";

export interface ChatScreenOptions {
  onSubmit: (text: string) => void;
}

export class ChatScreen implements Component {
  readonly editor: Editor;
  private panel: ScreenPanel | null = null;
  private messageRenderCache: { width: number; updatedAt: number; lines: string[] } | null = null;
  private errorRenderCache: { width: number; error: string | undefined; lines: string[] } | null = null;

  private readonly panelProxy: Component = {
    render: () => [],
    handleInput: (data) => this.panel?.handleInput(data),
    invalidate: () => this.panel?.invalidate(),
  };

  constructor(
    private readonly tui: TUI,
    private readonly runtime: PiSquaredAgentRuntime,
    options: ChatScreenOptions,
  ) {
    this.editor = new Editor(tui, { ...editorTheme }, { paddingX: 1 });
    this.editor.onSubmit = (text) => options.onSubmit(text);
  }

  setPanel(panel: ScreenPanel | null): void {
    this.panel = panel;
    this.tui.setFocus(panel ? this.panelProxy : this.editor);
    this.tui.requestRender(true);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const snapshot = this.runtime.status.getSnapshot();

    this.editor.disableSubmit = snapshot.phase === "streaming" || snapshot.phase === "aborting";
    this.editor.borderColor = (text: string) => EDITOR_BORDER_MARKER + text.replace(/./g, " ");

    const editorLines = this.editor
      .render(safeWidth)
      .map((line) => (line.includes(EDITOR_BORDER_MARKER) ? "" : line))
      .map((line) => applyEditorBackground(line, safeWidth));
    const footer = this.renderFooter(safeWidth, snapshot);
    const messageLines = this.renderMessages(safeWidth, snapshot);
    const errorLines = this.renderError(safeWidth, snapshot.lastError);
    const panelLines = this.panel
      ? this.panel.render(safeWidth).map((line) => truncateToWidth(line, safeWidth, ""))
      : [];

    // Emit the full message history rather than slicing to the visible viewport.
    // Truncating here would prevent older lines from ever being written to the
    // terminal, leaving tmux (and other terminals' native scrollback) with
    // nothing to scroll. The underlying TUI handles natural terminal scrolling
    // when total content exceeds the terminal height, pushing older lines into
    // the scrollback buffer where the user (and tmux copy mode) can reach them.
    //
    // The transcript is cached by status timestamp so plain editor input does
    // not re-run Markdown/tool-output rendering for the entire history on every
    // keystroke. Keep per-section truncation instead of a final whole-screen map
    // to avoid walking huge transcripts just because the input line changed.
    return [...messageLines, ...errorLines, ...panelLines, ...editorLines, ...footer, ""];
  }

  handleInput(data: string): void {
    this.editor.handleInput(data);
  }

  invalidate(): void {
    this.messageRenderCache = null;
    this.errorRenderCache = null;
    this.editor.invalidate();
  }

  private renderFooter(width: number, snapshot: AgentStatusSnapshot): string[] {
    const provider = snapshot.model.provider;
    const model = snapshot.model.id;
    const thinking = ` ${snapshot.thinkingLevel}`;
    const cwd = formatCwd(this.runtime.getCwd());
    const phase = formatPhase(snapshot.phase);
    const title = `${style.gray("(")}${style.gray(provider)}${style.gray(")")} ${style.bold(style.white(model))}${style.gray(thinking)} ${style.gray("·")} ${style.gray(cwd)} ${style.gray("·")} ${phase}`;
    return [truncateToWidth(title, width, "")];
  }

  private renderError(width: number, error: string | undefined): string[] {
    const cached = this.errorRenderCache;
    if (cached && cached.width === width && cached.error === error) {
      return cached.lines;
    }

    const lines = error ? wrapWithPrefix(style.red("error: "), error, width) : [];
    this.errorRenderCache = { width, error, lines };
    return lines;
  }

  private renderMessages(width: number, snapshot: AgentStatusSnapshot): string[] {
    const cached = this.messageRenderCache;
    if (cached && cached.width === width && cached.updatedAt === snapshot.updatedAt) {
      return cached.lines;
    }

    const lines: string[] = [];

    const toolCalls = new Map<string, BashToolCall>();

    for (const message of snapshot.messages) {
      lines.push(...renderMessage(message, width, false, toolCalls));
      collectBashToolCalls(message, toolCalls);
    }

    if (snapshot.streamingMessage) {
      lines.push(...renderMessage(snapshot.streamingMessage, width, true, toolCalls));
    }

    const renderedLines = (
      lines.length === 0 ? [style.gray("Welcome to pi-squared. Type a message to start chatting.")] : lines
    ).map((line) => truncateToWidth(line, width, ""));

    this.messageRenderCache = { width, updatedAt: snapshot.updatedAt, lines: renderedLines };
    return renderedLines;
  }
}

function formatPhase(phase: string): string {
  switch (phase) {
    case "idle":
      return style.green("idle");
    case "streaming":
      return style.yellow("responding");
    case "aborting":
      return style.yellow("aborting");
    case "error":
      return style.red("error");
    default:
      return phase;
  }
}

function formatCwd(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

interface BashToolCall {
  command: string;
  timeout: number | undefined;
}

type UnknownRecord = Record<string, unknown>;

const BLOCK_PADDING_Y = 1;
const TOOL_RESULT_PADDING_X = 1;
const EDITOR_BORDER_MARKER = "\u001b]pi-squared:editor-border\u0007";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function renderMessage(
  message: AgentMessage,
  width: number,
  streaming = false,
  toolCalls: ReadonlyMap<string, BashToolCall> = new Map(),
): string[] {
  const role = messageRole(message);
  if (role === "toolResult") return renderToolResult(message, width, toolCalls);

  const error = isAssistantError(message);
  const blocks = messageToMarkdownBlocks(message);

  if (streaming && blocks.length === 0) {
    blocks.push({ kind: "message", text: "…" });
  } else if (streaming && blocks.length > 0) {
    const last = blocks[blocks.length - 1]!;
    if (last.text.trim().length === 0) last.text = "…";
  }

  const lines: string[] = [];
  for (const block of blocks) {
    lines.push(...renderMarkdownBlock(block.text, width, blockStyle(role, block.kind, error)));
  }

  return lines;
}

function collectBashToolCalls(message: AgentMessage, toolCalls: Map<string, BashToolCall>): void {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return;

  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "toolCall" || block.name !== "bash" || typeof block.id !== "string")
      continue;
    const args = isRecord(block.arguments) ? block.arguments : undefined;
    const command = typeof args?.command === "string" ? args.command : "";
    const timeout = typeof args?.timeout === "number" ? args.timeout : undefined;
    toolCalls.set(block.id, { command, timeout });
  }
}

function renderToolResult(
  message: AgentMessage,
  width: number,
  toolCalls: ReadonlyMap<string, BashToolCall>,
): string[] {
  const toolCallId = isRecord(message) && typeof message.toolCallId === "string" ? message.toolCallId : undefined;
  const toolName = isRecord(message) && typeof message.toolName === "string" ? message.toolName : "tool";
  const bashCall = toolCallId ? toolCalls.get(toolCallId) : undefined;
  const command = sanitizeToolResultText(bashCall?.command ?? toolName).replace(/\n+$/, "") || toolName;
  const timeout = bashCall?.timeout === undefined ? "none" : String(bashCall.timeout);
  const output = sanitizeToolResultText(isRecord(message) ? contentToText(message.content) : "");

  const contentLines = [
    ...renderToolResultHeader(command, timeout),
    "",
    ...styleMultiline(output || "(no output)", style.gray),
  ];
  const paddingLine = applyLineBackground("", width, style.bgTool);
  return [
    ...Array.from({ length: BLOCK_PADDING_Y }, () => paddingLine),
    ...contentLines.map((line) => applyToolResultLineBackground(line, width)),
    ...Array.from({ length: BLOCK_PADDING_Y }, () => paddingLine),
  ];
}

function renderToolResultHeader(command: string, timeout: string): string[] {
  const commandLines = command.split("\n");
  const lastIndex = commandLines.length - 1;

  return commandLines.map((line, index) => {
    const prefix = index === 0 ? `${style.bold(style.toolTitle("bash"))} ` : "     ";
    const suffix = index === lastIndex ? ` ${style.gray(`(timeout: ${timeout})`)}` : "";
    return `${prefix}${style.toolTitle(line.length > 0 ? line : " ")}${suffix}`;
  });
}

function sanitizeToolResultText(text: string): string {
  return stripAnsiEscapeCodes(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "   ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function stripAnsiEscapeCodes(text: string): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    const escapeLength = ansiEscapeSequenceLength(text, index);
    if (escapeLength > 0) {
      index += escapeLength;
      continue;
    }

    result += text[index];
    index++;
  }

  return result;
}

function ansiEscapeSequenceLength(text: string, index: number): number {
  const char = text[index];

  if (char === "\u009b") return controlSequenceLength(text, index + 1, index);
  if (char !== "\u001b") return 0;

  const next = text[index + 1];
  if (!next) return 1;

  if (next === "[") return controlSequenceLength(text, index + 2, index);

  if (next === "]" || next === "_" || next === "P" || next === "^") {
    for (let cursor = index + 2; cursor < text.length; cursor++) {
      if (text[cursor] === "\u0007") return cursor + 1 - index;
      if (text[cursor] === "\u001b" && text[cursor + 1] === "\\") return cursor + 2 - index;
    }
    return text.length - index;
  }

  if (/[\x40-\x5f]/.test(next)) return 2;
  return 1;
}

function controlSequenceLength(text: string, cursor: number, start: number): number {
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) return cursor + 1 - start;
    cursor++;
  }
  return text.length - start;
}

function styleMultiline(text: string, color: (text: string) => string): string[] {
  return text.split("\n").map((line) => color(line.length > 0 ? line : " "));
}

function applyToolResultLineBackground(line: string, width: number): string {
  return applyLineBackground(`${" ".repeat(TOOL_RESULT_PADDING_X)}${line}`, width, style.bgTool);
}

function applyLineBackground(line: string, width: number, bgColor: (text: string) => string): string {
  const truncated = truncateToWidth(line, width, "");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  return bgColor(truncated + padding);
}

function applyEditorBackground(line: string, width: number): string {
  const truncated = truncateToWidth(line, width, "");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  return style.bgUser(keepEditorBackgroundAfterAnsiReset(truncated + padding));
}

function keepEditorBackgroundAfterAnsiReset(text: string): string {
  const userBackgroundOpen = style.bgUser("").replace("\u001b[49m", "");
  return text.replace(/\u001b\[(?:0|49)m/g, (reset) => reset + userBackgroundOpen);
}

function renderMarkdownBlock(text: string, width: number, defaultTextStyle: DefaultTextStyle): string[] {
  const markdown = new Markdown(text, 1, BLOCK_PADDING_Y, markdownTheme, defaultTextStyle);
  return markdown.render(width);
}

function blockStyle(role: string, kind: "thinking" | "message", error: boolean): DefaultTextStyle {
  if (error) return { bgColor: style.bgError, color: style.red };
  if (kind === "thinking") return { bgColor: style.bgThinking, color: style.gray, italic: true };

  switch (role) {
    case "user":
      return { bgColor: style.bgUser, color: style.text };
    case "assistant":
      return { bgColor: style.bgAssistant, color: style.text };
    case "toolResult":
      return { bgColor: style.bgTool, color: style.text };
    default:
      return { bgColor: style.bgCustom, color: style.text };
  }
}

function wrapWithPrefix(prefix: string, text: string, width: number): string[] {
  const prefixWidth = visibleWidth(prefix);
  const continuation = " ".repeat(prefixWidth);
  const bodyWidth = Math.max(1, width - prefixWidth);
  const lines: string[] = [];
  const sourceLines = text.split("\n");

  for (const sourceLine of sourceLines) {
    const wrapped = wrapTextWithAnsi(sourceLine.length > 0 ? sourceLine : " ", bodyWidth);
    for (const chunk of wrapped.length > 0 ? wrapped : [""]) {
      lines.push(`${lines.length === 0 ? prefix : continuation}${chunk}`);
    }
  }

  return lines.map((line) => truncateToWidth(line, width, ""));
}
