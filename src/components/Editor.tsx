import Editor, { type OnMount, type BeforeMount } from "@monaco-editor/react";
import { useRef, useEffect, useCallback } from "react";
import { useProjectStore } from "../store/projectStore";
import { useT } from "../i18n";

/** Register the `latex` language with a lightweight monarch tokenizer. */
const beforeMount: BeforeMount = (monaco) => {
  if (monaco.languages.getLanguages().some((l) => l.id === "latex")) return;
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

export default function EditorPane() {
  const { openPath, openContent, dirty, saveFile } = useProjectStore();
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const t = useT();

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
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
    window.addEventListener("keydown", onKey);
    window.addEventListener("tb:goto-line", onGoto);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("tb:goto-line", onGoto);
    };
  }, [doSave]);

  return (
    <div className="editor-pane">
      <div className="panel-header">
        <span className="panel-title">
          {openPath ?? t("editor.untitled")}
          {dirty ? " ●" : ""}
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
    </div>
  );
}
