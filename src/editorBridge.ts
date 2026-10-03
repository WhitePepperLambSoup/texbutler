// Single bridge between panels and the main Monaco editor.
//
// Panels used to dispatch `tb:goto-line` / `tb:reveal` / `tb:insert-text`
// window events and guess how long the file switch takes (setTimeout 60–250
// ms). A jump to a not-yet-open file could land in the previous model. Here a
// reveal request is parked until the editor actually shows that file's model.

import type { editor as MonacoEditor } from "monaco-editor";
import { useProjectStore } from "./store/projectStore";

type CodeEditor = MonacoEditor.IStandaloneCodeEditor;

let current: CodeEditor | null = null;
let pending: { file: string | null; line: number; col: number } | null = null;

function modelShows(ed: CodeEditor, file: string | null): boolean {
  if (!file) return true;
  const model = ed.getModel();
  if (!model) return false;
  const path = model.uri.path.replace(/^\/+/, "");
  const want = file.replace(/\\/g, "/").replace(/^\/+/, "");
  return path === want || path.endsWith(`/${want}`) || decodeURIComponent(path) === want;
}

function flush() {
  const ed = current;
  if (!ed || !pending || !modelShows(ed, pending.file)) return;
  const model = ed.getModel();
  if (!model) return;
  const line = Math.max(1, Math.min(pending.line, model.getLineCount()));
  const col = Math.max(1, Math.min(pending.col, model.getLineMaxColumn(line)));
  pending = null;
  ed.revealLineInCenter(line);
  ed.setPosition({ lineNumber: line, column: col });
  ed.focus();
}

/** Called by the editor component on mount; returns the unregister fn. */
export function registerEditor(ed: CodeEditor): () => void {
  current = ed;
  const sub = ed.onDidChangeModel(() => {
    // the new model's view is laid out on the next frame
    window.requestAnimationFrame(flush);
  });
  window.requestAnimationFrame(flush);
  return () => {
    sub.dispose();
    if (current === ed) current = null;
  };
}

export function activeEditor(): CodeEditor | null {
  return current;
}

/** Open `file` (if given) and move the cursor to `line`. */
export async function revealLocation(file: string | null | undefined, line = 1, col = 1): Promise<void> {
  const target = file ?? useProjectStore.getState().activeTab;
  pending = { file: target ?? null, line, col };
  if (target && useProjectStore.getState().activeTab !== target) {
    try {
      await useProjectStore.getState().openFile(target);
    } catch {
      pending = null;
      throw new Error(`cannot open ${target}`);
    }
  }
  window.requestAnimationFrame(flush);
}

/** Replace the selection (or insert at the cursor) in the main editor. */
export function insertText(text: string, source = "insert"): boolean {
  const ed = current;
  if (!ed || !text) return false;
  const sel = ed.getSelection();
  if (!sel) return false;
  ed.executeEdits(source, [{ range: sel, text, forceMoveMarkers: true }]);
  ed.pushUndoStop();
  ed.focus();
  return true;
}

export function selectedText(): string {
  const ed = current;
  const sel = ed?.getSelection();
  if (!ed || !sel || sel.isEmpty()) return "";
  return ed.getModel()?.getValueInRange(sel) ?? "";
}

export function cursorLine(): number {
  return current?.getPosition()?.lineNumber ?? 1;
}
