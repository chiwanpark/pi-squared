/**
 * Shell configuration, environment helpers, and process-kill utilities.
 *
 * Ported from @earendil-works/pi-coding-agent.
 * Simplification: getShellEnv() returns process.env as-is without prepending a
 * pi-specific bin directory.
 */

import { existsSync } from "node:fs";
import { spawn, spawnSync } from "child_process";

/** Find bash executable on PATH (cross-platform). */
function findBashOnPath(): string | null {
  if (process.platform === "win32") {
    try {
      const result = spawnSync("where", ["bash.exe"], {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status === 0 && result.stdout) {
        const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
        if (firstMatch && existsSync(firstMatch)) return firstMatch;
      }
    } catch {
      // ignore
    }
    return null;
  }
  try {
    const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) return firstMatch;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 *
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): { shell: string; args: string[] } {
  if (customShellPath) {
    if (existsSync(customShellPath)) return { shell: customShellPath, args: ["-c"] };
    throw new Error(`Custom shell path not found: ${customShellPath}`);
  }

  if (process.platform === "win32") {
    const paths: string[] = [];
    const programFiles = process.env["ProgramFiles"];
    if (programFiles) paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (programFilesX86) paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
    for (const p of paths) {
      if (existsSync(p)) return { shell: p, args: ["-c"] };
    }
    const bashOnPath = findBashOnPath();
    if (bashOnPath) return { shell: bashOnPath, args: ["-c"] };
    throw new Error(
      `No bash shell found. Options:\n` +
        `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
        `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
        `  3. Set shellPath in settings.json\n\n` +
        `Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
    );
  }

  // Unix: /bin/bash → bash on PATH → sh
  if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
  const bashOnPath = findBashOnPath();
  if (bashOnPath) return { shell: bashOnPath, args: ["-c"] };
  return { shell: "sh", args: ["-c"] };
}

/** Return the current process environment for spawned commands. */
export function getShellEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

/**
 * Detached child processes are tracked so they can be cleaned up when the
 * parent receives SIGHUP/SIGTERM.
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
  trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
  trackedDetachedChildPids.delete(pid);
}

/** Kill a process and its entire process group (cross-platform). */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
    } catch {
      // ignore
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // process already dead
      }
    }
  }
}
