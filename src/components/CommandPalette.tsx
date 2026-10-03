// Quick open (Ctrl+P), split-file picker and command palette (Ctrl+Shift+P
// or a leading ">"), with fuzzy matching and full keyboard control.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, Columns2, CornerDownLeft, FileText, Search, Terminal } from "lucide-react";
import { useProjectStore } from "../store/projectStore";
import { useUiStore, type PaletteMode } from "../store/uiStore";
import { useT } from "../i18n";
import type { ProjectFileNode } from "../api";
import { buildCommands, fuzzyScore } from "../commands";

interface Item {
  key: string;
  title: string;
  detail?: string;
  shortcut?: string;
  icon: "file" | "command";
  run: () => void;
}

function flatten(nodes: ProjectFileNode[], out: ProjectFileNode[] = []): ProjectFileNode[] {
  for (const n of nodes) {
    if (n.is_dir) flatten(n.children ?? [], out);
    else out.push(n);
  }
  return out;
}

export default function CommandPalette({ mode }: { mode: PaletteMode }) {
  const t = useT();
  const files = useProjectStore((s) => s.files);
  const close = useUiStore((s) => s.closePalette);
  const [query, setQuery] = useState(mode === "commands" ? ">" : "");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commandMode = mode !== "split" && query.startsWith(">");
  const q = (commandMode ? query.slice(1) : query).trim();

  const items: Item[] = useMemo(() => {
    if (commandMode) {
      return buildCommands()
        .map((c) => ({ c, score: fuzzyScore(c.title, q) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => (q ? b.score - a.score : 0))
        .map(({ c }) => ({ key: c.id, title: c.title, shortcut: c.shortcut, icon: "command" as const, run: c.run }));
    }
    const all = flatten(files);
    const pick = (path: string) => {
      if (mode === "split") useUiStore.getState().setSplitFile(path);
      else void useProjectStore.getState().openFile(path);
    };
    return all
      .map((f) => {
        // prefer matches in the file name over matches in the directory
        const nameScore = fuzzyScore(f.name, q);
        const pathScore = fuzzyScore(f.path, q);
        return { f, score: Math.max(nameScore >= 0 ? nameScore + 200 : -1, pathScore) };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => (q ? b.score - a.score : a.f.path.localeCompare(b.f.path)))
      .slice(0, 50)
      .map(({ f }) => {
        const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
        return { key: f.path, title: f.name, detail: dir, icon: "file" as const, run: () => pick(f.path) };
      });
  }, [commandMode, q, files, mode]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector(".quick-open-item.active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (item: Item | undefined) => {
    if (!item) return;
    close();
    item.run();
  };

  const placeholder =
    mode === "split" ? t("palette.splitPlaceholder") : commandMode ? t("palette.commandPlaceholder") : t("quickOpen.placeholder");

  return (
    <div
      className="modal-backdrop palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal palette quick-open" role="dialog" aria-modal="true">
        <div className="palette-input-row">
          {mode === "split" ? <Columns2 size={16} /> : commandMode ? <Terminal size={16} /> : <Search size={16} />}
          <input
            ref={inputRef}
            className="quick-open-input"
            placeholder={placeholder}
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                run(items[index]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
          />
        </div>
        <div className="quick-open-list" ref={listRef} role="listbox">
          {items.map((item, i) => (
            <button
              key={item.key}
              role="option"
              aria-selected={i === index}
              className={`quick-open-item ${i === index ? "active" : ""}`}
              onMouseMove={() => setIndex(i)}
              onClick={() => run(item)}
            >
              {item.icon === "file" ? <FileText size={15} /> : <Terminal size={15} />}
              <span className="quick-open-title">{item.title}</span>
              {item.detail && <span className="quick-open-path">{item.detail}</span>}
              {item.shortcut && <span className="quick-open-kbd">{item.shortcut}</span>}
            </button>
          ))}
          {items.length === 0 && <div className="panel-empty">{t("quickOpen.empty")}</div>}
        </div>
        <div className="palette-footer">
          <span>
            <ArrowDownUp size={12} /> {t("palette.navigate")}
          </span>
          <span>
            <CornerDownLeft size={12} /> {t("palette.select")}
          </span>
          <span>
            <kbd>Esc</kbd> {t("common.close")}
          </span>
          {mode === "files" && !commandMode && (
            <span>
              <kbd>&gt;</kbd> {t("palette.commandsHint")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
