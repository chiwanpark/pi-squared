import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { type Static, Type } from "typebox";

import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type TruncationResult } from "../bash/truncate.js";
import { findExecutable } from "../external-tool.js";
import { pathExists, resolveToCwd } from "../path-utils.js";
import { toPosixPath } from "./glob.js";

const findSchema = Type.Object({
  pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
  path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
  truncation?: TruncationResult;
  resultLimitReached?: number;
}

export interface FindOperations {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

export interface FindToolOptions {
  operations?: FindOperations;
  fdPath?: string;
}

export function createFindTool(
  cwd: string,
  options?: FindToolOptions,
): AgentTool<typeof findSchema, FindToolDetails | undefined> {
  const customOps = options?.operations;
  return {
    name: "find",
    label: "find",
    description: `Search for files by glob pattern using fd. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: findSchema,
    execute: async (_toolCallId, { pattern, path: searchDir, limit }, signal) => {
      if (signal?.aborted) throw new Error("Operation aborted");
      const searchPath = resolveToCwd(searchDir || ".", cwd);
      const effectiveLimit = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));

      if (customOps) {
        if (!(await customOps.exists(searchPath))) throw new Error(`Path not found: ${searchPath}`);
        const found = await customOps.glob(pattern, searchPath, {
          ignore: ["**/node_modules/**", "**/.git/**"],
          limit: effectiveLimit,
        });
        return formatResults(relativizeResults(found, searchPath), effectiveLimit);
      }

      if (!(await pathExists(searchPath))) throw new Error(`Path not found: ${searchPath}`);
      const fdPath = options?.fdPath ?? findExecutable(["fd", "fdfind"]);
      if (!fdPath) throw new Error("fd is not available. Install fd (or fdfind) to use the find tool.");

      const args = buildFdArgs(pattern, searchPath, effectiveLimit);
      const lines = await runLineCommand(fdPath, args, signal, "fd");
      return formatResults(relativizeResults(lines, searchPath), effectiveLimit);
    },
  };
}

function buildFdArgs(pattern: string, searchPath: string, limit: number): string[] {
  const args = [
    "--glob",
    "--color=never",
    "--hidden",
    "--no-require-git",
    "--exclude",
    ".git",
    "--exclude",
    "node_modules",
    "--max-results",
    String(limit),
  ];

  let effectivePattern = pattern;
  if (pattern.includes("/")) {
    args.push("--full-path");
    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") effectivePattern = `**/${pattern}`;
  }

  args.push("--", effectivePattern, searchPath);
  return args;
}

function runLineCommand(
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
  name: string,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const rl = createInterface({ input: child.stdout });
    const lines: string[] = [];
    let stderr = "";
    let settled = false;

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
    const onAbort = (): void => {
      if (!child.killed) child.kill();
      settle(() => reject(new Error("Operation aborted")));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    rl.on("line", (line) => lines.push(line));
    child.on("error", (error) => settle(() => reject(new Error(`Failed to run ${name}: ${error.message}`))));
    child.on("close", (code) => {
      if (signal?.aborted) {
        settle(() => reject(new Error("Operation aborted")));
        return;
      }
      if (code !== 0 && lines.length === 0) {
        settle(() => reject(new Error(stderr.trim() || `${name} exited with code ${code}`)));
        return;
      }
      settle(() => resolve(lines));
    });
  });
}

function relativizeResults(results: string[], searchPath: string): string[] {
  const output: string[] = [];
  for (const raw of results) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) continue;
    const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
    let relativePath = path.isAbsolute(line) ? path.relative(searchPath, line) : line;
    if (relativePath.startsWith(searchPath)) relativePath = relativePath.slice(searchPath.length + 1);
    if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
    output.push(toPosixPath(relativePath));
  }
  return output;
}

function formatResults(results: string[], effectiveLimit: number) {
  if (results.length === 0)
    return { content: [{ type: "text" as const, text: "No files found matching pattern" }], details: undefined };

  const resultLimitReached = results.length >= effectiveLimit;
  const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  const details: FindToolDetails = {};
  const notices: string[] = [];
  if (resultLimitReached) {
    notices.push(
      `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
    );
    details.resultLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  return {
    content: [{ type: "text" as const, text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}
