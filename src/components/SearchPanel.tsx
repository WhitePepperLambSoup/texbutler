// Project-wide search & replace (Ctrl+Shift+F).
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, ReplaceAll, Search, WholeWord } from "lucide-react";
import { api, type SearchHit, type SearchOptions } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useUiStore } from "../store/uiStore";
import { dialog, toast } from "../store/feedbackStore";
import { revealLocation } from "../editorBridge";
import { useT } from "../i18n";
import { FileIcon } from "./ProjectTree";

function Highlight({ hit }: { hit: SearchHit }) {
  // columns are UTF-16 based (like the editor); JS strings are UTF-16 too
  const start = hit.col - 1;
  const lead = hit.text.slice(Math.max(0, start - 40), start);
  return (
    <>
      {start > 40 && "…"}
      {lead.trimStart()}
      <mark>{hit.text.slice(start, start + hit.len)}</mark>
      {hit.text.slice(start + hit.len, start + hit.len + 120)}
    </>
  );
}

export default function SearchPanel() {
  const t = useT();
  const root = useProjectStore((s) => s.root);
  const seed = useUiStore((s) => s.searchSeed);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [opts, setOpts] = useState({ regex: false, caseSensitive: false, wholeWord: false });
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [meta, setMeta] = useState<{ files: number; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const options = (): SearchOptions => ({ query, ...opts });

  const run = async (q = query) => {
    const mine = ++seq.current;
    if (!q.trim() || !root) {
      setHits([]);
      setMeta(null);
      setError(null);
      return;
    }
    setBusy(true);
    try {
      // search what is on disk: save the editor buffers first
      await useProjectStore.getState().saveAll();
      const r = await api.searchProject({ ...options(), query: q });
      if (mine !== seq.current) return;
      setHits(r.hits);
      setMeta({ files: new Set(r.hits.map((h) => h.file)).size, truncated: r.truncated });
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setHits([]);
      setMeta(null);
      setError(String(e));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  // debounced live search
  useEffect(() => {
    const id = window.setTimeout(() => void run(), 250);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, opts, root]);

  useEffect(() => {
    if (!seed) return;
    setQuery(seed.query);
    window.requestAnimationFrame(() => inputRef.current?.select());
  }, [seed]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const list = map.get(h.file) ?? [];
      list.push(h);
      map.set(h.file, list);
    }
    return [...map.entries()];
  }, [hits]);

  const replace = async (files: string[] | null) => {
    const count = files ? hits.filter((h) => files.includes(h.file)).length : hits.length;
    const ok = await dialog.confirm({
      title: t("search.replaceTitle"),
      message: t("search.replaceConfirm", {
        n: count,
        files: files ? files.length : grouped.length,
        from: query,
        to: replacement,
      }),
      confirmLabel: t("search.replaceGo"),
    });
    if (!ok) return;
    try {
      await useProjectStore.getState().saveAll();
      const r = await api.replaceInProject(options(), replacement, files);
      // open clean tabs follow the disk; reload explicitly for immediacy
      for (const f of r.files_changed) await useProjectStore.getState().reloadTab(f);
      toast.success(t("search.replaced", { n: r.replacements, files: r.files_changed.length }));
      await run();
    } catch (e) {
      toast.error(e);
    }
  };

  const toggle = (key: keyof typeof opts, label: string, icon: JSX.Element) => (
    <button
      className="icon-btn icon-btn-sm"
      aria-pressed={opts[key]}
      title={label}
      aria-label={label}
      onClick={() => setOpts((o) => ({ ...o, [key]: !o[key] }))}
    >
      {icon}
    </button>
  );

  return (
    <div className="search-panel">
      <div className="search-form">
        <div className="search-row">
          <button
            className="icon-btn icon-btn-sm"
            title={t("search.toggleReplace")}
            aria-label={t("search.toggleReplace")}
            onClick={() => setShowReplace((v) => !v)}
          >
            {showReplace ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <div className="search-input-wrap">
            <input
              ref={inputRef}
              className="input search-input"
              value={query}
              placeholder={t("search.placeholder")}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void run()}
            />
            <span className="search-toggles">
              {toggle("caseSensitive", t("search.case"), <CaseSensitive size={14} />)}
              {toggle("wholeWord", t("search.word"), <WholeWord size={14} />)}
              {toggle("regex", t("search.regex"), <Regex size={14} />)}
            </span>
          </div>
        </div>
        {showReplace && (
          <div className="search-row">
            <span style={{ width: 22 }} />
            <div className="search-input-wrap">
              <input
                className="input search-replace-input"
                value={replacement}
                placeholder={t("search.replacePlaceholder")}
                spellCheck={false}
                onChange={(e) => setReplacement(e.target.value)}
              />
              <span className="search-toggles">
                <button
                  className="icon-btn icon-btn-sm search-replace-all"
                  title={t("search.replaceAll")}
                  aria-label={t("search.replaceAll")}
                  disabled={hits.length === 0}
                  onClick={() => void replace(null)}
                >
                  <ReplaceAll size={14} />
                </button>
              </span>
            </div>
          </div>
        )}
        <div className="search-meta">
          {busy ? (
            <span>{t("common.loading")}</span>
          ) : error ? (
            <span className="search-error">{error}</span>
          ) : meta ? (
            <span>
              {t("search.summary", { n: hits.length, files: meta.files })}
              {meta.truncated && ` · ${t("search.truncated")}`}
            </span>
          ) : null}
        </div>
      </div>
      <div className="search-results">
        {!busy && query.trim() && hits.length === 0 && !error && (
          <div className="panel-empty">
            <Search size={24} />
            {t("search.none")}
          </div>
        )}
        {grouped.map(([file, list]) => {
          const isCollapsed = collapsed.has(file);
          return (
            <Fragment key={file}>
              <div className="search-file">
                <button
                  className="search-file-head"
                  onClick={() =>
                    setCollapsed((s) => {
                      const next = new Set(s);
                      if (next.has(file)) next.delete(file);
                      else next.add(file);
                      return next;
                    })
                  }
                  title={file}
                >
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <FileIcon name={file} size={14} />
                  <span className="search-file-name">{file.split("/").pop()}</span>
                  <span className="search-file-dir">{file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""}</span>
                  <span className="count-badge">{list.length}</span>
                </button>
                {showReplace && (
                  <button
                    className="icon-btn icon-btn-sm search-replace-file"
                    title={t("search.replaceInFile")}
                    aria-label={t("search.replaceInFile")}
                    onClick={() => void replace([file])}
                  >
                    <Replace size={13} />
                  </button>
                )}
              </div>
              {!isCollapsed &&
                list.map((h, i) => (
                  <button
                    key={`${h.line}-${h.col}-${i}`}
                    className="search-hit"
                    onClick={() => void revealLocation(h.file, h.line, h.col).catch(toast.error)}
                    title={`${h.file}:${h.line}`}
                  >
                    <span className="search-hit-line">{h.line}</span>
                    <span className="search-hit-text">
                      <Highlight hit={h} />
                    </span>
                  </button>
                ))}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
