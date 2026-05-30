import { readFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { AgentStatusSnapshot } from "../runtime/status-store.js";
import { drawBox } from "./box.js";
import { style } from "./theme.js";

const PACKAGE_VERSION = getPackageVersion();

function getPackageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" ? packageJson.version : "dev";
  } catch {
    return "dev";
  }
}

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function renderWelcome(width: number, snapshot: AgentStatusSnapshot, cwd: string): string[] {
  const cwdName = basename(cwd);
  const contents = [
    ` ${style.dimGray(">_")} ${style.bold("Pi Squared")} ${style.dimGray(`(v${PACKAGE_VERSION})`)}`,
    "",
    ` ${style.dimGray("model:".padEnd(11))}${snapshot.model.id} ${snapshot.thinkingLevel}${style.accent("  /model")}${style.dimGray(" to change")}`,
    ` ${style.dimGray("directory:".padEnd(11))}~/${cwdName}`,
  ];
  const preferredContentWidth = Math.max(24, ...contents.map((line) => visibleWidth(line))) + 1;

  return drawBox(contents, {
    indent: " ",
    paddingX: 0,
    maxWidth: Math.max(width, 5),
    minContentWidth: 2,
    preferredContentWidth,
  });
}
