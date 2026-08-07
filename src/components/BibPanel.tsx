// Bibliography panel: parsed .bib entries, click to insert a \cite.
import { useEffect, useRef, useState } from "react";
import { api, type BibEntry } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useT } from "../i18n";

export default function BibPanel() {
  const t = useT();
  const activeTab = useProjectStore((s) => s.activeTab);
  const [entries, setEntries] = useState<BibEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!activeTab) return;
    const seq = ++seqRef.current;
    setLoading(true);
    void api
      .listBibEntries()
      .then((r) => {
        if (seqRef.current === seq) setEntries(r);
      })
      .catch(() => {
        if (seqRef.current === seq) setEntries([]);
      })
      .finally(() => {
        if (seqRef.current === seq) setLoading(false);
      });
  }, [activeTab]);

  const insertCite = (key: string) => {
    window.dispatchEvent(new CustomEvent("tb:insert-text", { detail: { text: `\\cite{${key}}` } }));
  };

  // DOI / arXiv → BibTeX: fetch metadata and insert the entry into the
  // clipboard-ready box at the top of the panel
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

  if (!activeTab) return <div className="panel-empty">{t("tree.noProject")}</div>;
  if (loading) return <div className="panel-empty">{t("ai.busyDiagnose")}</div>;
  if (entries.length === 0) return <div className="panel-empty">{t("bib.empty")}</div>;

  return (
    <div className="bib-list">
      <div className="bib-fetch">
        <input
          className="bib-fetch-input"
          placeholder={t("bib.idPlaceholder")}
          value={idInput}
          onChange={(e) => setIdInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !(e.nativeEvent as KeyboardEvent).isComposing) void fetchBib();
          }}
        />
        <button className="btn-mini" disabled={!idInput.trim() || fetching} onClick={() => void fetchBib()}>
          {fetching ? "…" : t("bib.idFetch")}
        </button>
      </div>
      {fetched && (
        <div className="bib-fetched">
          <pre className="bib-fetched-pre">{fetched}</pre>
          <button
            className="btn-mini"
            onClick={() => {
              void navigator.clipboard.writeText(fetched).catch(() => undefined);
              window.dispatchEvent(new CustomEvent("tb:insert-text", { detail: { text: fetched } }));
            }}
          >
            {t("bib.idInsert")}
          </button>
        </div>
      )}
      {fetchErr && <div className="bib-fetch-err">{fetchErr}</div>}
      {entries.map((e) => (
        <button key={e.key} className="bib-item" onClick={() => insertCite(e.key)} title={`\\cite{${e.key}}`}>
          <span className="bib-title">{e.title || e.key}</span>
          <span className="bib-meta">
            {[e.author, e.year].filter(Boolean).join(", ")} ({e.entry_type})
          </span>
        </button>
      ))}
    </div>
  );
}
