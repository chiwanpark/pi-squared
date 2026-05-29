/** Shared diff computation utilities for the edit tool. */

export interface Edit {
  oldText: string;
  newText: string;
}

export interface AppliedEditsResult {
  baseContent: string;
  newContent: string;
}

export interface EditDiffResult {
  diff: string;
  firstChangedLine: number | undefined;
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

interface MatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
}

function findText(content: string, oldText: string): MatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  if (fuzzyOldText.length === 0) return 0;
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function notFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
    );
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
  );
}

function duplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  );
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): AppliedEditsResult {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i += 1) {
    if ((normalizedEdits[i]?.oldText ?? "").length === 0) {
      throw new Error(
        normalizedEdits.length === 1
          ? `oldText must not be empty in ${path}.`
          : `edits[${i}].oldText must not be empty in ${path}.`,
      );
    }
  }

  const usesFuzzy = normalizedEdits.some((edit) => findText(normalizedContent, edit.oldText).usedFuzzyMatch);
  const baseContent = usesFuzzy ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
  const matchedEdits: MatchedEdit[] = [];

  for (let i = 0; i < normalizedEdits.length; i += 1) {
    const edit = normalizedEdits[i]!;
    const match = findText(baseContent, edit.oldText);
    if (!match.found) throw notFoundError(path, i, normalizedEdits.length);

    const occurrences = countOccurrences(baseContent, edit.oldText);
    if (occurrences > 1) throw duplicateError(path, i, normalizedEdits.length, occurrences);

    matchedEdits.push({ editIndex: i, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i += 1) {
    const previous = matchedEdits[i - 1]!;
    const current = matchedEdits[i]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  let newContent = baseContent;
  for (let i = matchedEdits.length - 1; i >= 0; i -= 1) {
    const edit = matchedEdits[i]!;
    newContent =
      newContent.slice(0, edit.matchIndex) + edit.newText + newContent.slice(edit.matchIndex + edit.matchLength);
  }

  if (baseContent === newContent) {
    throw new Error(
      normalizedEdits.length === 1
        ? `No changes made to ${path}. The replacement produced identical content.`
        : `No changes made to ${path}. The replacements produced identical content.`,
    );
  }

  return { baseContent, newContent };
}

interface DiffPart {
  value: string[];
  added?: boolean;
  removed?: boolean;
}

function splitForDiff(content: string): string[] {
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function lineDiff(oldLines: string[], newLines: string[]): DiffPart[] {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const parts: DiffPart[] = [];
  const push = (part: DiffPart): void => {
    const last = parts[parts.length - 1];
    if (last && last.added === part.added && last.removed === part.removed) last.value.push(...part.value);
    else parts.push(part);
  };

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      push({ value: [oldLines[i] ?? ""] });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push({ value: [oldLines[i] ?? ""], removed: true });
      i += 1;
    } else {
      push({ value: [newLines[j] ?? ""], added: true });
      j += 1;
    }
  }
  while (i < m) push({ value: [oldLines[i++] ?? ""], removed: true });
  while (j < n) push({ value: [newLines[j++] ?? ""], added: true });
  return parts;
}

export function generateDiffString(
  oldContent: string,
  newContent: string,
  _contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const oldLines = splitForDiff(oldContent);
  const newLines = splitForDiff(newContent);
  const parts = lineDiff(oldLines, newLines);
  const maxLineNum = Math.max(oldLines.length, newLines.length, 1);
  const lineNumWidth = String(maxLineNum).length;
  const output: string[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;
  let firstChangedLine: number | undefined;

  for (const part of parts) {
    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;
      for (const line of part.value) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
          newLineNum += 1;
        } else {
          output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum += 1;
        }
      }
      continue;
    }

    for (const line of part.value) {
      output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
      oldLineNum += 1;
      newLineNum += 1;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

export function generateUnifiedPatch(path: string, oldContent: string, newContent: string): string {
  const parts = lineDiff(splitForDiff(oldContent), splitForDiff(newContent));
  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const part of parts) {
    const prefix = part.added ? "+" : part.removed ? "-" : " ";
    for (const line of part.value) lines.push(`${prefix}${line}`);
  }
  return `${lines.join("\n")}\n`;
}
