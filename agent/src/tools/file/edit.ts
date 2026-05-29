import type { AgentTool } from "@earendil-works/pi-agent-core";
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { type Static, Type } from "typebox";

import { withFileMutationQueue } from "../file-mutation-queue.js";
import { resolveToCwd } from "../path-utils.js";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type Edit,
} from "./edit-diff.js";

const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({
      description:
        "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
    }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
  },
  { additionalProperties: false },
);

const editSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
    edits: Type.Array(replaceEditSchema, {
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.",
    }),
  },
  { additionalProperties: false },
);

export type EditToolInput = Static<typeof editSchema>;

type LegacyEditToolInput = EditToolInput & { oldText?: unknown; newText?: unknown };

export interface EditToolDetails {
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
  operations?: EditOperations;
}

function prepareEditArguments(input: unknown): EditToolInput {
  if (!input || typeof input !== "object") return input as EditToolInput;

  const args = { ...(input as Record<string, unknown>) };
  if (typeof args.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {
      // Leave validation to the schema/execute path.
    }
  }

  const legacy = args as LegacyEditToolInput;
  if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") return args as EditToolInput;

  const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
  edits.push({ oldText: legacy.oldText, newText: legacy.newText });
  delete args.oldText;
  delete args.newText;
  return { ...args, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  return { path: input.path, edits: input.edits };
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema, EditToolDetails> {
  const ops = options?.operations ?? defaultEditOperations;
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit a file by replacing one or more exact text blocks. oldText must match uniquely in the original file. Preserves existing line endings.",
    parameters: editSchema,
    prepareArguments: prepareEditArguments,
    executionMode: "sequential",
    execute: async (_toolCallId, input, signal) => {
      const { path, edits } = validateEditInput(input);
      const absolutePath = resolveToCwd(path, cwd);

      return withFileMutationQueue(absolutePath, async () => {
        const throwIfAborted = (): void => {
          if (signal?.aborted) throw new Error("Operation aborted");
        };

        throwIfAborted();
        try {
          await ops.access(absolutePath);
        } catch (error) {
          throwIfAborted();
          const errorMessage =
            error instanceof Error && "code" in error
              ? `Error code: ${(error as { code?: string }).code}`
              : String(error);
          throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
        }
        throwIfAborted();

        const buffer = await ops.readFile(absolutePath);
        const rawContent = buffer.toString("utf-8");
        throwIfAborted();

        const { bom, text: content } = stripBom(rawContent);
        const originalEnding = detectLineEnding(content);
        const normalizedContent = normalizeToLF(content);
        const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
        throwIfAborted();

        const finalContent = bom + restoreLineEndings(newContent, originalEnding);
        await ops.writeFile(absolutePath, finalContent);
        throwIfAborted();

        const diffResult = generateDiffString(baseContent, newContent);
        const patch = generateUnifiedPatch(path, baseContent, newContent);
        const details: EditToolDetails = { diff: diffResult.diff, patch };
        if (diffResult.firstChangedLine !== undefined) details.firstChangedLine = diffResult.firstChangedLine;
        return {
          content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
          details,
        };
      });
    },
  };
}
