// Bibliography panel: parsed .bib entries (click to insert \cite) plus a
// DOI / arXiv → BibTeX fetcher.
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookMarked, Copy, Download, Library, Search } from "lucide-react";
import { api, type BibEntry, type ReferenceReport } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useUiStore } from "../store/uiStore";
import { insertText, revealLocation } from "../editorBridge";
import { toast } from "../store/feedbackStore";
import { useT } from "../i18n";

export default function BibPanel() {
  const t = useT();
  const root = useProjectStore((s) => s.root);
  const files = useProjectStore((s) => s.files);
  const [entries, setEntries] = useState<BibEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [report, setReport] = useState<ReferenceReport | null>(null);
  const [unusedOnly, setUnusedOnly] = useState(false);
  const seqRef = useRef(0);

  // reload when the project or its file list changes (a .bib was saved)
  useEffect(() => {
    if (!root) return;
    const seq = ++seqRef.current;
    setLoading(true);
    api
      .listBibEntries()
      .then((r) => seqRef.current === seq && setEntries(r))
      .catch(() => seqRef.current === seq && setEntries([]))
      .finally(() => seqRef.current === seq && setLoading(false));
  }, [root, files]);

  // citation check: cite counts + \cite keys without an entry
  useEffect(() => {
    if (!root) return;
    void api.referenceReport().then(setReport).catch(() => setReport(null));
  }, [root, files]);

  useEffect(() => {
    const onSaved = () => {
      void api.listBibEntries().then(setEntries).catch(() => undefined);
      void api.referenceReport().then(setReport).catch(() => undefined);
    };
    window.addEventListener("tb:file-saved", onSaved);
    return () => window.removeEventListener("tb:file-saved", onSaved);
  }, []);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (!q || [e.key, e.title, e.author, e.year].some((v) => v?.toLowerCase().includes(q))) &&
        (!unusedOnly || citeCount(e.key) === 0),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, filter, unusedOnly, report]);

  function citeCount(key: string): number {
    if (report?.nocite_all) return 1;
    return report?.bib.find((b) => b.key === key)?.cites ?? 0;
  }
  const unusedCount = report && !report.nocite_all ? report.bib.filter((b) => b.cites === 0).length : 0;

  const insert = (text: string) => {
    if (!insertText(text, "cite")) toast.info(t("bib.openFileFirst"));
  };

  // DOI / arXiv → BibTeX
  const [idInput, setIdInput] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState<string | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const fetchBib = async () => {
    const id = idInput.trim();
    if (!id || fetching) return;
    setFetching(true);
    setFetchErr(null);
    setFetched(null);
    try {
      setFetched(await api.bibFromId(id));
    } catch (e) {
      setFetchErr(String(e));
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="bib-panel panel-scroll">
      <div className="bib-fetch">
        <input
          className="input bib-fetch-input"
          placeholder={t("bib.idPlaceholder")}
          value={idInput}
          onChange={(e) => setIdInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void fetchBib();
          }}
        />
        <button
          className="icon-btn"
          title={t("bib.idFetch")}
          aria-label={t("bib.idFetch")}
          disabled={!idInput.trim() || fetching}
          onClick={() => void fetchBib()}
        >
          <Download size={15} className={fetching ? "spinner" : undefined} />
        </button>
        <button
          className="icon-btn bib-zotero"
          title={t("zotero.title")}
          aria-label={t("zotero.title")}
          onClick={() => useUiStore.getState().openModal({ kind: "zotero" })}
        >
          <Library size={15} />
        </button>
      </div>
      {fetched && (
        <div className="bib-fetched">
          <pre className="bib-fetched-pre">{fetched}</pre>
          <div className="modal-actions">
            <button className="btn-mini btn-primary" onClick={() => insert(fetched)}>
              {t("bib.idInsert")}
            </button>
            <button className="btn-mini" onClick={() => void navigator.clipboard.writeText(fetched).then(() => toast.success(t("common.copied")))}>
              <Copy size={13} /> {t("common.copy")}
            </button>
          </div>
        </div>
      )}
      {fetchErr && <div className="bib-fetch-err">{fetchErr}</div>}
      {entries.length > 6 && (
        <div className="bib-fetch">
          <Search size={14} style={{ alignSelf: "center", color: "var(--fg-faint)" }} />
          <input
            className="input"
            placeholder={t("bib.filter")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}
      {report && report.missing_cites.length > 0 && (
        <section className="report-section warn">
          <h5>
            <AlertTriangle size={13} /> {t("bib.missing")} <span className="count-badge warn">{report.missing_cites.length}</span>
          </h5>
          {report.missing_cites.map((m, i) => (
            <button key={i} className="report-row" onClick={() => void revealLocation(m.file, m.line).catch(toast.error)}>
              <code>{m.key}</code>
              <span className="report-loc">
                {m.file}:{m.line}
              </span>
            </button>
          ))}
        </section>
      )}
      {unusedCount > 0 && (
        <label className="check-row bib-unused-toggle">
          <input type="checkbox" checked={unusedOnly} onChange={(e) => setUnusedOnly(e.target.checked)} />
          {t("bib.unusedOnly", { n: unusedCount })}
        </label>
      )}
      {loading && entries.length === 0 ? (
        <div className="panel-empty">{t("common.loading")}</div>
      ) : entries.length === 0 ? (
        <div className="panel-empty">
          <BookMarked size={28} />
          {t("bib.empty")}
        </div>
      ) : (
        <div className="bib-list">
          {visible.map((e) => (
            <button key={e.key} className="bib-item" onClick={() => insert(`\\cite{${e.key}}`)} title={t("bib.insertTitle", { key: e.key })}>
              <span className="bib-title">{e.title || e.key}</span>
              <span className="bib-meta">
                <span className="bib-key">{e.key}</span> · {[e.author, e.year].filter(Boolean).join(", ")}
              </span>
              {report && (citeCount(e.key) === 0 ? <span className="pill warn">{t("bib.uncited")}</span> : <span className="pill">{t("bib.citedN", { n: citeCount(e.key) })}</span>)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
