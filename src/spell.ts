// English spell checking for LaTeX sources (Hunspell dictionary via nspell).
// Only prose is checked: command names, math, comments, and the arguments of
// \label / \ref / \cite / \begin / \usepackage … are skipped, as are CJK
// text, words with digits and ALL-CAPS acronyms.
import type { editor as MonacoEditor, languages as MonacoLanguages } from "monaco-editor";
import type NSpell from "nspell";

type Monaco = typeof import("monaco-editor");

const CUSTOM_KEY = "tb-spell-words";
export const SPELL_OWNER = "spell";

let checker: NSpell | null = null;
let loading: Promise<NSpell> | null = null;

export function customWords(): string[] {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_KEY) || "[]") as string[];
  } catch {
    return [];
  }
}

export async function loadChecker(): Promise<NSpell> {
  if (checker) return checker;
  if (!loading) {
    loading = (async () => {
      const [{ default: nspell }, aff, dic] = await Promise.all([
        import("nspell"),
        // dictionary-en's `exports` only exposes its Node loader: import the
        // raw Hunspell files by path (works in dev, the dep scanner and build)
        import("../node_modules/dictionary-en/index.aff?raw"),
        import("../node_modules/dictionary-en/index.dic?raw"),
      ]);
      const sp = nspell(aff.default, dic.default);
      // LaTeX vocabulary that is not in a general English dictionary
      for (const w of ["LaTeX", "TeX", "BibTeX", "XeLaTeX", "pdfTeX", "arXiv", "DOI", "url", "e.g", "i.e", "etc"]) sp.add(w);
      for (const w of customWords()) sp.add(w);
      checker = sp;
      return sp;
    })();
  }
  return loading;
}

export function addCustomWord(word: string) {
  const list = new Set(customWords());
  list.add(word);
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify([...list]));
  } catch {
    /* best-effort */
  }
  checker?.add(word);
}

/** Commands whose (first) braced argument is not prose. */
const NON_PROSE_ARGS = new Set([
  "label", "ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref",
  "cite", "citep", "citet", "parencite", "textcite", "autocite", "nocite", "citeauthor", "citeyear",
  "begin", "end", "usepackage", "documentclass", "input", "include", "includegraphics", "includeonly",
  "bibliography", "bibliographystyle", "addbibresource", "url", "href", "newcommand", "renewcommand",
  "newenvironment", "setlength", "addtolength", "setcounter", "hspace", "vspace", "color", "textcolor",
  "definecolor", "pagestyle", "thispagestyle", "fontsize", "subfile", "graphicspath", "lstinputlisting", "verb",
  // key=value settings, font and package configuration
  "hypersetup", "geometry", "newgeometry", "lstset", "sisetup", "tikzset", "pgfplotsset", "captionsetup",
  "setmainfont", "setsansfont", "setmonofont", "setCJKmainfont", "setCJKsansfont", "setCJKmonofont", "ctexset",
  "usetikzlibrary", "RequirePackage", "PassOptionsToPackage", "setcopyright", "pdfbookmark",
]);

const MATH_ENVS = /^(equation|align|gather|multline|eqnarray|math|displaymath|split|flalign|alignat|verbatim|lstlisting|minted|tikzpicture)\*?$/;

/** Environments whose first braced argument is a spec (columns, width). */
const SPEC_ENVS = /^(tabular|tabularx|tabulary|longtable|array|minipage|multicols|wrapfigure|wraptable|subfigure)\*?$/;

/** Index just past the balanced `{…}` group starting at `k` (or `k` itself). */
function skipBraced(line: string, k: number): number {
  if (line[k] !== "{") return k;
  let depth = 0;
  for (; k < line.length; k++) {
    if (line[k] === "{") depth++;
    else if (line[k] === "}" && --depth === 0) return k + 1;
  }
  return k;
}

export interface WordHit {
  word: string;
  line: number;
  /** 1-based UTF-16 column */
  col: number;
}

/** Prose words of a LaTeX line, tracking math/verbatim state across lines. */
export function proseWords(text: string): WordHit[] {
  const out: WordHit[] = [];
  const lines = text.split("\n");
  let inEnv: string | null = null;
  let inDisplay = false; // \[ … \] or $$ … $$ spanning lines
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let i = 0;
    let inInline = false;
    while (i < line.length) {
      const ch = line[i];
      if (inEnv) {
        const end = line.indexOf(`\\end{${inEnv}}`, i);
        if (end < 0) break;
        i = end + `\\end{${inEnv}}`.length;
        inEnv = null;
        continue;
      }
      if (ch === "%" && line[i - 1] !== "\\") break; // comment
      if (ch === "\\") {
        if (line[i + 1] === "[") {
          inDisplay = true;
          i += 2;
          continue;
        }
        if (line[i + 1] === "]") {
          inDisplay = false;
          i += 2;
          continue;
        }
        if (line[i + 1] === "(" || line[i + 1] === ")") {
          inInline = line[i + 1] === "(";
          i += 2;
          continue;
        }
        let j = i + 1;
        while (j < line.length && /[A-Za-z@]/.test(line[j])) j++;
        const cmd = line.slice(i + 1, j);
        if (j === i + 1) {
          i += 2; // escaped char like \% \&
          continue;
        }
        // skip optional args, then a non-prose braced argument
        let k = j;
        while (line[k] === "*") k++;
        if (cmd === "begin") {
          const m = line.slice(k).match(/^\{([^}]*)\}/);
          if (m && MATH_ENVS.test(m[1])) {
            inEnv = m[1];
            i = k + m[0].length;
            continue;
          }
        }
        if (NON_PROSE_ARGS.has(cmd)) {
          while (line[k] === "[") {
            const close = line.indexOf("]", k);
            if (close < 0) break;
            k = close + 1;
          }
          const env = cmd === "begin" ? line.slice(k).match(/^\{([^}]*)\}/)?.[1] : undefined;
          k = skipBraced(line, k);
          if (env !== undefined) {
            // \begin{figure}[htbp], \begin{tabular}{lcr}, \begin{minipage}{0.5\linewidth}
            while (line[k] === "[") {
              const close = line.indexOf("]", k);
              if (close < 0) break;
              k = close + 1;
            }
            if (SPEC_ENVS.test(env)) k = skipBraced(line, k);
          }
        }
        i = k > j ? k : j;
        continue;
      }
      if (ch === "$") {
        if (line[i + 1] === "$") {
          inDisplay = !inDisplay;
          i += 2;
        } else {
          inInline = !inInline;
          i += 1;
        }
        continue;
      }
      if (inInline || inDisplay) {
        i++;
        continue;
      }
      if (/[A-Za-z]/.test(ch)) {
        let j = i;
        while (j < line.length && /[A-Za-z']/.test(line[j])) j++;
        // glued to digits/underscores (identifiers, units): skip
        const before = line[i - 1] ?? " ";
        const after = line[j] ?? " ";
        let word = line.slice(i, j).replace(/'+$/, "");
        if (!/[0-9_]/.test(before) && !/[0-9_]/.test(after) && word.length >= 3 && word !== word.toUpperCase()) {
          if (word.endsWith("'s")) word = word.slice(0, -2);
          out.push({ word, line: li + 1, col: i + 1 });
        }
        i = j;
        continue;
      }
      i++;
    }
  }
  return out;
}

export function misspellings(sp: NSpell, text: string): WordHit[] {
  const cache = new Map<string, boolean>();
  return proseWords(text).filter((w) => {
    let ok = cache.get(w.word);
    if (ok === undefined) {
      ok = sp.correct(w.word) || sp.correct(w.word.toLowerCase());
      cache.set(w.word, ok);
    }
    return !ok;
  });
}

/** Attach spell checking to an editor: markers on change (debounced). */
export function attachSpellcheck(monaco: Monaco, editor: MonacoEditor.IStandaloneCodeEditor, enabled: () => boolean) {
  let timer: number | undefined;
  const run = async () => {
    const model = editor.getModel();
    if (!model) return;
    if (!enabled() || !/\.(tex|md|txt)$/i.test(model.uri.path)) {
      monaco.editor.setModelMarkers(model, SPELL_OWNER, []);
      return;
    }
    const sp = await loadChecker();
    if (editor.getModel() !== model) return;
    const hits = misspellings(sp, model.getValue()).slice(0, 2000);
    monaco.editor.setModelMarkers(
      model,
      SPELL_OWNER,
      hits.map((h) => ({
        severity: monaco.MarkerSeverity.Info,
        message: `“${h.word}”: 可能拼写有误 / possible misspelling`,
        source: "spell",
        code: h.word,
        startLineNumber: h.line,
        startColumn: h.col,
        endLineNumber: h.line,
        endColumn: h.col + h.word.length,
      })),
    );
  };
  const schedule = (delay = 500) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), delay);
  };
  schedule(50);
  const subs = [editor.onDidChangeModelContent(() => schedule()), editor.onDidChangeModel(() => schedule(50))];
  return {
    refresh: () => schedule(0),
    dispose: () => {
      window.clearTimeout(timer);
      subs.forEach((s) => s.dispose());
    },
  };
}

let actionsRegistered = false;

/** Quick fixes for spell markers: suggestions + "add to dictionary". */
export function registerSpellActions(monaco: Monaco, onAdded: () => void) {
  if (actionsRegistered) return;
  actionsRegistered = true;
  monaco.languages.registerCodeActionProvider("latex", {
    provideCodeActions(model, _range, context) {
      const actions: MonacoLanguages.CodeAction[] = [];
      for (const marker of context.markers) {
        if (marker.source !== "spell" || !checker) continue;
        const word = String(typeof marker.code === "object" ? marker.code.value : marker.code ?? "");
        for (const s of checker.suggest(word).slice(0, 5)) {
          actions.push({
            title: `→ ${s}`,
            kind: "quickfix",
            diagnostics: [marker],
            isPreferred: actions.length === 0,
            edit: {
              edits: [
                {
                  resource: model.uri,
                  versionId: model.getVersionId(),
                  textEdit: {
                    range: {
                      startLineNumber: marker.startLineNumber,
                      startColumn: marker.startColumn,
                      endLineNumber: marker.endLineNumber,
                      endColumn: marker.endColumn,
                    },
                    text: s,
                  },
                },
              ],
            },
          });
        }
        actions.push({
          title: `添加 “${word}” 到词典 / Add to dictionary`,
          kind: "quickfix",
          diagnostics: [marker],
          command: { id: "texbutler.spell.add", title: "add", arguments: [word] },
        });
      }
      return { actions, dispose() {} };
    },
  });
  monaco.editor.registerCommand("texbutler.spell.add", (_accessor, word: string) => {
    addCustomWord(word);
    onAdded();
  });
}

/** Markers of the given model (tests / status). */
export function spellMarkers(monaco: Monaco, model: MonacoEditor.ITextModel) {
  return monaco.editor.getModelMarkers({ owner: SPELL_OWNER, resource: model.uri });
}
