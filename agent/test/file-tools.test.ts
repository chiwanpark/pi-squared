import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "../src/tools/file/index.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi2-file-tools-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return first?.text ?? "";
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

describe("file tools", () => {
  it("writes, reads, edits, lists, finds, and greps files", async () => {
    const write = createWriteTool(cwd);
    const read = createReadTool(cwd);
    const edit = createEditTool(cwd);
    const ls = createLsTool(cwd);

    await write.execute("write-1", { path: "src/example.ts", content: "export const value = 1;\n" });
    expect(await readFile(join(cwd, "src/example.ts"), "utf-8")).toBe("export const value = 1;\n");

    const readResult = await read.execute("read-1", { path: "src/example.ts" });
    expect(textContent(readResult)).toContain("export const value = 1");

    const editResult = await edit.execute("edit-1", {
      path: "src/example.ts",
      edits: [{ oldText: "value = 1", newText: "value = 2" }],
    });
    expect(editResult.details.diff).toContain("value = 2");
    expect(await readFile(join(cwd, "src/example.ts"), "utf-8")).toBe("export const value = 2;\n");

    const lsResult = await ls.execute("ls-1", { path: "." });
    expect(textContent(lsResult)).toContain("src/");

    const fakeFd = join(cwd, "fake-fd.js");
    await writeExecutable(fakeFd, "#!/usr/bin/env node\nconsole.log('src/example.ts');\n");
    const find = createFindTool(cwd, { fdPath: fakeFd });
    const findResult = await find.execute("find-1", { pattern: "**/*.ts" });
    expect(textContent(findResult)).toContain("src/example.ts");

    const fakeRg = join(cwd, "fake-rg.js");
    await writeExecutable(
      fakeRg,
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(
        JSON.stringify({
          type: "match",
          data: {
            path: { text: join(cwd, "src/example.ts") },
            line_number: 1,
            lines: { text: "export const value = 2;\n" },
          },
        }),
      )});\n`,
    );
    const grep = createGrepTool(cwd, { rgPath: fakeRg });
    const grepResult = await grep.execute("grep-1", { pattern: "value = 2", literal: true, path: "src" });
    expect(textContent(grepResult)).toContain("example.ts:1: export const value = 2;");
  });

  it("requires edit oldText to be unique", async () => {
    await writeFile(join(cwd, "duplicates.txt"), "same\nsame\n");
    const edit = createEditTool(cwd);

    await expect(
      edit.execute("edit-duplicates", {
        path: "duplicates.txt",
        edits: [{ oldText: "same", newText: "other" }],
      }),
    ).rejects.toThrow("must be unique");
  });
});
