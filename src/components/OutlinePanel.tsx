// Outline: sections of the current file or the whole document (following
// \input / \include from the main file), plus a label/reference report.
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CornerDownLeft, ListTree, Tag } from "lucide-react";
import { api, type ProjectFileNode, type ReferenceReport } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useUiStore } from "../store/uiStore";
import { insertText, revealLocation } from "../editorBridge";
import { toast } from "../store/feedbackStore";
import { useT } from "../i18n";

interface OutlineItem {
  level: number;
  title: string;
  line: number;
  file: string;
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

const SECTION_RE = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/;
const INPUT_RE = /\\(input|include|subfile)\s*\{([^}]+)\}/g;

/** Parse sectioning commands with their real line numbers. */
export function parseOutline(text: string, file = ""): OutlineItem[] {
  const items: OutlineItem[] = [];
  text.split("\n").forEach((line, i) => {
    const m = line.match(SECTION_RE);
    if (m) items.push({ level: LEVELS[m[1]] ?? 1, title: m[2].trim() || "…", line: i + 1, file });
  });
  return items;
}

function flatten(nodes: ProjectFileNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.is_dir) flatten(n.children, out);
    else out.add(n.path);
  }
  return out;
}

/** Walk the document from the main file, inlining \input/\include. */
async function projectOutline(main: string, files: Set<string>): Promise<OutlineItem[]> {
  const st = useProjectStore.getState();
  const read = async (f: string) => st.tabs.find((t) => t.path === f)?.content ?? (await api.readFile(f));
  const mainDir = main.includes("/") ? main.slice(0, main.lastIndexOf("/")) : "";
  const resolve = (name: string, from: string) => {
    const n = name.trim().replace(/^\.\//, "");
    const withExt = /\.[a-z]+$/i.test(n) ? n : `${n}.tex`;
    const fromDir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    // LaTeX resolves \input relative to the compile directory (the main
    // file's folder); fall back to the including file's folder
    for (const dir of [mainDir, fromDir, ""]) {
      const p = dir ? `${dir}/${withExt}` : withExt;
      if (files.has(p)) return p;
    }
    return null;
  };
  const out: OutlineItem[] = [];
  const visited = new Set<string>();
  const walk = async (file: string, depth: number) => {
    if (visited.has(file) || depth > 8) return;
    visited.add(file);
    let text: string;
    try {
      text = await read(file);
    } catch {
      return;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/(^|[^\\])%.*$/, "$1");
      const m = line.match(SECTION_RE);
      if (m) out.push({ level: LEVELS[m[1]] ?? 1, title: m[2].trim() || "…", line: i + 1, file });
      INPUT_RE.lastIndex = 0;
      let inc: RegExpExecArray | null;
      while ((inc = INPUT_RE.exec(line))) {
        const target = resolve(inc[2], file);
        if (target) await walk(target, depth + 1);
      }
    }
  };
  await walk(main, 0);
  return out;
}

type Mode = "file" | "project" | "labels";

function OutlineList({ items, currentKey }: { items: OutlineItem[]; currentKey: string | null }) {
  const t = useT();
  const minLevel = items.reduce((m, it) => Math.min(m, it.level), 9);
  return (
    <div className="outline-list">
      {items.map((it, idx) => (
        <button
          key={`${it.file}:${it.line}:${idx}`}
          className={`outline-item level-${it.level} ${currentKey === `${it.file}:${it.line}` ? "current" : ""}`}
          style={{ paddingLeft: 8 + (it.level - minLevel) * 14 }}
          title={`${it.title} · ${it.file}:${it.line}`}
          onClick={() => void revealLocation(it.file, it.line).catch(toast.error)}
        >
          <span className="outline-marker" />
          <span className="outline-title">{it.title}</span>
          <span className="outline-line">{it.line}</span>
        </button>
      ))}
      {items.length === 0 && (
        <div className="panel-empty">
          <ListTree size={28} />
          {t("outline.empty")}
        </div>
      )}
    </div>
  );
}

function LabelsView() {
  const t = useT();
  const [report, setReport] = useState<ReferenceReport | null>(null);
  const files = useProjectStore((s) => s.files);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void api
        .referenceReport()
        .then((r) => alive && setReport(r))
        .catch(() => alive && setReport(null));
    load();
    window.addEventListener("tb:file-saved", load);
    return () => {
      alive = false;
      window.removeEventListener("tb:file-saved", load);
    };
  }, [files]);

  if (!report) return <div className="panel-empty">{t("common.loading")}</div>;
  const groups = new Map<string, ReferenceReport["labels"]>();
  for (const l of report.labels) {
    const prefix = l.key.includes(":") ? l.key.slice(0, l.key.indexOf(":")) : "other";
    groups.set(prefix, [...(groups.get(prefix) ?? []), l]);
  }
  const jump = (file: string, line: number) => void revealLocation(file, line).catch(toast.error);

  return (
    <div className="labels-view">
      {report.undefined_refs.length > 0 && (
        <section className="report-section warn">
          <h5>
            <AlertTriangle size={13} /> {t("refs.undefined")} <span className="count-badge warn">{report.undefined_refs.length}</span>
          </h5>
          {report.undefined_refs.map((u, i) => (
            <button key={i} className="report-row" onClick={() => jump(u.file, u.line)}>
              <code>{u.key}</code>
              <span className="report-loc">
                {u.file}:{u.line}
              </span>
            </button>
          ))}
        </section>
      )}
      {report.duplicate_labels.length > 0 && (
        <section className="report-section warn">
          <h5>
            <AlertTriangle size={13} /> {t("refs.duplicate")} <span className="count-badge warn">{report.duplicate_labels.length}</span>
          </h5>
          {report.duplicate_labels.map((u, i) => (
            <button key={i} className="report-row" onClick={() => jump(u.file, u.line)}>
              <code>{u.key}</code>
              <span className="report-loc">
                {u.file}:{u.line}
              </span>
            </button>
          ))}
        </section>
      )}
      {[...groups.entries()].map(([prefix, list]) => (
        <section key={prefix} className="report-section">
          <h5>
            <Tag size={13} /> {t(`refs.kind.${prefix}`) === `refs.kind.${prefix}` ? prefix : t(`refs.kind.${prefix}`)}
            <span className="count-badge">{list.length}</span>
          </h5>
          {list.map((l) => (
            <div key={l.key} className="report-row-wrap">
              <button className="report-row" onClick={() => jump(l.file, l.line)} title={`${l.file}:${l.line}`}>
                <code>{l.key}</code>
                {l.refs === 0 ? <span className="pill warn">{t("refs.unused")}</span> : <span className="pill">{t("refs.refCount", { n: l.refs })}</span>}
              </button>
              <button
                className="icon-btn icon-btn-sm"
                title={t("refs.insertRef")}
                aria-label={t("refs.insertRef")}
                onClick={() => {
                  if (!insertText(`\\ref{${l.key}}`, "ref")) toast.info(t("bib.openFileFirst"));
                }}
              >
                <CornerDownLeft size={13} />
              </button>
            </div>
          ))}
        </section>
      ))}
      {report.labels.length === 0 && report.undefined_refs.length === 0 && <div className="panel-empty">{t("refs.none")}</div>}
    </div>
  );
}

export default function OutlinePanel() {
  const t = useT();
  const activeTab = useProjectStore((s) => s.activeTab);
  const mainFile = useProjectStore((s) => s.mainFile);
  const files = useProjectStore((s) => s.files);
  const content = useProjectStore((s) => s.tabs.find((tab) => tab.path === s.activeTab)?.content ?? "");
  const cursorLine = useUiStore((s) => s.cursor?.line ?? 0);
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem("tb-outline-mode") as Mode) || "file");
  const [projectItems, setProjectItems] = useState<OutlineItem[]>([]);

  useEffect(() => {
    localStorage.setItem("tb-outline-mode", mode);
  }, [mode]);

  const fileItems = useMemo(() => parseOutline(content, activeTab ?? ""), [content, activeTab]);

  useEffect(() => {
    if (mode !== "project") return;
    let alive = true;
    const id = window.setTimeout(() => {
      void projectOutline(mainFile, flatten(files)).then((items) => alive && setProjectItems(items));
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [mode, mainFile, files, content]);

  const items = mode === "file" ? fileItems : projectItems;
  let currentKey: string | null = null;
  for (const it of items) {
    if (it.file === activeTab && it.line <= cursorLine) currentKey = `${it.file}:${it.line}`;
  }

  return (
    <div className="outline-panel">
      <div className="segmented outline-modes" role="tablist">
        {(["file", "project", "labels"] as Mode[]).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
            {t(`outline.mode.${m}`)}
          </button>
        ))}
      </div>
      {mode === "labels" ? (
        <LabelsView />
      ) : !activeTab && mode === "file" ? (
        <div className="panel-empty">{t("editor.empty")}</div>
      ) : (
        <OutlineList items={items} currentKey={currentKey} />
      )}
    </div>
  );
}
