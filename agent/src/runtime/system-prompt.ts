import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface BuildSystemPromptOptions {
  /** Working directory. */
  cwd: string;
  /** Custom guidelines to add as a dedicated section. */
  guidelines?: string[] | undefined;
  /** Extra context file paths (relative to cwd) to include. */
  extraContextFiles?: string[] | undefined;
}

const STATIC_SYSTEM_PROMPT = `You are pi-squared, an interactive coding assistant running in a terminal. Be concise, practical, and honest about limitations. You help users by reading files, editing code, writing new files, and executing commands.`;

export const DEFAULT_CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".pi-squared/AGENTS.md"];

export async function buildSystemPrompt(options: BuildSystemPromptOptions): Promise<string> {
  const parts: string[] = [];

  // Static prompt (always included)
  parts.push(STATIC_SYSTEM_PROMPT);

  // Custom guidelines (only when provided)
  if (options.guidelines && options.guidelines.length > 0) {
    parts.push(`\n# Guidelines\n${options.guidelines.join("\n")}`);
  }

  // Context files
  const contextFiles = await loadContextFiles(options.cwd, options.extraContextFiles);
  if (contextFiles.length > 0) {
    parts.push("\nProject-specific instructions and guidelines are as follows:\n");
    for (const { path, content } of contextFiles) {
      parts.push(`<instructions path="${path}">\n${content}\n</instructions>`);
    }
  }

  // Other contexts
  parts.push(`\n# Current Date\n${new Date().toISOString()}`);
  parts.push(`\n# Current Working Directory\n${options.cwd}`);

  return parts.join("\n");
}

async function loadContextFiles(cwd: string, extraFiles?: string[]): Promise<Array<{ path: string; content: string }>> {
  const toCheck = [...DEFAULT_CONTEXT_FILES, ...(extraFiles ?? [])];
  const results: Array<{ path: string; content: string }> = [];

  for (const file of toCheck) {
    try {
      const content = await readFile(join(cwd, file), "utf-8");
      const trimmed = content.trim();
      if (trimmed.length > 0) {
        results.push({ path: file, content: trimmed });
      }
    } catch {
      // Ignore missing or unreadable files.
    }
  }

  return results;
}
