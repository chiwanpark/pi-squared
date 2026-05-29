import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Static, Type } from "typebox";

import { withFileMutationQueue } from "../file-mutation-queue.js";
import { resolveToCwd } from "../path-utils.js";

const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  mkdir: async (dir) => {
    await fsMkdir(dir, { recursive: true });
  },
};

export interface WriteToolOptions {
  operations?: WriteOperations;
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema, undefined> {
  const ops = options?.operations ?? defaultWriteOperations;
  return {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, { path, content }, signal) => {
      const absolutePath = resolveToCwd(path, cwd);
      const dir = dirname(absolutePath);
      return withFileMutationQueue(absolutePath, async () => {
        const throwIfAborted = (): void => {
          if (signal?.aborted) throw new Error("Operation aborted");
        };

        throwIfAborted();
        await ops.mkdir(dir);
        throwIfAborted();
        await ops.writeFile(absolutePath, content);
        throwIfAborted();

        return {
          content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
          details: undefined,
        };
      });
    },
  };
}
