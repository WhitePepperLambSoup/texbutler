// Side-by-side split editor: a second Monaco pane pinned to a specific
// file, independent from the active tab (parallel editing/comparison).
import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect } from "react";
import { Save, X } from "lucide-react";
import { useProjectStore } from "../store/projectStore";
import { useUiStore } from "../store/uiStore";
import { saveDraft } from "../store/drafts";
import { toast } from "../store/feedbackStore";
import { useT } from "../i18n";
import { EDITOR_OPTIONS, beforeMount, monacoThemeFor } from "./Editor";
import { FileIcon } from "./ProjectTree";

export default function SplitPane({ file }: { file: string }) {
  const t = useT();
  const tab = useProjectStore((s) => s.tabs.find((x) => x.path === file));
  const theme = useUiStore((s) => s.theme);
  const close = () => useUiStore.getState().setSplitFile(null);

  useEffect(() => {
    void useProjectStore.getState().ensureTab(file);
  }, [file]);

  // save THIS pane's file (not the active tab — those are different)
  const save = async () => {
    try {
      await useProjectStore.getState().saveFile(file);
    } catch (e) {
      toast.error(e);
      throw e;
    }
  };

  const saveAndClose = async () => {
    if (useProjectStore.getState().tabs.find((x) => x.path === file)?.dirty) {
      // keep the pane open on failure so edits are not lost
      try {
        await save();
      } catch {
        return;
      }
    }
    close();
  };

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save().catch(() => undefined));
  };

  const name = file.split("/").pop() ?? file;

  return (
    <div className="split-pane">
      <div className="panel-header split-header">
        <FileIcon name={name} size={14} />
        <span className="split-title" title={file}>
          {name}
          {tab?.dirty ? " ●" : ""}
        </span>
        <span className="split-path">{file}</span>
        <button
          className="icon-btn icon-btn-sm"
          title={t("editor.save")}
          aria-label={t("editor.save")}
          disabled={!tab?.dirty}
          onClick={() => void save().catch(() => undefined)}
        >
          <Save size={14} />
        </button>
        <button className="icon-btn icon-btn-sm" title={t("editor.splitClose")} aria-label={t("editor.splitClose")} onClick={() => void saveAndClose()}>
          <X size={15} />
        </button>
      </div>
      <Editor
        key={file}
        language="latex"
        theme={monacoThemeFor(theme)}
        path={`split://${file}`}
        value={tab?.content ?? ""}
        beforeMount={beforeMount}
        onMount={onMount}
        onChange={(v) => {
          if (v === undefined || !useProjectStore.getState().tabs.some((x) => x.path === file)) return;
          useProjectStore.getState().setTabContent(file, v);
          saveDraft(useProjectStore.getState().root, file, v);
        }}
        options={{ ...EDITOR_OPTIONS, fontSize: 13 }}
      />
    </div>
  );
}
