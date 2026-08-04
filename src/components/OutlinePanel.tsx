// Outline panel: section tree of the current file, click to jump.
import { useEffect, useMemo, useState } from "react";
import { useProjectStore } from "../store/projectStore";
import { useT } from "../i18n";

interface OutlineItem {
  level: number;
  title: string;
  line: number;
}

/** Parse sectioning commands with their real line numbers. */
export function parseOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = text.split("\n");
  const re = /^\s*\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const levelMap: Record<string, number> = {
      chapter: 0,
      section: 1,
      subsection: 2,
      subsubsection: 3,
      paragraph: 4,
      subparagraph: 5,
    };
    items.push({ level: levelMap[m[1]] ?? 1, title: m[2].trim(), line: i + 1 });
  }
  return items;
}

export default function OutlinePanel() {
  const t = useT();
  const activeTab = useProjectStore((s) => s.activeTab);
  const activeContent = useProjectStore((s) => s.tabs.find((t) => t.path === s.activeTab)?.content ?? "");
  const [text, setText] = useState(activeContent);

  useEffect(() => {
    setText(activeContent);
  }, [activeTab, activeContent]);

  const items = useMemo(() => parseOutline(text ?? ""), [text]);

  if (!activeTab) return <div className="panel-empty">{t("tree.noProject")}</div>;
  if (items.length === 0) return <div className="panel-empty">{t("outline.empty")}</div>;

  return (
    <div className="outline-list">
      {items.map((it, idx) => (
        <button
          key={idx}
          className="outline-item"
          style={{ paddingLeft: 10 + it.level * 14 }}
          title={`${it.line}`}
          onClick={() =>
            window.dispatchEvent(new CustomEvent("tb:goto-line", { detail: { line: it.line } }))
          }
        >
          {it.title}
        </button>
      ))}
    </div>
  );
}
