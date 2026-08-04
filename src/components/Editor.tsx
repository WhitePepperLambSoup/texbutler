import Editor, { type OnMount, type BeforeMount } from "@monaco-editor/react";
import { useRef, useEffect, useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useCompileStore } from "../store/compileStore";
import { useT } from "../i18n";
import ImageInsertModal from "./ImageInsertModal";

/** Register the `latex` language with a lightweight monarch tokenizer. */
const beforeMount: BeforeMount = (monaco) => {
  if (monaco.languages.getLanguages().some((l) => l.id === "latex")) return;
  monaco.languages.register({ id: "latex", extensions: [".tex"] });  monaco.languages.setMonarchTokensProvider("latex", {
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

/** Quick math symbols for the symbol panel. */
const MATH_SYMBOLS = [
  "α", "β", "γ", "δ", "ε", "θ", "λ", "μ", "π", "σ", "ω", "φ",
  "∞", "∑", "∫", "√", "±", "≤", "≥", "≈", "≠", "∈", "∀", "∃",
  "×", "÷", "∂", "Δ", "→", "⇒", "∪", "∩", "⊂", "⊆", "⊥", "∥",
];

export default function EditorPane() {
  const { openPath, openContent, dirty, saveFile } = useProjectStore();
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const t = useT();
  const [symbolOpen, setSymbolOpen] = useState(false);
  const [imgModal, setImgModal] = useState<{ fileName: string; root: string } | null>(null);

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

  const insertImage = async () => {
    if (!openPath) return;
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
    if (!openPath) return;
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
        <span className="panel-title">
          {openPath ?? t("editor.untitled")}
          {dirty ? " ●" : ""}
        </span>
        <span className="format-buttons" title={t("editor.insert")}>
          <button className="btn-mini" title="插入图片" onClick={() => void insertImage()} disabled={!openPath}>
            {t("toolbar.image")}
          </button>
          <button className="btn-mini" title="段落" onClick={() => insertSnippet("\n\n")} disabled={!openPath}>
            ¶
          </button>
          <button className="btn-mini" title="\\section" onClick={() => insertSnippet("\\section{标题}\n")} disabled={!openPath}>
            H1
          </button>
          <button className="btn-mini" title="\\subsection" onClick={() => insertSnippet("\\subsection{小节}\n")} disabled={!openPath}>
            H2
          </button>
          <button className="btn-mini" title="\\textbf" onClick={() => insertSnippet("\\textbf{加粗文字}")} disabled={!openPath}>
            B
          </button>
          <button className="btn-mini" title="行内公式 $..$" onClick={() => insertSnippet("$E = mc^2$")} disabled={!openPath}>
            Σ
          </button>
          <button className="btn-mini" title="行间公式 \\[..\\]" onClick={() => insertSnippet("\\[\nE = mc^2\n\\]\n")} disabled={!openPath}>
            ∑
          </button>
          <button className="btn-mini" title="列表" onClick={() => insertSnippet("\\begin{itemize}\n\\item 第一项\n\\item 第二项\n\\end{itemize}\n")} disabled={!openPath}>
            ••
          </button>
          <button className="btn-mini" title="表格" onClick={() => insertSnippet("\\begin{table}[H]\n\\centering\n\\begin{tabular}{cc}\n列1 & 列2 \\\\\n\\hline\nA & B \\\\\n\\end{tabular}\n\\caption{表注}\n\\label{tab:}\n\\end{table}\n")} disabled={!openPath}>
            ▦
          </button>
          <button className="btn-mini" title="数学符号" onClick={() => setSymbolOpen((v) => !v)} disabled={!openPath}>
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
            disabled={!openPath}
          >
            <option value="">{t("editor.insert")}…</option>
            {SNIPPETS.map((s) => (
              <option key={s.label} value={s.label}>
                {s.label}
              </option>
            ))}
          </select>
          <button className="btn-mini" onClick={doSave} disabled={!dirty}>
            {t("editor.save")}
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
      {openPath ? (
        <Editor
          height="100%"
          language="latex"
          theme="texbutler"
          path={openPath}
          value={openContent}
          beforeMount={beforeMount}
          onMount={handleMount}
          onChange={(v) =>
            useProjectStore.setState({
              openContent: v ?? "",
              dirty: v !== undefined && v !== null,
            })
          }
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
    </div>
  );
}
