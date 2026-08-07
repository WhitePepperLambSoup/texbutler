/// <reference types="vite/client" />
import Editor, { loader, type OnMount, type BeforeMount } from "@monaco-editor/react";
import { useRef, useEffect, useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useCompileStore } from "../store/compileStore";
import { useAiStore } from "../store/aiStore";
import { useT } from "../i18n";
import ImageInsertModal from "./ImageInsertModal";
import FormulaModal from "./FormulaModal";
import TableModal from "./TableModal";

// Load Monaco from the LOCAL npm package instead of the jsdelivr CDN.
// @monaco-editor/react defaults to the CDN — when the network is slow or
// blocked the editor shows "loading" forever. Bundling it makes the editor
// work fully offline (same promise as the built-in tectonic bundle).
import * as monacoLocal from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
loader.config({ monaco: monacoLocal });

/** Register the `latex` language with a lightweight monarch tokenizer. */
const beforeMount: BeforeMount = (monaco) => {
  if (!monaco.languages.getLanguages().some((l) => l.id === "latex")) {
    monaco.languages.register({ id: "latex", extensions: [".tex"] });
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
  }
  monaco.editor.defineTheme("texbutler", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "0000CC", fontStyle: "bold" },
      { token: "type", foreground: "7F0055" },
      { token: "comment", foreground: "3F7F5F", fontStyle: "italic" },
      { token: "string", foreground: "2A00FF" },
      { token: "delimiter", foreground: "000000" },
    ],
    colors: {},
  });
  monaco.editor.defineTheme("texbutler-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "4FC1FF", fontStyle: "bold" },
      { token: "type", foreground: "DCDCAA" },
      { token: "comment", foreground: "6A9955", fontStyle: "italic" },
      { token: "string", foreground: "CE9178" },
      { token: "delimiter", foreground: "D4D4D4" },
    ],
    colors: {},
  });
  // Liquid-glass variant: Monaco does NOT support transparent editor
  // backgrounds (the editor can fail to initialize / render blank), so we
  // use an opaque deep blue that matches the tinted pane. The colour blobs
  // still show through the pane border/panels around the editor.
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
        insertTextRules?: number;
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
      const prefix = m[2];
      const idx = useProjectStore.getState().refIndex;
      let keys: { key: string; detail: string }[] = [];
      if (REF_CMDS.has(cmd)) {
        keys = idx.labels
          .filter((l) => l.key.startsWith(prefix))
          .map((l) => ({ key: l.key, detail: `标签 ${l.file}:${l.line}` }));
      } else if (CITE_CMDS.has(cmd)) {
        keys = idx.bib
          .filter((b) => b.key.startsWith(prefix))
          .map((b) => ({
            key: b.key,
            detail: `${b.entry_type}: ${b.title || b.author || "(无标题)"}`.slice(0, 60),
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
};

/** Common LaTeX snippets for the insert menu. */
const SNIPPETS: { label: string; insert: string }[] = [
  { label: "\\section 章节", insert: "\\section{标题}\n" },
  { label: "\\subsection 小节", insert: "\\subsection{小节}\n" },
  { label: "\\textbf 加粗", insert: "\\textbf{加粗文字}" },
  { label: "{\\bfseries 粗体}", insert: "{\\bfseries 粗体文字}" },
  { label: "\\includegraphics 插图", insert: "\\includegraphics[width=0.8\\textwidth]{图片.png}\n" },
  { label: "\\begin{figure} 图环境", insert: "\\begin{figure}[H]\n\\centering\n\\includegraphics[width=0.8\\textwidth]{}\n\\caption{图注}\n\\label{fig:}\n\\end{figure}\n" },
  { label: "\\begin{table} 表环境", insert: "\\begin{table}[H]\n\\centering\n\\begin{tabular}{cc}\n列1 & 列2 \\\\\n\\hline\nA & B \\\\\n\\end{tabular}\n\\caption{表注}\n\\label{tab:}\n\\end{table}\n" },
  { label: "\\begin{itemize} 列表", insert: "\\begin{itemize}\n\\item 第一项\n\\item 第二项\n\\end{itemize}\n" },
  { label: "\\begin{equation} 公式", insert: "\\begin{equation}\nE = mc^2\n\\label{eq:}\n\\end{equation}\n" },
  { label: "\\ref / \\cite 引用", insert: "如图~\\ref{fig:} 所示，文献~\\cite{key}。" },
  { label: "\\label 标签", insert: "\\label{sec:}" },
];

/** Quick math symbols for the symbol panel (60+). */
const MATH_SYMBOLS = [
  "α", "β", "γ", "δ", "ε", "ζ", "η", "θ", "ι", "κ", "λ", "μ", "ν", "ξ", "ο", "π", "ρ", "σ", "τ", "υ", "φ", "χ", "ψ", "ω",
  "Α", "Β", "Γ", "Δ", "Ε", "Θ", "Λ", "Ξ", "Π", "Σ", "Υ", "Φ", "Ψ", "Ω",
  "√", "∛", "∫", "∮", "∑", "∏", "∞", "±", "∓", "×", "÷", "⋅", "∘",
  "≤", "≥", "≪", "≫", "≠", "≈", "≡", "∼", "∝",
  "∈", "∉", "⊂", "⊆", "⊃", "⊇", "∪", "∩", "∧", "∨", "¬",
  "∀", "∃", "∂", "∇", "∠", "⊥", "∥", "⟂",
  "→", "←", "↑", "↓", "↦", "⇒", "⇐", "⇔", "↔", "⋯", "…",
];

/** Always-visible quick symbols on the editor toolbar (click to insert). */
const QUICK_SYMBOLS = ["α", "β", "γ", "δ", "θ", "λ", "π", "√", "∫", "∞", "±", "≤"];

type MonacoThemeId = "texbutler" | "texbutler-dark" | "texbutler-liquid";

function monacoThemeFor(dataTheme: string | undefined): MonacoThemeId {
  if (dataTheme === "liquid") return "texbutler-liquid";
  if (dataTheme === "dark") return "texbutler-dark";
  return "texbutler";
}

export default function EditorPane() {
  const { tabs, activeTab, saveFile, setTabContent, closeTab, openFile } = useProjectStore();
  const active = tabs.find((t) => t.path === activeTab) ?? null;
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const t = useT();
  const [symbolOpen, setSymbolOpen] = useState(false);
  const [imgModal, setImgModal] = useState<{ fileName: string; root: string } | null>(null);
  const [formulaMode, setFormulaMode] = useState<"inline" | "display" | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const [monacoTheme, setMonacoTheme] = useState<"texbutler" | "texbutler-dark" | "texbutler-liquid">(
    () => monacoThemeFor(document.documentElement.dataset.theme)
  );

  // follow the app theme (liquid glass / day / night) for the editor panel
  useEffect(() => {
    const onTheme = () => {
      setMonacoTheme(monacoThemeFor(document.documentElement.dataset.theme));
    };
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    // paste interception: a clipboard image (screenshot) is imported into the
    // project and inserted through the image dialog instead of raw pasting
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
    editor.onDidDispose(() => dom?.removeEventListener("paste", onPaste));
  };

  const doSave = useCallback(() => {
    void saveFile();
  }, [saveFile]);

  const insertSnippet = (snippet: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const sel = ed.getSelection();
    if (sel) {
      ed.executeEdits("snippet", [{ range: sel, text: snippet }]);
    } else {
      ed.executeEdits("snippet", [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: snippet }]);
    }
    ed.focus();
  };

  /** Wrap the current selection with a command pair (Ctrl+Shift+B = bold). */
  const wrapSelection = (prefix: string, suffix = prefix) => {
    const ed = editorRef.current;
    if (!ed) return;
    const sel = ed.getSelection();
    if (!sel || sel.isEmpty()) {
      // insert the pair and park the cursor between the braces so the user
      // can type the content immediately (no placeholder text is written)
      const pos = ed.getPosition();
      if (!pos) return;
      const text = `${prefix}${suffix}`;
      const col = pos.column;
      ed.executeEdits("wrap", [
        { range: { startLineNumber: pos.lineNumber, startColumn: col, endLineNumber: pos.lineNumber, endColumn: col }, text },
      ]);
      ed.setPosition({ lineNumber: pos.lineNumber, column: col + prefix.length });
      ed.focus();
      return;
    }
    const text = ed.getModel()?.getValueInRange(sel) ?? "";
    ed.executeEdits("wrap", [
      { range: sel, text: `${prefix}${text}${suffix}` },
    ]);
    ed.focus();
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
      window.alert(String(e));
    }
  };

  /** Import an image (by path) into the project and open the insert dialog. */
  const startImageImport = async (path: string) => {
    const name = await api.importImage(path);
    const root = useProjectStore.getState().root;
    setImgModal({ fileName: name, root });
  };

  /** Import the clipboard image (screenshot) and open the insert dialog. */
  const importClipboardImage = async () => {
    if (!active) return;
    try {
      const name = await api.importClipboardImage();
      const root = useProjectStore.getState().root;
      setImgModal({ fileName: name, root });
    } catch {
      // clipboard contains no image — ignore (normal paste path)
    }
  };

  const confirmImageInsert = (code: string) => {
    insertSnippet(code);
    setImgModal(null);
    // keep the flow smooth: recompile right after inserting an image
    const { compile } = useCompileStore.getState();
    void compile("main");
  };

  useEffect(() => {
    let disposed = false;
    let unlistenDrag: (() => void) | undefined;
    void getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          const img = event.payload.paths.find((p) =>
            /\.(png|jpe?g|gif|svg|pdf|eps)$/i.test(p)
          );
          if (!img) return;
          void startImageImport(img);
        }
      })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlistenDrag = fn;
        }
      });
    return () => {
      disposed = true;
      unlistenDrag?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        doSave();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        wrapSelection("\\textbf{", "}");
      }
    };
    const onGoto = (e: Event) => {
      const line = (e as CustomEvent<{ line: number }>).detail?.line;
      const ed = editorRef.current;
      if (ed && typeof line === "number" && line > 0) {
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column: 1 });
        ed.focus();
      }
    };
    const onInsertText = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text;
      const ed = editorRef.current;
      if (ed && typeof text === "string" && text) {
        const sel = ed.getSelection();
        if (sel) {
          ed.executeEdits("ai", [{ range: sel, text }]);
        } else {
          ed.executeEdits("ai", [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text }]);
        }
        ed.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("tb:goto-line", onGoto);
    window.addEventListener("tb:insert-text", onInsertText);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("tb:goto-line", onGoto);
      window.removeEventListener("tb:insert-text", onInsertText);
    };
  }, [doSave]);

  return (
    <div className="editor-pane">
      <div className="panel-header">
        <span className="editor-tabs">
          {tabs.map((tab) => (
            <span
              key={tab.path}
              className={`editor-tab ${tab.path === activeTab ? "active" : ""}`}
              onClick={() => void openFile(tab.path)}
              title={tab.path}
            >
              <span className="editor-tab-name">{tab.path.split("/").pop()}</span>
              {tab.dirty && <span className="editor-tab-dirty">●</span>}
              <button
                className="editor-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(tab.path);
                }}
              >
                ×
              </button>
            </span>
          ))}
        </span>
        <span className="format-buttons" title={t("editor.insert")}>
          <button className="btn-mini" title="插入图片" onClick={() => void insertImage()} disabled={!active}>
            {t("toolbar.image")}
          </button>
          <button className="btn-mini" title="段落" onClick={() => insertSnippet("\n\n")} disabled={!active}>
            ¶
          </button>
          <button className="btn-mini" title="\\section" onClick={() => insertSnippet("\\section{标题}\n")} disabled={!active}>
            H1
          </button>
          <button className="btn-mini" title="\\subsection" onClick={() => insertSnippet("\\subsection{小节}\n")} disabled={!active}>
            H2
          </button>
          <button className="btn-mini" title="\\textbf（Ctrl+Shift+B 包裹选中）" onClick={() => wrapSelection("\\textbf{", "}")} disabled={!active}>
            B
          </button>
          <button className="btn-mini" title={t("formula.inline")} onClick={() => setFormulaMode("inline")} disabled={!active}>
            Σ
          </button>
          <button className="btn-mini" title={t("formula.display")} onClick={() => setFormulaMode("display")} disabled={!active}>
            ∑
          </button>
          <span className="sym-quick" title="常用公式符号（点击直接插入）">
            {QUICK_SYMBOLS.map((s) => (
              <button
                key={s}
                className="btn-mini sym-quick-btn"
                title={`插入 ${s}`}
                onClick={() => insertSnippet(`${s} `)}
                disabled={!active}
              >
                {s}
              </button>
            ))}
          </span>
          <button className="btn-mini" title="列表" onClick={() => insertSnippet("\\begin{itemize}\n\\item 第一项\n\\item 第二项\n\\end{itemize}\n")} disabled={!active}>
            ••
          </button>
          <button className="btn-mini" title={t("table.title")} onClick={() => setTableOpen(true)} disabled={!active}>
            ▦
          </button>
          <button
            className="btn-mini"
            title={t("editor.translateTitle")}
            disabled={!active}
            onClick={async () => {
              const ed = editorRef.current;
              if (!ed || !active) return;
              const sel = ed.getSelection();
              const text = sel ? ed.getModel()?.getValueInRange(sel) ?? "" : "";
              if (!text.trim()) {
                window.alert(t("editor.translateEmpty"));
                return;
              }
              try {
                const translated = await api.aiTranslate(text, t("editor.translateTarget"));
                if (sel) {
                  ed.executeEdits("translate", [{ range: sel, text: translated }]);
                }
              } catch (e) {
                window.alert(String(e));
              }
            }}
          >
            {t("editor.translate")}
          </button>
          <button
            className="btn-mini"
            title={t("editor.askAiTitle")}
            disabled={!active}
            onClick={() => {
              const ed = editorRef.current;
              if (!ed || !active) return;
              const sel = ed.getSelection();
              const text = sel ? ed.getModel()?.getValueInRange(sel) ?? "" : "";
              useAiStore.getState().setSelection(text.trim() ? text : null);
              window.dispatchEvent(new CustomEvent("tb:focus-ai-panel"));
            }}
          >
            {t("editor.askAi")}
          </button>
          <button className="btn-mini" title="数学符号" onClick={() => setSymbolOpen((v) => !v)} disabled={!active}>
            αβ
          </button>
        </span>
        <span className="panel-actions">
          <select
            className="snippet-select"
            title={t("editor.insert")}
            value=""
            onChange={(e) => {
              const s = SNIPPETS.find((x) => x.label === e.target.value);
              if (s) insertSnippet(s.insert);
            }}
            disabled={!active}
          >
            <option value="">{t("editor.insert")}…</option>
            {SNIPPETS.map((s) => (
              <option key={s.label} value={s.label}>
                {s.label}
              </option>
            ))}
          </select>
          <button className="btn-mini" onClick={doSave} disabled={!active?.dirty}>
            {t("editor.save")}
          </button>
          <button
            className="btn-mini"
            title={t("editor.locateInPdfTitle")}
            disabled={!active}
            onClick={async () => {
              const ed = editorRef.current;
              if (!ed || !active) return;
              const line = ed.getPosition()?.lineNumber ?? 1;
              try {
                const page = await api.synctexForward(active.path, line);
                if (page != null) {
                  window.dispatchEvent(new CustomEvent("tb:synctex-page", { detail: page }));
                } else {
                  useProjectStore.getState().notify(t("editor.locatePdfNoSync", { file: active.path }));
                }
              } catch {
                useProjectStore.getState().notify(t("editor.locatePdfNoSync", { file: active.path }));
              }
            }}
          >
            {t("editor.locateInPdf")}
          </button>
        </span>
      </div>
      {symbolOpen && (
        <div className="symbol-panel">
          {MATH_SYMBOLS.map((s) => (
            <button key={s} className="symbol-btn" onClick={() => insertSnippet(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {active ? (
        <Editor
          height="100%"
          language="latex"
          theme={monacoTheme}
          path={active.path}
          value={active.content}
          beforeMount={beforeMount}
          onMount={handleMount}
          onChange={(v) => {
            if (v !== undefined && v !== null) {
              setTabContent(active.path, v);
            }
          }}
          options={{
            fontSize: 14,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: "on",
            renderWhitespace: "selection",
            smoothScrolling: true,
          }}
        />
      ) : (
        <div className="editor-empty">{t("editor.empty")}</div>
      )}
      {imgModal && (
        <ImageInsertModal
          fileName={imgModal.fileName}
          projectRoot={imgModal.root}
          onCancel={() => setImgModal(null)}
          onConfirm={confirmImageInsert}
        />
      )}
      {formulaMode && (
        <FormulaModal
          mode={formulaMode}
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
            insertSnippet(code);
            setTableOpen(false);
          }}
        />
      )}
    </div>
  );
}
