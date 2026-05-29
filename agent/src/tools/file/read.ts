import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { type Static, Type } from "typebox";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "../bash/truncate.js";
import { resolveReadPathAsync } from "../path-utils.js";

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
  truncation?: TruncationResult;
}

export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
  readFile: (path) => fsReadFile(path),
  access: (path) => fsAccess(path, constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeType,
};

export interface ReadToolOptions {
  operations?: ReadOperations;
}

async function detectSupportedImageMimeType(path: string): Promise<string | null> {
  const buffer = await fsReadFile(path);
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")
    return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  return null;
}

export function createReadTool(
  cwd: string,
  options?: ReadToolOptions,
): AgentTool<typeof readSchema, ReadToolDetails | undefined> {
  const ops = options?.operations ?? defaultReadOperations;
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
    parameters: readSchema,
    execute: async (_toolCallId, { path, offset, limit }, signal) => {
      if (signal?.aborted) throw new Error("Operation aborted");

      const absolutePath = await resolveReadPathAsync(path, cwd);
      await ops.access(absolutePath);
      if (signal?.aborted) throw new Error("Operation aborted");

      const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
      if (signal?.aborted) throw new Error("Operation aborted");

      if (mimeType) {
        const buffer = await ops.readFile(absolutePath);
        const content: (TextContent | ImageContent)[] = [
          { type: "text", text: `Read image file [${mimeType}]` },
          { type: "image", data: buffer.toString("base64"), mimeType },
        ];
        return { content, details: undefined };
      }

      const buffer = await ops.readFile(absolutePath);
      const textContent = buffer.toString("utf-8");
      const allLines = textContent.split("\n");
      const startLine = offset === undefined ? 0 : Math.max(0, Math.floor(offset) - 1);
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
      }

      let selectedContent: string;
      let userLimitedLines: number | undefined;
      if (limit !== undefined) {
        const safeLimit = Math.max(0, Math.floor(limit));
        const endLine = Math.min(startLine + safeLimit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }

      const truncation = truncateHead(selectedContent);
      let outputText: string;
      let details: ReadToolDetails | undefined;
      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
        details = { truncation };
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = `${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length}${truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : ""}. Use offset=${nextOffset} to continue.]`;
        details = { truncation };
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText = truncation.content;
      }

      return { content: [{ type: "text", text: outputText }], details };
    },
  };
}
