// Side-by-side split editor: a second Monaco pane pinned to a specific
// file, independent from the active tab (parallel editing/comparison).
import Editor from "@monaco-editor/react";
import { useProjectStore } from "../store/projectStore";
import { api } from "../api";
import { useT } from "../i18n";
import { monacoThemeFor } from "./Editor";
import { useEffect, useState } from "react";

export default function SplitPane({
  file,
  onClose,
}: {
  file: string;
  onClose: () => void;
}) {
  const t = useT();
  const ensureTab = useProjectStore((s) => s.ensureTab);
  const tab = useProjectStore((s) => s.tabs.find((x) => x.path === file));
  const setTabContent = useProjectStore((s) => s.setTabContent);
  const [theme, setTheme] = useState<"texbutler" | "texbutler-dark" | "texbutler-liquid">(
    () => monacoThemeFor(document.documentElement.dataset.theme),
  );

  useEffect(() => {
    void ensureTab(file);
    const mo = new MutationObserver(() =>
      setTheme(monacoThemeFor(document.documentElement.dataset.theme)),
    );
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, [ensureTab, file]);

  // save THIS pane's file (not the active tab — those are different)
  const saveAndClose = async () => {
    const st = useProjectStore.getState();
    const tab = st.tabs.find((t) => t.path === file);
    if (tab?.dirty) {
      try {
        await api.writeFile(tab.path, tab.content);
      } catch {
        /* keep the pane open on failure so edits are not lost */
        return;
      }
    }
    onClose();
  };

  return (
    <div className="split-pane">
      <div className="split-header">
        <span className="split-title" title={file}>
          {file.split("/").pop()}
        </span>
        <span className="split-path">{file}</span>
        <button
          className="btn-mini"
          title={t("editor.splitClose")}
          onClick={() => void saveAndClose()}
        >
          ×
        </button>
      </div>
      <Editor
        key={file}
        language="latex"
        theme={theme}
        value={tab?.content ?? ""}
        onChange={(v) => {
          if (v !== undefined && tab && tab.dirty !== undefined) {
            setTabContent(file, v);
          }
        }}
        options={{
          fontSize: 13,
          wordWrap: "on",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
        }}
      />
    </div>
  );
}
