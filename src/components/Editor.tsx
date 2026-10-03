/// <reference types="vite/client" />
import Editor, { loader, type OnMount, type BeforeMount } from "@monaco-editor/react";
import { useRef, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import katex from "katex";
import {
  Bold,
  Braces,
  Columns2,
  Copy,
  Crosshair,
  FilePlus2,
  Heading,
  ImagePlus,
  Italic,
  Languages,
  List,
  ListOrdered,
  Loader2,
  MessageSquareText,
  Omega,
  Save,
  Sigma,
  Table,
  WandSparkles,
  X,
  XSquare,
} from "lucide-react";
import { api } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useUiStore } from "../store/uiStore";
import { useAiStore } from "../store/aiStore";
import { dialog, toast } from "../store/feedbackStore";
import { saveDraft } from "../store/drafts";
import { registerEditor, revealLocation } from "../editorBridge";
import { useT } from "../i18n";
import * as actions from "../actions";
import ImageInsertModal from "./ImageInsertModal";
import FormulaModal from "./FormulaModal";
import TableModal from "./TableModal";
import DropMenu from "./ui/DropMenu";
import { FileIcon } from "./ProjectTree";

// Load Monaco from the LOCAL npm package instead of the jsdelivr CDN.
// @monaco-editor/react defaults to the CDN — when the network is slow or
// blocked the editor shows "loading" forever. Bundling it makes the editor
// work fully offline (same promise as the built-in tectonic bundle).
import * as monacoLocal from "monaco-editor/esm/vs/editor/editor.api";
// `editor.api` is only the bare API: without this import NO editor feature
// is registered (suggest/autocomplete, hover, find & replace, folding,
// links/Ctrl+Click, bracket matching, context menu, comment toggling…).
// `edcore.main` = every editor contribution, still without language packs.
import "monaco-editor/esm/vs/editor/edcore.main";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
loader.config({ monaco: monacoLocal });

export const EDITOR_FONT = "'Cascadia Code', 'Cascadia Mono', Consolas, 'Microsoft YaHei UI', monospace";

/** Language + completion providers are global in Monaco: register once. */
let languageReady = false;

/** Register the `latex` language with a lightweight monarch tokenizer. */
export const beforeMount: BeforeMount = (monaco) => {
  defineThemes(monaco);
  if (languageReady) return;
  languageReady = true;
  if (!monaco.languages.getLanguages().some((l) => l.id === "latex")) {
    monaco.languages.register({ id: "latex", extensions: [".tex"] });
  }
  monaco.languages.setMonarchTokensProvider("latex", {
    tokenizer: {
      root: [
        [/\\begin\{[^}]*\}/, "keyword"],
        [/\\end\{[^}]*\}/, "keyword"],
        [/\\(?:usepackage|documentclass|title|author|date|maketitle|section|subsection|subsubsection|paragraph|label|ref|cite|input|include|includegraphics|textbf|textit|emph|bfseries|item|table|figure|centering|caption|newpage|clearpage)\b/, "keyword"],
        [/\\[a-zA-Z@]+/, "type"],
        [/%.*$/, "comment"],
        [/[{}]/, "delimiter"],
        [/\$/, "string"],
      ],
    },
  });
  // auto-closing pairs + surrounding (bracket/brace pairing)
  monaco.languages.setLanguageConfiguration("latex", {
    comments: { lineComment: "%" },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "$", close: "$" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "$", close: "$" },
    ],
  });

  // --- autocompletion: common commands + environment pairs ---
  const COMMANDS: string[] = [
    "\\alpha", "\\beta", "\\gamma", "\\delta", "\\epsilon", "\\zeta", "\\eta",
    "\\theta", "\\lambda", "\\mu", "\\pi", "\\rho", "\\sigma", "\\tau",
    "\\phi", "\\omega", "\\Delta", "\\Gamma", "\\Omega", "\\Sigma",
    "\\frac{}{}", "\\sqrt{}", "\\sum_{}^{}", "\\int_{}^{}", "\\lim_{}",
    "\\leq", "\\geq", "\\neq", "\\approx", "\\in", "\\subset", "\\cup", "\\cap",
    "\\times", "\\cdot", "\\pm", "\\infty", "\\partial", "\\nabla",
    "\\textbf{}", "\\textit{}", "\\emph{}", "\\underline{}",
    "\\section{}", "\\subsection{}", "\\subsubsection{}", "\\chapter{}",
    "\\label{}", "\\ref{}", "\\cite{}", "\\includegraphics{}",
    "\\begin{}", "\\end{}", "\\item", "\\centering", "\\caption{}",
    "\\documentclass{}", "\\usepackage{}", "\\title{}", "\\author{}", "\\date{}",
  ];
  const ENVIRONMENTS: string[] = [
    "figure", "table", "equation", "align", "itemize", "enumerate",
    "description", "center", "tabular", "abstract", "theorem", "proof",
    "document", "verbatim", "quote",
  ];

  monaco.languages.registerCompletionItemProvider("latex", {
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const items: {
        label: string;
        kind: number;
        insertText: string;
        range: typeof range;
      }[] = COMMANDS.map((c) => ({
        label: c,
        kind: monaco.languages.CompletionItemKind.Function,
        insertText: c,
        range,
      }));
      for (const env of ENVIRONMENTS) {
        items.push({
          label: `\\begin{${env}}`,
          kind: monaco.languages.CompletionItemKind.Snippet,
          // plain text insert: a real tab would be interpreted as a Monaco
          // snippet tabstop, and `\t` literally would break LaTeX
          insertText: `\\begin{${env}}\n\n\\end{${env}}`,
          range,
        });
      }
      return { suggestions: items };
    },
  });

  // --- \ref / \cite smart completion from the project index ---
  const REF_CMDS = new Set(["ref", "eqref", "pageref", "autoref", "cref", "nameref"]);
  const CITE_CMDS = new Set(["cite", "citep", "citet", "parencite", "textcite", "citealp", "citeauthor", "nocite"]);
  monaco.languages.registerCompletionItemProvider("latex", {
    triggerCharacters: ["{", ","],
    provideCompletionItems: (model, position) => {
      const lineText = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const m = lineText.match(/\\([a-zA-Z@]+)\{([^}]*)$/);
      if (!m) return { suggestions: [] };
      const cmd = m[1];
      // after a comma inside \cite{a,b|} only the current key is replaced
      const prefix = m[2].split(",").pop()?.trimStart() ?? "";
      const idx = useProjectStore.getState().refIndex;
      let keys: { key: string; detail: string }[] = [];
      if (REF_CMDS.has(cmd)) {
        keys = idx.labels
          .filter((l) => l.key.startsWith(prefix))
          .map((l) => ({ key: l.key, detail: `${l.file}:${l.line}` }));
      } else if (CITE_CMDS.has(cmd)) {
        keys = idx.bib
          .filter((b) => b.key.startsWith(prefix))
          .map((b) => ({
            key: b.key,
            detail: `${b.entry_type}: ${b.title || b.author || "—"}`.slice(0, 60),
          }));
      } else {
        return { suggestions: [] };
      }
      const startColumn = position.column - prefix.length;
      const replaceRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn,
        endColumn: position.column,
      };
      return {
        suggestions: keys.map((k) => ({
          label: k.key,
          kind: REF_CMDS.has(cmd)
            ? monaco.languages.CompletionItemKind.Reference
            : monaco.languages.CompletionItemKind.Constant,
          detail: k.detail,
          insertText: k.key,
          range: replaceRange,
        })),
      };
    },
  });

  // hover preview: KaTeX-rendered formula floating above the source
  // (inline $...$, display $$...$$, \(...\) / \[...\])
  monaco.languages.registerHoverProvider("latex", {
    provideHover(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const hit = findMathAt(line, position.column);
      if (!hit) return null;
      let html = "";
      try {
        html = katex.renderToString(hit.src, { throwOnError: false, displayMode: hit.display });
      } catch {
        return null;
      }
      // KaTeX output is already escaped, but the raw source shown below it
      // is NOT — escape it or a line like `$<img src=x onerror=...>$` would
      // execute in the hover DOM (supportsHtml).
      return {
        range: new monaco.Range(position.lineNumber, hit.start + 1, position.lineNumber, hit.end + 1),
        contents: [
          {
            value: `<div style="padding:4px 2px;font-size:15px;min-width:120px;max-width:520px;overflow-x:auto;">${html}</div><div style="opacity:.6;font-size:11px;margin-top:4px;">${escapeHtml(hit.src)}</div>`,
            supportsHtml: true,
          },
        ],
      };
    },
  });

  // Ctrl+Click navigation: \ref{key} → \label{key}; \cite{key} → .bib entry
  monaco.languages.registerLinkProvider("latex", {
    provideLinks(model) {
      const links: Array<{ range: monacoLocal.Range; url: string }> = [];
      const re = /\\(?:ref|eqref|cref|Cref|autoref|cite|citep|citet)\{([^}]+)\}/g;
      for (let ln = 1; ln <= model.getLineCount(); ln++) {
        const line = model.getLineContent(ln);
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line))) {
          links.push({
            range: new monaco.Range(ln, m.index + 1, ln, m.index + m[0].length + 1),
            url: `tb-ref://${encodeURIComponent(m[1].trim().split(",")[0].trim())}`,
          });
        }
      }
      return { links };
    },
  });
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Find the math segment ($...$, $$...$$, \(...\), \[...\]) covering
 *  `col` (1-based) on `line`; returns source + 0-based offsets. */
function findMathAt(line: string, col: number): { src: string; start: number; end: number; display: boolean } | null {
  const patterns: Array<{ re: RegExp; display: boolean }> = [
    { re: /\$\$([^$]+)\$\$/g, display: true },
    { re: /\$([^$]+)\$/g, display: false },
    { re: /\\\[([\s\S]+?)\\\]/g, display: true },
    { re: /\\\(([\s\S]+?)\\\)/g, display: false },
  ];
  for (const { re, display } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (col >= start && col <= end) return { src: m[1], start, end, display };
    }
  }
  return null;
}

function defineThemes(monaco: Parameters<BeforeMount>[0]) {
  monaco.editor.defineTheme("texbutler", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "0B4FD6", fontStyle: "bold" },
      { token: "type", foreground: "8A1F7A" },
      { token: "comment", foreground: "3F7F5F", fontStyle: "italic" },
      { token: "string", foreground: "B35900" },
      { token: "delimiter", foreground: "57606A" },
    ],
    colors: {
      "editor.background": "#FFFFFF",
      "editor.lineHighlightBackground": "#2F6FEB0D",
      "editorLineNumber.foreground": "#A0A7B1",
      "editorLineNumber.activeForeground": "#59616C",
    },
  });
  monaco.editor.defineTheme("texbutler-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "6AA0FF", fontStyle: "bold" },
      { token: "type", foreground: "DCC27A" },
      { token: "comment", foreground: "6A9955", fontStyle: "italic" },
      { token: "string", foreground: "E39B6E" },
      { token: "delimiter", foreground: "A0A5AE" },
    ],
    colors: {
      "editor.background": "#1E2025",
      "editor.lineHighlightBackground": "#FFFFFF0A",
      "editorLineNumber.foreground": "#575C66",
      "editorLineNumber.activeForeground": "#A0A5AE",
      "editorWidget.background": "#282B31",
    },
  });
  // Liquid-glass variant: Monaco does NOT support transparent editor
  // backgrounds (the editor can fail to initialize / render blank), so an
  // opaque deep blue matching the tinted pane is used.
  monaco.editor.defineTheme("texbutler-liquid", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "6EA8FE", fontStyle: "bold" },
      { token: "type", foreground: "C4B5FD" },
      { token: "comment", foreground: "7BE0A0", fontStyle: "italic" },
      { token: "string", foreground: "F2C4A0" },
      { token: "delimiter", foreground: "E9EDF6" },
    ],
    colors: {
      "editor.background": "#0d1122",
      "editor.lineHighlightBackground": "#6EA8FE14",
      "editorLineNumber.foreground": "#5A6480",
      "editorLineNumber.activeForeground": "#A7B1C6",
      "editorCursor.foreground": "#6EA8FE",
      "editor.selectionBackground": "#6EA8FE33",
      "editor.inactiveSelectionBackground": "#6EA8FE22",
      "editorIndentGuide.background1": "#ffffff12",
      "editorWidget.background": "#151A30E6",
      "editorSuggestWidget.selectedBackground": "#6EA8FE2E",
    },
  });
}

type MonacoThemeId = "texbutler" | "texbutler-dark" | "texbutler-liquid";

export function monacoThemeFor(theme: string | undefined): MonacoThemeId {
  if (theme === "liquid") return "texbutler-liquid";
  if (theme === "dark") return "texbutler-dark";
  return "texbutler";
}

export const EDITOR_OPTIONS = {
  fontSize: 14,
  fontFamily: EDITOR_FONT,
  lineHeight: 22,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  tabSize: 2,
  wordWrap: "on" as const,
  renderWhitespace: "selection" as const,
  smoothScrolling: true,
  padding: { top: 8, bottom: 8 },
  cursorSmoothCaretAnimation: "on" as const,
  bracketPairColorization: { enabled: true },
  unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
};

/** Common LaTeX snippets for the insert menu. */
const SNIPPETS: { label: string; insert: string }[] = [
  { label: "figure", insert: "\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=0.8\\linewidth]{}\n\\caption{}\n\\label{fig:}\n\\end{figure}\n" },
  { label: "table", insert: "\\begin{table}[htbp]\n\\centering\n\\begin{tabular}{cc}\n\\hline\nA & B \\\\\n\\hline\n\\end{tabular}\n\\caption{}\n\\label{tab:}\n\\end{table}\n" },
  { label: "equation", insert: "\\begin{equation}\n\n\\label{eq:}\n\\end{equation}\n" },
  { label: "align", insert: "\\begin{align}\n  a &= b \\\\\n  c &= d\n\\end{align}\n" },
  { label: "theorem", insert: "\\begin{theorem}\n\n\\end{theorem}\n" },
  { label: "proof", insert: "\\begin{proof}\n\n\\end{proof}\n" },
  { label: "\\ref", insert: "\\ref{}" },
  { label: "\\cite", insert: "\\cite{}" },
  { label: "\\label", insert: "\\label{}" },
  { label: "\\footnote", insert: "\\footnote{}" },
  { label: "\\href", insert: "\\href{https://}{}" },
];

/** Math symbols for the symbol popover. */
const MATH_SYMBOLS = [
  "α", "β", "γ", "δ", "ε", "ζ", "η", "θ", "ι", "κ", "λ", "μ", "ν", "ξ", "π", "ρ", "σ", "τ", "υ", "φ", "χ", "ψ", "ω",
  "Γ", "Δ", "Θ", "Λ", "Ξ", "Π", "Σ", "Φ", "Ψ", "Ω",
  "√", "∫", "∮", "∑", "∏", "∞", "±", "∓", "×", "÷", "⋅", "∘",
  "≤", "≥", "≪", "≫", "≠", "≈", "≡", "∼", "∝",
  "∈", "∉", "⊂", "⊆", "⊃", "⊇", "∪", "∩", "∧", "∨", "¬",
  "∀", "∃", "∂", "∇", "∠", "⊥", "∥",
  "→", "←", "↑", "↓", "↦", "⇒", "⇐", "⇔", "↔", "⋯", "…",
];

type CodeEditor = Parameters<OnMount>[0];

export default function EditorPane() {
  const tabs = useProjectStore((s) => s.tabs);
  const activeTab = useProjectStore((s) => s.activeTab);
  const active = tabs.find((tab) => tab.path === activeTab) ?? null;
  const theme = useUiStore((s) => s.theme);
  const editorRef = useRef<CodeEditor | null>(null);
  const t = useT();
  const [imgModal, setImgModal] = useState<{ fileName: string; root: string } | null>(null);
  const [formulaMode, setFormulaMode] = useState<"inline" | "display" | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  const activeRef = useRef(active);
  activeRef.current = active;

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    const unregister = registerEditor(editor);

    // status bar cursor / selection
    const reportCursor = () => {
      const pos = editor.getPosition();
      const sel = editor.getSelection();
      const selected = sel && !sel.isEmpty() ? editor.getModel()?.getValueLengthInRange(sel) ?? 0 : 0;
      useUiStore.getState().setCursor(pos ? { line: pos.lineNumber, col: pos.column, selected } : null);
    };
    const cursorSub = editor.onDidChangeCursorSelection(reportCursor);
    reportCursor();

    // an EMPTY file gives Monaco nothing to detect the line ending from, so
    // it would use the Windows default (CRLF); keep new files LF like the
    // templates (files that already contain CRLF keep it)
    const lfForEmpty = () => {
      const model = editor.getModel();
      if (model && model.getValueLength() === 0) model.setEOL(monaco.editor.EndOfLineSequence.LF);
    };
    lfForEmpty();
    const modelSub = editor.onDidChangeModel(lfForEmpty);

    // Editor-local shortcuts. Standalone Monaco keeps ONE keybinding registry
    // for every editor instance, so a plain addCommand/addAction keybinding
    // fires in whichever editor registered last (the split pane, or a stale
    // instance). The context key below exists only in THIS editor's scope.
    editor.createContextKey("tbMainEditor", true);
    const boldAction = editor.addAction({
      id: "texbutler.bold",
      label: t("fmt.bold"),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyB],
      precondition: "tbMainEditor",
      contextMenuGroupId: "1_modification",
      run: (ed) => wrapIn(ed as CodeEditor, "\\textbf{", "}"),
    });
    const askAction = editor.addAction({
      id: "texbutler.askAi",
      label: t("editor.askAi"),
      precondition: "tbMainEditor",
      contextMenuGroupId: "navigation",
      run: () => askAboutSelection(),
    });

    // typing `\begin{env}` (complete with braces) auto-inserts the matching
    // `\end{env}` two lines below, with the cursor left inside. Listens to
    // model changes (fires per keystroke, unlike onDidType which only
    // reports single characters in monaco 0.52).
    let envClosing = false;
    let lastEnvCloseAt = 0;
    const envAutoClose = editor.onDidChangeModelContent((e) => {
      if (envClosing || e.isUndoing || e.isRedoing) return;
      const model = editor.getModel();
      if (!model) return;
      const ch = e.changes[e.changes.length - 1];
      // only plain typing / short single-line inserts can complete a \begin
      if (!ch || !ch.text || ch.text.includes("\n") || ch.text.length > 64) return;
      // end of the inserted text in the NEW model (the change range is in
      // old coordinates; using its end broke on replacements and threw
      // "Illegal value for lineNumber" after deletions)
      const lineNo = ch.range.startLineNumber;
      if (lineNo > model.getLineCount()) return;
      const lineText = model.getLineContent(lineNo);
      const col = ch.range.startColumn + ch.text.length;
      const before = lineText.slice(0, col - 1);
      const m = before.match(/\\begin\{([^}]+)\}$/);
      if (!m) return;
      const env = m[1];
      // debounce: queued change events after the first auto-close would
      // re-match the same \begin and stack duplicate \end blocks
      if (Date.now() - lastEnvCloseAt < 800) return;
      const lineCount = model.getLineCount();
      const near = [
        lineText.slice(col - 1).trimStart(),
        lineNo + 1 <= lineCount ? model.getLineContent(lineNo + 1).trimStart() : "",
        lineNo + 2 <= lineCount ? model.getLineContent(lineNo + 2).trimStart() : "",
      ].some((s) => s.startsWith(`\\end{${env}}`));
      if (near) return;
      envClosing = true;
      lastEnvCloseAt = Date.now();
      try {
        editor.executeEdits("env-close", [
          {
            range: new monaco.Range(lineNo, col, lineNo, col),
            text: `\n\n\\end{${env}}\n`,
          },
        ]);
        editor.setPosition({ lineNumber: lineNo, column: col });
      } finally {
        envClosing = false;
      }
    });

    // Ctrl+Click on \ref / \cite → jump to the definition
    const opener = editor as unknown as {
      onDidOpenedLink?: (cb: (link: { url?: string }) => void) => void;
    };
    opener.onDidOpenedLink?.(async (link) => {
      const key = decodeURIComponent((link.url || "").replace(/^tb-ref:\/\//, ""));
      if (!key) return;
      try {
        const idx = await api.refIndex();
        const label = idx.labels.find((l) => l.key === key);
        if (label) return void (await revealLocation(label.file, label.line));
        const bib = idx.bib.find((b) => b.key === key);
        if (bib?.file && bib.line) return void (await revealLocation(bib.file, bib.line));
        toast.info(t("editor.refNotFound", { key }));
      } catch {
        /* navigation failures are silent */
      }
    });

    // paste interception: a clipboard image (screenshot) is imported into
    // the project and inserted through the image dialog
    const dom = editor.getDomNode();
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      const types = e.clipboardData?.types;
      const hasImage =
        (files && files.length > 0 && files[0].type.startsWith("image/")) ||
        (types != null && Array.prototype.includes.call(types, "image/png"));
      if (!hasImage) return;
      e.preventDefault();
      void importClipboardImage();
    };
    dom?.addEventListener("paste", onPaste);

    editor.onDidDispose(() => {
      dom?.removeEventListener("paste", onPaste);
      envAutoClose.dispose();
      cursorSub.dispose();
      modelSub.dispose();
      boldAction.dispose();
      askAction.dispose();
      unregister();
      useUiStore.getState().setCursor(null);
      if (editorRef.current === editor) editorRef.current = null;
    });
  };

  const insertSnippet = (snippet: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const sel = ed.getSelection();
    if (!sel) return;
    ed.executeEdits("snippet", [{ range: sel, text: snippet, forceMoveMarkers: true }]);
    ed.pushUndoStop();
    ed.focus();
  };

  /** Wrap the current selection with a command pair (Ctrl+Shift+B = bold). */
  const wrapSelection = (prefix: string, suffix = "}") => {
    if (editorRef.current) wrapIn(editorRef.current, prefix, suffix);
  };

  /** Wrap `ed`'s selection; the action passes its OWN editor instance. */
  function wrapIn(ed: CodeEditor, prefix: string, suffix = "}") {
    const sel = ed.getSelection();
    if (!sel) return;
    const text = ed.getModel()?.getValueInRange(sel) ?? "";
    ed.executeEdits("wrap", [{ range: sel, text: `${prefix}${text}${suffix}` }]);
    if (!text) {
      // empty selection: park the cursor between the braces
      ed.setPosition({ lineNumber: sel.startLineNumber, column: sel.startColumn + prefix.length });
    }
    ed.pushUndoStop();
    ed.focus();
  }

  /** Insert a line-level block at the start of the cursor line. */
  const insertLine = (text: string) => {
    const ed = editorRef.current;
    const pos = ed?.getPosition();
    if (!ed || !pos) return;
    const model = ed.getModel();
    const line = model?.getLineContent(pos.lineNumber) ?? "";
    const range = line.trim()
      ? new monacoLocal.Range(pos.lineNumber, line.length + 1, pos.lineNumber, line.length + 1)
      : new monacoLocal.Range(pos.lineNumber, 1, pos.lineNumber, line.length + 1);
    const prefix = line.trim() ? "\n" : "";
    ed.executeEdits("line", [{ range, text: `${prefix}${text}`, forceMoveMarkers: true }]);
    ed.pushUndoStop();
    ed.focus();
  };

  const selection = () => {
    const ed = editorRef.current;
    const sel = ed?.getSelection();
    if (!ed || !sel || sel.isEmpty()) return null;
    return { ed, sel, text: ed.getModel()?.getValueInRange(sel) ?? "" };
  };

  const insertImage = async () => {
    if (!active) return;
    try {
      const file = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "svg", "pdf", "eps"] }],
      });
      if (!file || Array.isArray(file)) return;
      await startImageImport(file);
    } catch (e) {
      toast.error(e);
    }
  };

  /** Import an image (by path) into the project and open the insert dialog. */
  const startImageImport = async (path: string) => {
    const name = await api.importImage(path);
    setImgModal({ fileName: name, root: useProjectStore.getState().root });
  };

  /** Import the clipboard image (screenshot) and open the insert dialog. */
  const importClipboardImage = async () => {
    if (!activeRef.current) return;
    try {
      const name = await api.importClipboardImage();
      setImgModal({ fileName: name, root: useProjectStore.getState().root });
    } catch {
      // clipboard contains no image — ignore (normal paste path)
    }
  };

  useEffect(() => {
    let disposed = false;
    let unlistenDrag: (() => void) | undefined;
    void getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        if (!activeRef.current) return;
        if (event.payload.type !== "drop") return;
        // multi-file drop: import every image (whitelist matches the
        // backend tb_import_image formats), dedupe by path
        const seen = new Set<string>();
        for (const p of event.payload.paths ?? []) {
          if (seen.has(p)) continue;
          seen.add(p);
          if (/\.(png|jpe?g|gif|svg|pdf|eps)$/i.test(p)) {
            startImageImport(p).catch(toast.error);
          }
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlistenDrag = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlistenDrag?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [tabMenu]);

  // ---- AI text tools ------------------------------------------------
  const runAiTool = async (label: string, job: () => Promise<unknown>) => {
    if (aiBusy) return;
    setAiBusy(label);
    try {
      await job();
    } catch (e) {
      toast.error(e);
    } finally {
      setAiBusy(null);
    }
  };

  const translateSelection = (target: "中文" | "English") => {
    const s = selection();
    if (!s?.text.trim()) return toast.info(t("editor.translateEmpty"));
    void runAiTool(t("editor.translating"), async () => {
      const translated = await api.aiTranslate(s.text, target);
      if (!translated.trim()) return;
      // the user may have edited the selection meanwhile — never clobber it
      if (s.ed.getModel()?.getValueInRange(s.sel) !== s.text) return toast.info(t("editor.translateStale"));
      s.ed.executeEdits("translate", [{ range: s.sel, text: translated }]);
      s.ed.pushUndoStop();
      toast.success(t("editor.aiDone"));
    });
  };

  const translateAll = async (target: "中文" | "English") => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model || !active) return;
    const ok = await dialog.confirm({
      title: t("editor.translateAll"),
      message: t("editor.translateAllConfirm", { lang: target }),
      confirmLabel: t("editor.translateAllGo"),
    });
    if (!ok) return;
    const whole = model.getValue();
    void runAiTool(t("editor.translating"), async () => {
      const translated = await api.aiTranslate(whole, target);
      // guard: the user may have kept typing while the AI worked — never
      // overwrite their newer input with the T0 snapshot
      if (model.getValue() !== whole) return toast.info(t("editor.translateStale"));
      if (!translated.trim() || translated === whole) return;
      ed.executeEdits("translate-all", [{ range: model.getFullModelRange(), text: translated }]);
      ed.pushUndoStop();
      // save, then verify the translated document still compiles
      await useProjectStore.getState().saveFile(active.path);
      actions.compile();
      toast.success(t("editor.translateAllDone"));
    });
  };

  const polish = (mode: "academic" | "compress" | "expand") => {
    const s = selection();
    if (!s?.text.trim()) return toast.info(t("editor.polishEmpty"));
    void runAiTool(t("editor.polishing"), async () => {
      const polished = await api.aiPolish(s.text, mode);
      if (!polished.trim()) return;
      if (s.ed.getModel()?.getValueInRange(s.sel) !== s.text) return toast.info(t("editor.translateStale"));
      s.ed.executeEdits("polish", [{ range: s.sel, text: polished }]);
      s.ed.pushUndoStop();
      toast.success(t("editor.aiDone"));
    });
  };

  const askAboutSelection = () => {
    const s = selection();
    useAiStore.getState().setSelection(s?.text.trim() ? s.text : null);
    useUiStore.getState().focusAi();
  };

  const onTabMouseDown = (e: ReactMouseEvent, path: string) => {
    if (e.button === 1) {
      // middle click closes, like every browser/editor
      e.preventDefault();
      void useProjectStore.getState().closeTab(path);
    }
  };

  const noFile = !active;

  return (
    <div className="editor-pane">
      <div className="panel-header editor-header">
        <div className="editor-tabs" role="tablist">
          {tabs.map((tab) => {
            const name = tab.path.split("/").pop() ?? tab.path;
            return (
              <div
                key={tab.path}
                role="tab"
                aria-selected={tab.path === activeTab}
                className={`editor-tab ${tab.path === activeTab ? "active" : ""} ${tab.dirty ? "dirty" : ""}`}
                onClick={() => void useProjectStore.getState().openFile(tab.path)}
                onMouseDown={(e) => onTabMouseDown(e, tab.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTabMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: e.clientY, path: tab.path });
                }}
                title={tab.path}
              >
                <FileIcon name={name} size={14} />
                <span className="editor-tab-name">{name}</span>
                <button
                  className="editor-tab-close"
                  title={tab.dirty ? t("editor.closeDirty") : t("editor.close")}
                  aria-label={t("editor.close")}
                  onClick={(e) => {
                    e.stopPropagation();
                    void useProjectStore.getState().closeTab(tab.path);
                  }}
                >
                  {tab.dirty && <span className="editor-tab-dirty" />}
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="panel-actions editor-primary-actions">
          <button
            className="icon-btn editor-save-action"
            title={t("editor.save")}
            aria-label={t("editor.save")}
            onClick={() => void actions.saveActive()}
            disabled={!active?.dirty}
          >
            <Save size={16} aria-hidden="true" />
          </button>
          <button
            className="icon-btn editor-ask-ai-action"
            title={t("editor.askAiTitle")}
            aria-label={t("editor.askAi")}
            onClick={askAboutSelection}
            disabled={noFile}
          >
            <MessageSquareText size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      {active && (
        <div className="format-bar" role="toolbar" aria-label={t("editor.formatBar")}>
          <button className="icon-btn" title={t("fmt.bold")} aria-label={t("fmt.bold")} onClick={() => wrapSelection("\\textbf{")}>
            <Bold size={15} />
          </button>
          <button className="icon-btn fmt-optional" title={t("fmt.italic")} aria-label={t("fmt.italic")} onClick={() => wrapSelection("\\textit{")}>
            <Italic size={15} />
          </button>
          <DropMenu label={<Heading size={15} />} title={t("fmt.heading")}>
            {(close) =>
              (["chapter", "section", "subsection", "subsubsection", "paragraph"] as const).map((cmd) => (
                <button
                  key={cmd}
                  className="menu-item"
                  onClick={() => {
                    close();
                    wrapSelection(`\\${cmd}{`);
                  }}
                >
                  <code>\{cmd}</code>
                  <span className="menu-detail">{t(`fmt.h.${cmd}`)}</span>
                </button>
              ))
            }
          </DropMenu>
          <span className="divider-v" />
          <button className="icon-btn" title={t("formula.inline")} aria-label={t("formula.inline")} onClick={() => setFormulaMode("inline")}>
            <Sigma size={15} />
          </button>
          <DropMenu label={<Omega size={15} />} title={t("fmt.symbols")} menuClass="symbol-menu" triggerClass="icon-btn fmt-optional">
            {(close) => (
              <div className="symbol-panel">
                {MATH_SYMBOLS.map((s) => (
                  <button
                    key={s}
                    className="symbol-btn"
                    onClick={() => {
                      close();
                      insertSnippet(s);
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </DropMenu>
          <span className="divider-v" />
          <button className="icon-btn" title={t("toolbar.image")} aria-label={t("toolbar.image")} onClick={() => void insertImage()}>
            <ImagePlus size={15} />
          </button>
          <button className="icon-btn" title={t("table.title")} aria-label={t("table.title")} onClick={() => setTableOpen(true)}>
            <Table size={15} />
          </button>
          <DropMenu label={<List size={15} />} title={t("fmt.list")} triggerClass="icon-btn fmt-optional">
            {(close) => (
              <>
                <button className="menu-item" onClick={() => { close(); insertLine("\\begin{itemize}\n  \\item \n\\end{itemize}\n"); }}>
                  <List size={15} /> itemize
                </button>
                <button className="menu-item" onClick={() => { close(); insertLine("\\begin{enumerate}\n  \\item \n\\end{enumerate}\n"); }}>
                  <ListOrdered size={15} /> enumerate
                </button>
              </>
            )}
          </DropMenu>
          <DropMenu label={<Braces size={15} />} title={t("editor.insert")}>
            {(close) =>
              SNIPPETS.map((s) => (
                <button
                  key={s.label}
                  className="menu-item"
                  onClick={() => {
                    close();
                    if (s.insert.endsWith("\n")) insertLine(s.insert);
                    else insertSnippet(s.insert);
                  }}
                >
                  <code>{s.label}</code>
                </button>
              ))
            }
          </DropMenu>
          <span className="divider-v" />
          <DropMenu
            label={<><Languages size={15} /> <span>{t("editor.translate")}</span></>}
            title={t("editor.translateTitle")}
            triggerClass="icon-btn fmt-text"
            disabled={Boolean(aiBusy)}
          >
            {(close) => (
              <>
                <div className="menu-label">{t("editor.translateSel")}</div>
                <button className="menu-item" onClick={() => { close(); translateSelection("中文"); }}>
                  {t("editor.toZh")}
                </button>
                <button className="menu-item" onClick={() => { close(); translateSelection("English"); }}>
                  {t("editor.toEn")}
                </button>
                <div className="menu-separator" />
                <div className="menu-label">{t("editor.translateAll")}</div>
                <button className="menu-item" onClick={() => { close(); void translateAll("中文"); }}>
                  {t("editor.allToZh")}
                </button>
                <button className="menu-item" onClick={() => { close(); void translateAll("English"); }}>
                  {t("editor.allToEn")}
                </button>
              </>
            )}
          </DropMenu>
          <DropMenu
            label={<><WandSparkles size={15} /> <span>{t("editor.polish")}</span></>}
            title={t("editor.polishTitle")}
            triggerClass="icon-btn fmt-text"
            disabled={Boolean(aiBusy)}
          >
            {(close) =>
              (["academic", "compress", "expand"] as const).map((mode) => (
                <button key={mode} className="menu-item" onClick={() => { close(); polish(mode); }}>
                  {t(`editor.polish.${mode}`)}
                  <span className="menu-detail">{t(`editor.polish.${mode}Desc`)}</span>
                </button>
              ))
            }
          </DropMenu>
          <span className="toolbar-spacer" />
          <button className="icon-btn" title={t("editor.locateInPdfTitle")} aria-label={t("editor.locateInPdf")} onClick={() => void actions.locateInPdf()}>
            <Crosshair size={15} />
          </button>
          <button
            className="icon-btn"
            title={t("editor.splitTitle")}
            aria-label={t("editor.split")}
            onClick={() => useUiStore.getState().openPalette("split")}
          >
            <Columns2 size={15} />
          </button>
        </div>
      )}

      {active ? (
        <Editor
          height="100%"
          language="latex"
          theme={monacoThemeFor(theme)}
          path={active.path}
          value={active.content}
          beforeMount={beforeMount}
          onMount={handleMount}
          onChange={(v) => {
            if (v === undefined || v === null) return;
            const path = activeRef.current?.path;
            if (!path) return;
            useProjectStore.getState().setTabContent(path, v);
            // crash recovery: debounced draft for unsaved edits
            saveDraft(useProjectStore.getState().root, path, v);
          }}
          options={EDITOR_OPTIONS}
        />
      ) : (
        <div className="editor-empty">
          <FilePlus2 size={36} />
          <div>{t("editor.noFile")}</div>
          <div className="shortcut-list">
            <span>{t("cmd.quickOpen")}</span>
            <span><kbd>Ctrl</kbd> <kbd>P</kbd></span>
            <span>{t("cmd.newFile")}</span>
            <span><kbd>Ctrl</kbd> <kbd>N</kbd></span>
            <span>{t("cmd.palette")}</span>
            <span><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>P</kbd></span>
          </div>
        </div>
      )}

      {aiBusy && (
        <div className="ai-busy-banner" role="status">
          <Loader2 size={14} className="spinner" /> {aiBusy}
        </div>
      )}

      {tabMenu && (
        <div className="ctx-menu" role="menu" style={{ left: tabMenu.x, top: tabMenu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => { setTabMenu(null); void useProjectStore.getState().closeTab(tabMenu.path); }}>
            <X size={15} /> {t("editor.close")}
          </button>
          <button className="ctx-item" onClick={() => { setTabMenu(null); void useProjectStore.getState().closeOtherTabs(tabMenu.path); }}>
            <XSquare size={15} /> {t("editor.closeOthers")}
          </button>
          <div className="menu-separator" />
          <button className="ctx-item" onClick={() => { setTabMenu(null); useUiStore.getState().setSplitFile(tabMenu.path); }}>
            <Columns2 size={15} /> {t("tree.openSplit")}
          </button>
          <button className="ctx-item" onClick={() => { setTabMenu(null); void actions.copyText(tabMenu.path); }}>
            <Copy size={15} /> {t("tree.copyPath")}
          </button>
        </div>
      )}

      {imgModal && (
        <ImageInsertModal
          fileName={imgModal.fileName}
          projectRoot={imgModal.root}
          onCancel={() => setImgModal(null)}
          onConfirm={(code) => {
            insertSnippet(code);
            setImgModal(null);
          }}
        />
      )}
      {formulaMode && (
        <FormulaModal
          mode={formulaMode}
          initial={selection()?.text}
          onCancel={() => setFormulaMode(null)}
          onConfirm={(code) => {
            insertSnippet(code);
            setFormulaMode(null);
          }}
        />
      )}
      {tableOpen && (
        <TableModal
          onCancel={() => setTableOpen(false)}
          onConfirm={(code) => {
            insertLine(code);
            setTableOpen(false);
          }}
        />
      )}
    </div>
  );
}
