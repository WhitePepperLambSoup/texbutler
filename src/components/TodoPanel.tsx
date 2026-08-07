import { useEffect, useState } from "react";
import { api, type TodoHit } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useT } from "../i18n";

/** TODO/FIXME scanner panel: every marker inside LaTeX comments across the
 *  project; click a row to jump to it in the editor. */
export default function TodoPanel() {
  const t = useT();
  const root = useProjectStore((s) => s.root);
  const [hits, setHits] = useState<TodoHit[]>([]);

  useEffect(() => {
    if (!root) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await api.scanTodos();
        if (alive) setHits(r);
      } catch {
        if (alive) setHits([]);
      }
    };
    void load();
    const onSaved = () => void load();
    window.addEventListener("tb:file-saved", onSaved);
    return () => {
      alive = false;
      window.removeEventListener("tb:file-saved", onSaved);
    };
  }, [root]);

  const jump = async (hit: TodoHit) => {
    const st = useProjectStore.getState();
    await st.openFile(hit.file);
    await new Promise((r) => setTimeout(r, 60));
    window.dispatchEvent(
      new CustomEvent("tb:reveal", { detail: { file: hit.file, line: hit.line } }),
    );
  };

  return (
    <div className="tree-scroll">
      {hits.length === 0 ? (
        <div className="panel-empty">{t("todo.empty")}</div>
      ) : (
        hits.map((h, i) => (
          <button key={`${h.file}-${h.line}-${i}`} className="todo-row" onClick={() => void jump(h)}>
            <span className="todo-file">{h.file}</span>
            <span className="todo-line">{h.line}</span>
            <span className="todo-text">{h.text}</span>
          </button>
        ))
      )}
    </div>
  );
}
