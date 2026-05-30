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
  placement?: "aboveEditor" | "belowEditor";
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { contentToText, isAssistantError, messageRole, messageToMarkdownBlocks } from "../runtime/messages.js";
import type { PiSquaredAgentRuntime } from "../runtime/pi-agent.js";
import type { AgentStatusSnapshot } from "../runtime/status-store.js";
import { applyEditorSurfaceBackground, editorTheme, markdownTheme, style } from "./theme.js";
import { renderWelcome } from "./welcome.js";

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
      .map((line) => applyEditorSurfaceBackground(line, safeWidth));
    if (isSlashCommandMenuOpen(this.editor)) {
      editorLines.push(applyEditorSurfaceBackground("", safeWidth));
    }
    const footer = this.renderFooter(safeWidth, snapshot);
    const messageLines = this.renderMessages(safeWidth, snapshot);
    const errorLines = this.renderError(safeWidth, snapshot.lastError);
    const panelLines = this.panel
      ? this.panel.render(safeWidth).map((line) => truncateToWidth(line, safeWidth, ""))
      : [];
    const aboveEditorPanelLines = this.panel?.placement === "belowEditor" ? [] : panelLines;
    const belowEditorPanelLines = this.panel?.placement === "belowEditor" ? panelLines : [];

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
    return [
      ...messageLines,
      ...errorLines,
      ...aboveEditorPanelLines,
      ...editorLines,
      ...belowEditorPanelLines,
      ...footer,
      "",
    ];
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
    const contextWindow = renderContextWindowUsage(snapshot);
    const contextPart = contextWindow ? ` ${style.gray("·")} ${contextWindow}` : "";
    const title = `${style.gray("(")}${style.gray(provider)}${style.gray(")")} ${style.bold(style.white(model))}${style.gray(thinking)} ${style.gray("·")} ${style.gray(cwd)}${contextPart} ${style.gray("·")} ${phase}`;
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

    const toolCalls = new Map<string, ToolCallSummary>();

    for (const message of snapshot.messages) {
      lines.push(...renderMessage(message, width, false, toolCalls));
      collectBashToolCalls(message, toolCalls);
    }

    if (snapshot.streamingMessage) {
      lines.push(...renderMessage(snapshot.streamingMessage, width, true, toolCalls));
    }

    const renderedLines = [...renderWelcome(width, snapshot, this.runtime.getCwd()), ...lines].map((line) =>
      truncateToWidth(line, width, ""),
    );

    this.messageRenderCache = { width, updatedAt: snapshot.updatedAt, lines: renderedLines };
    return renderedLines;
  }
}

function isSlashCommandMenuOpen(editor: Editor): boolean {
  if (!editor.isShowingAutocomplete()) return false;

  const cursor = editor.getCursor();
  const line = editor.getLines()[cursor.line] ?? "";
  const textBeforeCursor = line.slice(0, cursor.col);
  return textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ");
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

function renderContextWindowUsage(snapshot: AgentStatusSnapshot): string | undefined {
  const contextWindow = snapshot.model.contextWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;

  const messages = snapshot.streamingMessage ? [...snapshot.messages, snapshot.streamingMessage] : snapshot.messages;
  const usedTokens = estimateContextTokens(messages);
  const percent = Math.round((usedTokens / contextWindow) * 100);
  const percentage = styleContextUsagePercentage(`${percent}%`, percent);

  return `${percentage}${style.gray(" used")} ${style.gray(`(${formatTokenCount(usedTokens)} / ${formatTokenCount(contextWindow)})`)}`;
}

function styleContextUsagePercentage(text: string, percent: number): string {
  if (percent >= 90) return style.red(text);
  if (percent >= 70) return style.yellow(text);
  return style.green(text);
}

function formatTokenCount(count: number): string {
  const safeCount = Math.max(0, Math.round(count));
  if (safeCount < 1000) return String(safeCount);
  if (safeCount < 10_000) return `${(safeCount / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  if (safeCount < 1_000_000) return `${Math.round(safeCount / 1000)}K`;
  if (safeCount < 10_000_000) return `${(safeCount / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${Math.round(safeCount / 1_000_000)}M`;
}

function estimateContextTokens(messages: AgentMessage[]): number {
  const usageInfo = getLastAssistantUsageInfo(messages);
  if (!usageInfo) return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);

  const usageTokens = calculateUsageTokens(usageInfo.usage);
  const trailingTokens = messages
    .slice(usageInfo.index + 1)
    .reduce((total, message) => total + estimateMessageTokens(message), 0);
  return usageTokens + trailingTokens;
}

interface UsageInfo {
  usage: UsageLike;
  index: number;
}

interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): UsageInfo | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = getAssistantUsage(messages[index]!);
    if (usage) return { usage, index };
  }
  return undefined;
}

function getAssistantUsage(message: AgentMessage): UsageLike | undefined {
  if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return undefined;
  if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;

  const usage = message.usage;
  const input = numberField(usage.input);
  const output = numberField(usage.output);
  const cacheRead = numberField(usage.cacheRead);
  const cacheWrite = numberField(usage.cacheWrite);
  const totalTokens = numberField(usage.totalTokens);
  if ([input, output, cacheRead, cacheWrite, totalTokens].every((value) => value === undefined)) return undefined;

  const usageLike = {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    totalTokens: totalTokens ?? 0,
  };

  // Streaming partial assistant messages are initialized with a zero-filled
  // usage object. Treating that as authoritative makes the footer show
  // 0 / limit until the final usage arrives; ignore it so we keep using the
  // previous completed usage plus estimated trailing messages while streaming.
  if (calculateUsageTokens(usageLike) <= 0) return undefined;

  return usageLike;
}

function calculateUsageTokens(usage: UsageLike): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function estimateMessageTokens(message: AgentMessage): number {
  return Math.ceil(estimateMessageChars(message) / 4);
}

function estimateMessageChars(message: AgentMessage): number {
  if (!isRecord(message)) return safeStringify(message).length;

  switch (message.role) {
    case "user":
    case "toolResult":
      return estimateContentChars(message.content);
    case "assistant":
      return (
        estimateAssistantContentChars(message.content) +
        (typeof message.errorMessage === "string" ? message.errorMessage.length : 0)
      );
    default:
      return typeof message.content === "string" || Array.isArray(message.content)
        ? estimateContentChars(message.content)
        : safeStringify(message).length;
  }
}

function estimateContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, block) => total + estimateContentBlockChars(block), 0);
}

function estimateAssistantContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, block) => total + estimateAssistantContentBlockChars(block), 0);
}

function estimateContentBlockChars(block: unknown): number {
  if (!isRecord(block)) return 0;
  if (block.type === "text" && typeof block.text === "string") return block.text.length;
  if (block.type === "image") return 4800;
  return 0;
}

function estimateAssistantContentBlockChars(block: unknown): number {
  if (!isRecord(block)) return 0;
  if (block.type === "text" && typeof block.text === "string") return block.text.length;
  if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking.length;
  if (block.type === "toolCall") return String(block.name ?? "").length + safeStringify(block.arguments).length;
  return estimateContentBlockChars(block);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

interface ToolCallSummary {
  name: string;
  summary: string;
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
  toolCalls: ReadonlyMap<string, ToolCallSummary> = new Map(),
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

function collectBashToolCalls(message: AgentMessage, toolCalls: Map<string, ToolCallSummary>): void {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return;

  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string" || typeof block.id !== "string")
      continue;
    const args = isRecord(block.arguments) ? block.arguments : undefined;
    const timeout = typeof args?.timeout === "number" ? args.timeout : undefined;
    toolCalls.set(block.id, { name: block.name, summary: summarizeToolCall(block.name, args), timeout });
  }
}

function renderToolResult(
  message: AgentMessage,
  width: number,
  toolCalls: ReadonlyMap<string, ToolCallSummary>,
): string[] {
  const toolCallId = isRecord(message) && typeof message.toolCallId === "string" ? message.toolCallId : undefined;
  const toolName = isRecord(message) && typeof message.toolName === "string" ? message.toolName : "tool";
  const call = toolCallId ? toolCalls.get(toolCallId) : undefined;
  const label = call?.name ?? toolName;
  const command = sanitizeToolResultText(call?.summary ?? toolName).replace(/\n+$/, "") || toolName;
  const timeout = call?.timeout === undefined ? undefined : String(call.timeout);
  const output = sanitizeToolResultText(isRecord(message) ? contentToText(message.content) : "");

  const contentLines = [
    ...renderToolResultHeader(label, command, timeout),
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

function renderToolResultHeader(label: string, command: string, timeout: string | undefined): string[] {
  const commandLines = command.split("\n");
  const lastIndex = commandLines.length - 1;

  return commandLines.map((line, index) => {
    const prefix = index === 0 ? `${style.bold(style.toolTitle(label))} ` : " ".repeat(label.length + 1);
    const suffix = index === lastIndex && timeout !== undefined ? ` ${style.gray(`(timeout: ${timeout})`)}` : "";
    return `${prefix}${style.toolTitle(line.length > 0 ? line : " ")}${suffix}`;
  });
}

function summarizeToolCall(name: string, args: UnknownRecord | undefined): string {
  if (!args) return name;
  if (name === "bash" && typeof args.command === "string") return args.command;
  if ((name === "read" || name === "write" || name === "edit" || name === "ls") && typeof args.path === "string") {
    return args.path;
  }
  if (name === "find" && typeof args.pattern === "string") {
    return `${args.pattern}${typeof args.path === "string" ? ` in ${args.path}` : ""}`;
  }
  if (name === "grep" && typeof args.pattern === "string") {
    return `/${args.pattern}/${typeof args.path === "string" ? ` in ${args.path}` : ""}`;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return name;
  }
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
