import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const NARROW_NO_BREAK_SPACE = "\u202F";

function normalizePathInput(filePath: string): string {
  let value = filePath.trim().replace(/[\u00a0\u202f]/g, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(homedir(), value.slice(2));
  return value;
}

function tryMacOSScreenshotPath(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
  return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
  return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveToCwd(filePath: string, cwd: string): string {
  const normalized = normalizePathInput(filePath);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
  const resolved = resolveToCwd(filePath, cwd);
  if (await pathExists(resolved)) return resolved;

  const variants = [
    tryMacOSScreenshotPath(resolved),
    tryNFDVariant(resolved),
    tryCurlyQuoteVariant(resolved),
    tryCurlyQuoteVariant(tryNFDVariant(resolved)),
  ];

  for (const variant of variants) {
    if (variant !== resolved && (await pathExists(variant))) return variant;
  }

  return resolved;
}

export function resolveReadPath(filePath: string, cwd: string): string {
  const resolved = resolveToCwd(filePath, cwd);
  if (fileExists(resolved)) return resolved;

  const variants = [
    tryMacOSScreenshotPath(resolved),
    tryNFDVariant(resolved),
    tryCurlyQuoteVariant(resolved),
    tryCurlyQuoteVariant(tryNFDVariant(resolved)),
  ];

  for (const variant of variants) {
    if (variant !== resolved && fileExists(variant)) return variant;
  }

  return resolved;
}
