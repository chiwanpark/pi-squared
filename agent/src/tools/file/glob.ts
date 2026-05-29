import { relative, sep } from "node:path";

export function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = toPosixPath(pattern);
  let regex = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    const next = normalized[i + 1];
    if (char === "*" && next === "*") {
      const after = normalized[i + 2];
      if (after === "/") {
        regex += "(?:.*/)?";
        i += 2;
      } else {
        regex += ".*";
        i += 1;
      }
    } else if (char === "*") {
      regex += "[^/]*";
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegex(char);
    }
  }
  regex += "$";
  return new RegExp(regex);
}

export function matchesGlob(posixRelativePath: string, pattern: string): boolean {
  const normalizedPattern = toPosixPath(pattern);
  const candidates = normalizedPattern.includes("/") ? [posixRelativePath] : [posixRelativePath.split("/").pop() ?? ""];
  const regex = globToRegExp(normalizedPattern);
  return candidates.some((candidate) => regex.test(candidate));
}

export function relativePosix(from: string, to: string): string {
  return toPosixPath(relative(from, to));
}

export function shouldSkipDirectory(name: string): boolean {
  return name === ".git" || name === "node_modules";
}
