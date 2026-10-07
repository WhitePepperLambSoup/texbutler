// Project-wide rename of \label keys (with every \ref) and citation keys
// (with every \cite and the .bib entry). F2 in the editor goes through a
// Monaco rename provider; the labels view uses `renameKeyInteractive`.
import type { editor as MonacoEditor } from "monaco-editor";
import { api, type KeyKind } from "./api";
import { useProjectStore } from "./store/projectStore";
import { dialog, toast } from "./store/feedbackStore";
import { useI18n } from "./i18n";

type Monaco = typeof import("monaco-editor");

const t = (key: string, vars?: Record<string, string | number>) => useI18n.getState().t(key, vars);

// keep in sync with src-tauri/src/core/rename.rs
const LABEL_CMDS = new Set([
  "label", "ref", "eqref", "pageref", "autoref", "Autoref", "cref", "Cref", "nameref", "vref", "Vref", "vpageref",
  "labelcref", "subref", "cpageref", "Cpageref",
]);
const CITE_CMDS = new Set([
  "cite", "Cite", "citep", "citet", "Citep", "Citet", "citealp", "citealt", "citeauthor", "Citeauthor", "citeyear",
  "citeyearpar", "citenum", "nocite", "parencite", "Parencite", "textcite", "Textcite", "autocite", "Autocite",
  "footcite", "supercite", "fullcite", "smartcite", "Smartcite",
]);

export interface KeyHit {
  kind: KeyKind;
  key: string;
  /** 0-based [start, end) columns of the key on the line. */
  start: number;
  end: number;
}

/** Index of the first unescaped `%` (comment start) or the line length. */
function codeEnd(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "%") {
      let slashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) slashes++;
      if (slashes % 2 === 0) return i;
    }
  }
  return line.length;
}

/** The label / citation key under 0-based column `col`, if any. */
export function keyAt(line: string, col: number): KeyHit | null {
  const code = line.slice(0, codeEnd(line));
  const re = /\\([A-Za-z]+)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const cmd = m[1];
    const kind: KeyKind | null = LABEL_CMDS.has(cmd) ? "label" : CITE_CMDS.has(cmd) ? "cite" : null;
    if (!kind) continue;
    const argStart = m.index + m[0].length - 1 - m[2].length;
    let pos = argStart;
    for (const piece of m[2].split(",")) {
      const lead = piece.length - piece.trimStart().length;
      const key = piece.trim();
      const start = pos + lead;
      const end = start + key.length;
      if (key && col >= start && col <= end) return { kind, key, start, end };
      pos += piece.length + 1;
    }
  }
  return null;
}

/** Path of a main-editor model (the split view uses `split://` URIs). */
function modelFile(model: MonacoEditor.ITextModel): string | null {
  if (model.uri.scheme === "split") return null;
  return decodeURIComponent(model.uri.path.replace(/^\/+/, ""));
}

async function reloadChanged(files: string[]) {
  const st = useProjectStore.getState();
  for (const f of files) {
    if (st.tabs.some((tab) => tab.path === f)) await st.reloadTab(f).catch(() => undefined);
  }
  void st.loadRefIndex();
}

function doneToast(count: number, files: number) {
  toast.success(t("rename.done", { n: count, files }));
}

let registered = false;

/** Register the F2 rename provider for `latex` (once). */
export function registerKeyRename(monaco: Monaco) {
  if (registered) return;
  registered = true;
  monaco.languages.registerRenameProvider("latex", {
    resolveRenameLocation(model, position) {
      const hit = keyAt(model.getLineContent(position.lineNumber), position.column - 1);
      if (!hit) return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: "", rejectReason: t("rename.notAKey") };
      if (!modelFile(model)) {
        return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: "", rejectReason: t("rename.mainEditorOnly") };
      }
      return { range: new monaco.Range(position.lineNumber, hit.start + 1, position.lineNumber, hit.end + 1), text: hit.key };
    },
    async provideRenameEdits(model, position, newName) {
      const hit = keyAt(model.getLineContent(position.lineNumber), position.column - 1);
      const file = modelFile(model);
      if (!hit || !file) return { edits: [], rejectReason: t("rename.notAKey") };
      try {
        // unsaved edits of other files must be on disk before rewriting them
        await useProjectStore.getState().saveAll();
        const r = await api.renameKey(hit.kind, hit.key, newName.trim(), file);
        await reloadChanged(r.files);
        doneToast(r.count, r.files.length + (r.skipped_edits.length ? 1 : 0));
        return {
          edits: r.skipped_edits.map((e) => ({
            resource: model.uri,
            versionId: undefined,
            textEdit: { range: new monaco.Range(e.line, e.start_col, e.line, e.end_col), text: newName.trim() },
          })),
        };
      } catch (e) {
        return { edits: [], rejectReason: String(e) };
      }
    },
  });
}

/** Rename from a list (labels view / bibliography): prompt for the new key. */
export async function renameKeyInteractive(kind: KeyKind, key: string): Promise<boolean> {
  const next = await dialog.prompt({
    title: kind === "label" ? t("rename.labelTitle") : t("rename.citeTitle"),
    message: t("rename.message", { key }),
    initial: key,
    confirmLabel: t("rename.go"),
  });
  if (!next?.trim() || next.trim() === key) return false;
  try {
    await useProjectStore.getState().saveAll();
    const r = await api.renameKey(kind, key, next.trim(), null);
    await reloadChanged(r.files);
    doneToast(r.count, r.files.length);
    return true;
  } catch (e) {
    toast.error(e);
    return false;
  }
}
