import {
  Editor,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { isAssistantError, messageRole, messageToText } from "../runtime/messages.js";
import type { PiSquaredAgentRuntime } from "../runtime/pi-agent.js";
import { editorTheme, style } from "./theme.js";

export interface ChatScreenOptions {
  onSubmit: (text: string) => void;
}

export class ChatScreen implements Component {
  readonly editor: Editor;

  constructor(
    private readonly tui: TUI,
    private readonly runtime: PiSquaredAgentRuntime,
    options: ChatScreenOptions,
  ) {
    this.editor = new Editor(tui, { ...editorTheme }, { paddingX: 1 });
    this.editor.onSubmit = (text) => options.onSubmit(text);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const snapshot = this.runtime.status.getSnapshot();

    this.editor.disableSubmit = snapshot.phase === "streaming" || snapshot.phase === "aborting";
    this.editor.borderColor =
      snapshot.phase === "idle" ? style.cyan : snapshot.phase === "error" ? style.red : style.yellow;

    const editorLines = this.editor.render(safeWidth);
    const header = this.renderHeader(safeWidth);
    const help = this.renderHelp(safeWidth);
    const messageLines = this.renderMessages(safeWidth);
    const errorLines = snapshot.lastError ? wrapWithPrefix(style.red("error: "), snapshot.lastError, safeWidth) : [];

    const reservedRows = header.length + help.length + editorLines.length + errorLines.length;
    const availableMessageRows = Math.max(1, this.tui.terminal.rows - reservedRows);
    const visibleMessages = messageLines.slice(-availableMessageRows);

    return [...header, ...visibleMessages, ...errorLines, ...help, ...editorLines].map((line) =>
      truncateToWidth(line, safeWidth, ""),
    );
  }

  handleInput(data: string): void {
    this.editor.handleInput(data);
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  private renderHeader(width: number): string[] {
    const snapshot = this.runtime.status.getSnapshot();
    const model = `${snapshot.model.provider}/${snapshot.model.id}`;
    const phase = formatPhase(snapshot.phase);
    const title = `${style.bold("pi-squared")} ${style.gray("·")} ${style.dim(model)} ${style.gray("·")} ${phase}`;
    return [truncateToWidth(title, width, "")];
  }

  private renderHelp(width: number): string[] {
    const snapshot = this.runtime.status.getSnapshot();
    const text =
      snapshot.phase === "idle"
        ? "enter send • shift+enter newline • /quit exit • no tools enabled"
        : "responding… ctrl+c or esc aborts";
    return [truncateToWidth(style.gray(text), width, "")];
  }

  private renderMessages(width: number): string[] {
    const snapshot = this.runtime.status.getSnapshot();
    const lines: string[] = [];

    for (const message of snapshot.messages) {
      lines.push(...renderMessage(message, width));
    }

    if (snapshot.streamingMessage) {
      lines.push(...renderMessage(snapshot.streamingMessage, width, true));
    }

    if (lines.length === 0) {
      return [style.gray("Welcome to pi-squared. Type a message to start chatting.")];
    }

    return lines;
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

function renderMessage(message: AgentMessage, width: number, streaming = false): string[] {
  const role = messageRole(message);
  const label = roleLabel(role);
  const color = roleColor(role, isAssistantError(message));
  const suffix = streaming ? "…" : "";
  const text = messageToText(message) || suffix;
  return wrapWithPrefix(`${color(label)}: `, text, width);
}

function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "you";
    case "assistant":
      return "pi2";
    case "toolResult":
      return "tool";
    default:
      return role;
  }
}

function roleColor(role: string, error: boolean): (text: string) => string {
  if (error) return style.red;
  switch (role) {
    case "user":
      return style.green;
    case "assistant":
      return style.cyan;
    case "toolResult":
      return style.magenta;
    default:
      return style.gray;
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
