/**
 * Bash tool — executes shell commands and returns stdout+stderr.
 *
 * Ported from @earendil-works/pi-coding-agent. TUI rendering components have
 * been omitted; only the core execute logic is kept.
 */

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";

import { waitForChildProcess } from "./child-process.js";
import { OutputAccumulator } from "./output-accumulator.js";
import {
  getShellConfig,
  getShellEnv,
  killProcessTree,
  trackDetachedChildPid,
  untrackDetachedChildPid,
} from "./shell.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

type BashInput = Static<typeof bashSchema>;

// ---------------------------------------------------------------------------
// Details attached to each tool result
// ---------------------------------------------------------------------------

interface BashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

// ---------------------------------------------------------------------------
// Throttle constant for streaming updates
// ---------------------------------------------------------------------------

const UPDATE_THROTTLE_MS = 100;

// ---------------------------------------------------------------------------
// createBashTool
// ---------------------------------------------------------------------------

/**
 * Create a bash AgentTool that executes commands in `cwd`.
 */
export function createBashTool(cwd: string): AgentTool<typeof bashSchema, BashToolDetails | undefined> {
  return {
    name: "bash",
    label: "bash",
    description: [
      "Execute a bash command in the current working directory.",
      "Returns stdout and stderr.",
      `Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
      "If truncated, full output is saved to a temp file.",
      "Optionally provide a timeout in seconds.",
    ].join(" "),
    parameters: bashSchema,

    execute: async (
      _toolCallId: string,
      { command, timeout }: BashInput,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<BashToolDetails | undefined>,
    ): Promise<AgentToolResult<BashToolDetails | undefined>> => {
      const { shell, args } = getShellConfig();

      // Verify the working directory exists before spawning.
      try {
        await fsAccess(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }

      if (signal?.aborted) throw new Error("aborted");

      const child = spawn(shell, [...args, command], {
        cwd,
        detached: process.platform !== "win32",
        env: getShellEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      if (child.pid) trackDetachedChildPid(child.pid);

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const onAbort = () => {
        if (child.pid) killProcessTree(child.pid);
      };

      // -----------------------------------------------------------------------
      // Output accumulation + streaming updates
      // -----------------------------------------------------------------------

      const output = new OutputAccumulator({ tempFilePrefix: "pi2-bash" });

      let updateTimer: NodeJS.Timeout | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;

      const emitOutputUpdate = () => {
        if (!onUpdate || !updateDirty) return;
        updateDirty = false;
        lastUpdateAt = Date.now();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        onUpdate({
          content: [{ type: "text", text: snapshot.content || "" }],
          details: snapshot.truncation.truncated
            ? {
                truncation: snapshot.truncation,
                ...(snapshot.fullOutputPath !== undefined && { fullOutputPath: snapshot.fullOutputPath }),
              }
            : undefined,
        });
      };

      const clearUpdateTimer = () => {
        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }
      };

      const scheduleOutputUpdate = () => {
        if (!onUpdate) return;
        updateDirty = true;
        const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
        if (delay <= 0) {
          clearUpdateTimer();
          emitOutputUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitOutputUpdate();
        }, delay);
      };

      if (onUpdate) onUpdate({ content: [], details: undefined });

      child.stdout?.on("data", (data: Buffer) => {
        output.append(data);
        scheduleOutputUpdate();
      });
      child.stderr?.on("data", (data: Buffer) => {
        output.append(data);
        scheduleOutputUpdate();
      });

      // -----------------------------------------------------------------------
      // Timeout + abort wiring
      // -----------------------------------------------------------------------

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (child.pid) killProcessTree(child.pid);
        }, timeout * 1000);
      }

      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      // -----------------------------------------------------------------------
      // Helpers
      // -----------------------------------------------------------------------

      const finishOutput = async () => {
        output.finish();
        clearUpdateTimer();
        emitOutputUpdate();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        await output.closeTempFile();
        return snapshot;
      };

      const formatOutput = (
        snapshot: ReturnType<OutputAccumulator["snapshot"]>,
        emptyText = "(no output)",
      ): { text: string; details: BashToolDetails | undefined } => {
        const { truncation } = snapshot;
        let text = snapshot.content || emptyText;
        let details: BashToolDetails | undefined;

        if (truncation.truncated) {
          details = {
            truncation,
            ...(snapshot.fullOutputPath !== undefined && { fullOutputPath: snapshot.fullOutputPath }),
          };
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;

          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(output.getLastLineBytes());
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
          } else if (truncation.truncatedBy === "lines") {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
          } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
          }
        }

        return { text, details };
      };

      const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

      // -----------------------------------------------------------------------
      // Execute and wait
      // -----------------------------------------------------------------------

      try {
        let exitCode: number | null;
        try {
          exitCode = await waitForChildProcess(child);

          if (signal?.aborted) throw new Error("aborted");
          if (timedOut) throw new Error(`timeout:${timeout}`);
        } catch (err) {
          const snapshot = await finishOutput();
          const { text } = formatOutput(snapshot, "");

          if (err instanceof Error && err.message === "aborted") {
            throw new Error(appendStatus(text, "Command aborted"));
          }
          if (err instanceof Error && err.message.startsWith("timeout:")) {
            const secs = err.message.split(":")[1];
            throw new Error(appendStatus(text, `Command timed out after ${secs} seconds`));
          }
          throw err;
        }

        const snapshot = await finishOutput();
        const { text, details } = formatOutput(snapshot);

        if (exitCode !== 0 && exitCode !== null) {
          throw new Error(appendStatus(text, `Command exited with code ${exitCode}`));
        }

        return { content: [{ type: "text", text }], details };
      } finally {
        if (child.pid) untrackDetachedChildPid(child.pid);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        clearUpdateTimer();
      }
    },
  };
}
