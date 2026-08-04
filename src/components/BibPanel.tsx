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

  if (!activeTab) return <div className="panel-empty">{t("tree.noProject")}</div>;
  if (loading) return <div className="panel-empty">{t("ai.busyDiagnose")}</div>;
  if (entries.length === 0) return <div className="panel-empty">{t("bib.empty")}</div>;

  return (
    <div className="bib-list">
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
