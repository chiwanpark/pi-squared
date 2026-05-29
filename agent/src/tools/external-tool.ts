import { spawnSync } from "node:child_process";

export function findExecutable(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const result = spawnSync(
      process.platform === "win32" ? "where" : "command",
      process.platform === "win32" ? [candidate] : ["-v", candidate],
      {
        encoding: "utf-8",
        shell: process.platform !== "win32",
        timeout: 2000,
        windowsHide: true,
      },
    );
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim().split(/\r?\n/)[0];
  }
  return undefined;
}
