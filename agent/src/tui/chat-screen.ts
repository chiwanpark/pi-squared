import { homedir } from "node:os";
import {
  Editor,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

export interface ScreenPanel {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { isAssistantError, messageRole, messageToText } from "../runtime/messages.js";
import type { PiSquaredAgentRuntime } from "../runtime/pi-agent.js";
import { editorTheme, style } from "./theme.js";

export interface ChatScreenOptions {
  onSubmit: (text: string) => void;
}

export class ChatScreen implements Component {
  readonly editor: Editor;
  private panel: ScreenPanel | null = null;

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
    this.editor.borderColor =
      snapshot.phase === "idle" ? style.cyan : snapshot.phase === "error" ? style.red : style.yellow;

    const editorLines = this.editor.render(safeWidth);
    const footer = this.renderFooter(safeWidth);
    const messageLines = this.renderMessages(safeWidth);
    const errorLines = snapshot.lastError ? wrapWithPrefix(style.red("error: "), snapshot.lastError, safeWidth) : [];
    const noticeLines = this.renderNotice(safeWidth);
    const panelLines = this.panel ? this.panel.render(safeWidth) : [];

    // Emit the full message history rather than slicing to the visible viewport.
    // Truncating here would prevent older lines from ever being written to the
    // terminal, leaving tmux (and other terminals' native scrollback) with
    // nothing to scroll. The underlying TUI handles natural terminal scrolling
    // when total content exceeds the terminal height, pushing older lines into
    // the scrollback buffer where the user (and tmux copy mode) can reach them.
    return [...messageLines, ...noticeLines, ...errorLines, ...panelLines, ...editorLines, ...footer, ""].map((line) =>
      truncateToWidth(line, safeWidth, ""),
    );
  }

  handleInput(data: string): void {
    this.editor.handleInput(data);
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  private renderFooter(width: number): string[] {
    const snapshot = this.runtime.status.getSnapshot();
    const provider = snapshot.model.provider;
    const model = snapshot.model.id;
    const thinking = ` ${snapshot.thinkingLevel}`;
    const cwd = formatCwd(this.runtime.getCwd());
    const phase = formatPhase(snapshot.phase);
    const title = `${style.gray("(")}${style.gray(provider)}${style.gray(")")} ${style.bold(style.white(model))}${style.gray(thinking)} ${style.gray("·")} ${style.gray(cwd)} ${style.gray("·")} ${phase}`;
    return [truncateToWidth(title, width, "")];
  }

  private renderNotice(width: number): string[] {
    const snapshot = this.runtime.status.getSnapshot();
    const notice = snapshot.lastNotice;
    if (!notice) return [];
    const color = notice.level === "error" ? style.red : notice.level === "warn" ? style.yellow : style.cyan;
    return wrapWithPrefix(color(`${notice.level}: `), notice.message, width);
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

function formatCwd(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
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
