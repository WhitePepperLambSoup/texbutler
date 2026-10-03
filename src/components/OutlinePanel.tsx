// Outline panel: section tree of the current file, click to jump; the
// section containing the cursor is highlighted.
import { useMemo } from "react";
import { ListTree } from "lucide-react";
import { useProjectStore } from "../store/projectStore";
import { useUiStore } from "../store/uiStore";
import { revealLocation } from "../editorBridge";
import { useT } from "../i18n";

interface OutlineItem {
  level: number;
  title: string;
  line: number;
}

const LEVELS: Record<string, number> = {
  part: -1,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

/** Parse sectioning commands with their real line numbers. */
export function parseOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = text.split("\n");
  const re = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    items.push({ level: LEVELS[m[1]] ?? 1, title: m[2].trim() || "…", line: i + 1 });
  }
  return items;
}

export default function OutlinePanel() {
  const t = useT();
  const activeTab = useProjectStore((s) => s.activeTab);
  const content = useProjectStore((s) => s.tabs.find((tab) => tab.path === s.activeTab)?.content ?? "");
  const cursorLine = useUiStore((s) => s.cursor?.line ?? 0);
  const items = useMemo(() => parseOutline(content), [content]);
  const minLevel = items.reduce((m, it) => Math.min(m, it.level), 9);
  let current = -1;
  items.forEach((it, i) => {
    if (it.line <= cursorLine) current = i;
  });

  if (!activeTab) return <div className="panel-empty">{t("editor.empty")}</div>;
  if (items.length === 0) {
    return (
      <div className="panel-empty">
        <ListTree size={28} />
        {t("outline.empty")}
      </div>
    );
  }

  return (
    <div className="outline-list">
      {items.map((it, idx) => (
        <button
          key={`${it.line}-${idx}`}
          className={`outline-item level-${it.level} ${idx === current ? "current" : ""}`}
          style={{ paddingLeft: 8 + (it.level - minLevel) * 14 }}
          title={`${it.title} · ${t("outline.line", { n: it.line })}`}
          onClick={() => void revealLocation(activeTab, it.line)}
        >
          <span className="outline-marker" />
          <span className="outline-title">{it.title}</span>
          <span className="outline-line">{it.line}</span>
        </button>
      ))}
    </div>
  );
}
