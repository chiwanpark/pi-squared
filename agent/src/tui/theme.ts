import type { EditorTheme } from "@earendil-works/pi-tui";

const ESC = "\u001b[";

function code(open: number, close: number): (text: string) => string {
  return (text) => `${ESC}${open}m${text}${ESC}${close}m`;
}

export const style = {
  bold: code(1, 22),
  dim: code(2, 22),
  cyan: code(36, 39),
  green: code(32, 39),
  yellow: code(33, 39),
  red: code(31, 39),
  magenta: code(35, 39),
  gray: code(90, 39),
};

export const editorTheme: EditorTheme = {
  borderColor: style.cyan,
  selectList: {
    selectedPrefix: style.cyan,
    selectedText: style.cyan,
    description: style.gray,
    scrollInfo: style.gray,
    noMatch: style.yellow,
  },
};
