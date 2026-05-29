import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawn } from "node:child_process";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { type Static, Type } from "typebox";

import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateHead,
  truncateLine,
  type TruncationResult,
} from "../bash/truncate.js";
import { findExecutable } from "../external-tool.js";
import { resolveToCwd } from "../path-utils.js";

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  literal: Type.Optional(
    Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
  ),
  context: Type.Optional(
    Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
  truncation?: TruncationResult;
  matchLimitReached?: number;
  linesTruncated?: boolean;
}

export interface GrepOperations {
  isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
  readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
  isDirectory: async (p) => (await fsStat(p)).isDirectory(),
  readFile: (p) => fsReadFile(p, "utf-8"),
};

export interface GrepToolOptions {
  operations?: GrepOperations;
  rgPath?: string;
}

interface RgMatch {
  filePath: string;
  lineNumber: number;
  lineText?: string;
}

export function createGrepTool(
  cwd: string,
  options?: GrepToolOptions,
): AgentTool<typeof grepSchema, GrepToolDetails | undefined> {
  const ops = options?.operations ?? defaultGrepOperations;
  return {
    name: "grep",
    label: "grep",
    description: `Search file contents for a pattern using ripgrep. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    parameters: grepSchema,
    execute: async (_toolCallId, { pattern, path: searchDir, glob, ignoreCase, literal, context, limit }, signal) => {
      if (signal?.aborted) throw new Error("Operation aborted");

      const rgPath = options?.rgPath ?? findExecutable(["rg"]);
      if (!rgPath) throw new Error("ripgrep (rg) is not available. Install ripgrep to use the grep tool.");

      const searchPath = resolveToCwd(searchDir || ".", cwd);
      let isDirectory: boolean;
      try {
        isDirectory = await ops.isDirectory(searchPath);
      } catch {
        throw new Error(`Path not found: ${searchPath}`);
      }

      const contextValue = Math.max(0, Math.floor(context ?? 0));
      const effectiveLimit = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
      const result = await runRipgrep(
        rgPath,
        buildRgArgs({ pattern, searchPath, glob, ignoreCase, literal }),
        effectiveLimit,
        signal,
      );

      if (result.matches.length === 0)
        return { content: [{ type: "text", text: "No matches found" }], details: undefined };

      const fileCache = new Map<string, string[]>();
      const getFileLines = async (filePath: string): Promise<string[]> => {
        let lines = fileCache.get(filePath);
        if (!lines) {
          try {
            const content = await ops.readFile(filePath);
            lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
          } catch {
            lines = [];
          }
          fileCache.set(filePath, lines);
        }
        return lines;
      };

      const outputLines: string[] = [];
      let linesTruncated = false;
      for (const match of result.matches) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (contextValue === 0 && match.lineText !== undefined) {
          const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
          const { text, wasTruncated } = truncateLine(sanitized);
          if (wasTruncated) linesTruncated = true;
          outputLines.push(`${formatPath(searchPath, match.filePath, isDirectory)}:${match.lineNumber}: ${text}`);
          continue;
        }

        const lines = await getFileLines(match.filePath);
        if (!lines.length) {
          outputLines.push(
            `${formatPath(searchPath, match.filePath, isDirectory)}:${match.lineNumber}: (unable to read file)`,
          );
          continue;
        }
        const start = Math.max(1, match.lineNumber - contextValue);
        const end = Math.min(lines.length, match.lineNumber + contextValue);
        for (let current = start; current <= end; current += 1) {
          const { text, wasTruncated } = truncateLine(lines[current - 1] ?? "");
          if (wasTruncated) linesTruncated = true;
          const separator = current === match.lineNumber ? ":" : "-";
          outputLines.push(
            `${formatPath(searchPath, match.filePath, isDirectory)}${separator}${current}${separator} ${text}`,
          );
        }
      }

      const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: GrepToolDetails = {};
      const notices: string[] = [];
      if (result.matchLimitReached) {
        notices.push(
          `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
        );
        details.matchLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        details.linesTruncated = true;
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

      return {
        content: [{ type: "text", text: output }],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}

function buildRgArgs(options: {
  pattern: string;
  searchPath: string;
  glob: string | undefined;
  ignoreCase: boolean | undefined;
  literal: boolean | undefined;
}): string[] {
  const args = [
    "--json",
    "--line-number",
    "--color=never",
    "--hidden",
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
  ];
  if (options.ignoreCase) args.push("--ignore-case");
  if (options.literal) args.push("--fixed-strings");
  if (options.glob) args.push("--glob", options.glob);
  args.push("--", options.pattern, options.searchPath);
  return args;
}

function runRipgrep(
  command: string,
  args: string[],
  limit: number,
  signal: AbortSignal | undefined,
): Promise<{ matches: RgMatch[]; matchLimitReached: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const rl = createInterface({ input: child.stdout });
    const matches: RgMatch[] = [];
    let stderr = "";
    let settled = false;
    let killedDueToLimit = false;
    let aborted = false;
    let matchLimitReached = false;

    const cleanup = (): void => {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const stopChild = (dueToLimit = false): void => {
      if (!child.killed) {
        killedDueToLimit = dueToLimit;
        child.kill();
      }
    };
    const onAbort = (): void => {
      aborted = true;
      stopChild();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    rl.on("line", (line) => {
      if (!line.trim() || matches.length >= limit) return;
      const event = parseRgEvent(line);
      if (event?.type !== "match") return;
      const filePath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      const lineText = event.data?.lines?.text;
      if (typeof filePath === "string" && typeof lineNumber === "number") {
        const match: RgMatch = { filePath, lineNumber };
        if (typeof lineText === "string") match.lineText = lineText;
        matches.push(match);
      }
      if (matches.length >= limit) {
        matchLimitReached = true;
        stopChild(true);
      }
    });

    child.on("error", (error) => settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`))));
    child.on("close", (code) => {
      if (aborted || signal?.aborted) {
        settle(() => reject(new Error("Operation aborted")));
        return;
      }
      if (!killedDueToLimit && code !== 0 && code !== 1) {
        settle(() => reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`)));
        return;
      }
      settle(() => resolve({ matches, matchLimitReached }));
    });
  });
}

function parseRgEvent(
  line: string,
): { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } } | undefined {
  try {
    return JSON.parse(line) as {
      type?: string;
      data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
    };
  } catch {
    return undefined;
  }
}

function formatPath(root: string, filePath: string, isDirectory: boolean): string {
  if (!isDirectory) return path.basename(filePath);
  const relative = path.relative(root, filePath).replace(/\\/g, "/");
  return relative && !relative.startsWith("..") ? relative : path.basename(filePath);
}
