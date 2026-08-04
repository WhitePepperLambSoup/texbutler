// Quick file open (Ctrl+P): filter project files, Enter to open.
import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectStore } from "../store/projectStore";
import { useT } from "../i18n";
import type { ProjectFileNode } from "../api";

function flatten(nodes: ProjectFileNode[]): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = [];
  for (const n of nodes) {
    if (n.is_dir) {
      out.push(...flatten(n.children ?? []));
    } else {
      out.push({ path: n.path, name: n.path.split("/").pop() ?? n.path });
    }
  }
  return out;
}

export default function QuickOpenModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const files = useProjectStore((s) => s.files);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const all = useMemo(() => flatten(files), [files]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 30);
    return all.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 30);
  }, [all, query]);

  const open = (path: string) => {
    void useProjectStore.getState().openFile(path);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box quick-open" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="quick-open-input"
          placeholder={t("quickOpen.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered[0]) open(filtered[0].path);
          }}
        />
        <div className="quick-open-list">
          {filtered.map((f) => (
            <button key={f.path} className="quick-open-item" onClick={() => open(f.path)}>
              <span className="quick-open-path">{f.path}</span>
            </button>
          ))}
          {filtered.length === 0 && <div className="panel-empty">{t("quickOpen.empty")}</div>}
        </div>
      </div>
    </div>
  );
}
