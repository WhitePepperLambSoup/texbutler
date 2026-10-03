import { useEffect, useState } from "react";
import { ListTodo } from "lucide-react";
import { api, type TodoHit } from "../api";
import { useProjectStore } from "../store/projectStore";
import { revealLocation } from "../editorBridge";
import { toast } from "../store/feedbackStore";
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
    window.addEventListener("tb:file-saved", load);
    return () => {
      alive = false;
      window.removeEventListener("tb:file-saved", load);
    };
  }, [root]);

  if (hits.length === 0) {
    return (
      <div className="panel-empty">
        <ListTodo size={28} />
        {t("todo.empty")}
      </div>
    );
  }

  return (
    <div className="bib-list">
      {hits.map((h, i) => {
        const tag = /FIXME/i.test(h.text) ? "FIXME" : /XXX/.test(h.text) ? "XXX" : "TODO";
        const text = h.text.replace(/^\s*%*\s*(TODO|FIXME|XXX)\s*:?\s*/i, "") || h.text;
        return (
          <button
            key={`${h.file}-${h.line}-${i}`}
            className="todo-row"
            onClick={() => void revealLocation(h.file, h.line).catch(toast.error)}
          >
            <span className={`todo-tag ${tag.toLowerCase()}`}>{tag}</span>
            <span className="todo-text">{text}</span>
            <span className="todo-file">
              {h.file}:{h.line}
            </span>
          </button>
        );
      })}
    </div>
  );
}
