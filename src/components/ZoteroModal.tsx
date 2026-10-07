// Cite from Zotero: search the library through Better BibTeX, pick items,
// insert \cite{...} at the cursor and append missing entries to the .bib.
import { useEffect, useMemo, useRef, useState } from "react";
import { BookPlus, CheckCircle2, Library, Loader2, Quote, Search, XCircle } from "lucide-react";
import { api, type ProjectFileNode, type ZoteroItem } from "../api";
import { useProjectStore } from "../store/projectStore";
import { toast } from "../store/feedbackStore";
import { insertText } from "../editorBridge";
import { useT } from "../i18n";
import Modal from "./ui/Modal";

const NEW_BIB = "\u0000new";

export function zoteroUrl(): string | null {
  try {
    return localStorage.getItem("tb-zotero-url") || null;
  } catch {
    return null;
  }
}

function bibFiles(nodes: ProjectFileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.is_dir) bibFiles(n.children, out);
    else if (n.path.toLowerCase().endsWith(".bib")) out.push(n.path);
  }
  return out;
}

export default function ZoteroModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const files = useProjectStore((s) => s.files);
  const bibs = useMemo(() => bibFiles(files), [files]);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ZoteroItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [target, setTarget] = useState<string>(() => bibs[0] ?? NEW_BIB);
  const [working, setWorking] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    api
      .zoteroStatus(zoteroUrl())
      .then((s) => setStatus({ ok: true, text: t("zotero.connected", { zotero: s.zotero, bbt: s.betterbibtex }) }))
      .catch((e) => setStatus({ ok: false, text: String(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // debounced live search
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setItems([]);
      setError(null);
      return;
    }
    const mine = ++seq.current;
    const id = window.setTimeout(() => {
      setBusy(true);
      api
        .zoteroSearch(q, zoteroUrl())
        .then((r) => {
          if (mine !== seq.current) return;
          setItems(r);
          setError(null);
        })
        .catch((e) => mine === seq.current && (setItems([]), setError(String(e))))
        .finally(() => mine === seq.current && setBusy(false));
    }, 300);
    return () => window.clearTimeout(id);
  }, [query]);

  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  const run = async (insert: boolean) => {
    if (picked.length === 0) return;
    setWorking(true);
    try {
      const r = await api.zoteroAdd(picked, target === NEW_BIB ? null : target, zoteroUrl());
      await useProjectStore.getState().refresh().catch(() => undefined);
      void useProjectStore.getState().loadRefIndex();
      if (useProjectStore.getState().tabs.some((tab) => tab.path === r.bib_file)) {
        await useProjectStore.getState().reloadTab(r.bib_file);
      }
      if (insert && !insertText(`\\cite{${picked.join(",")}}`, "zotero")) toast.info(t("bib.openFileFirst"));
      toast.success(t("zotero.added", { n: r.added.length, file: r.bib_file }));
      if (r.created) toast.info(t("zotero.created", { file: r.bib_file }));
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal
      title={
        <>
          <Library size={16} /> {t("zotero.title")}
        </>
      }
      onClose={onClose}
      className="zotero-modal"
      onSubmit={() => void run(true)}
      footer={
        <>
          <span className="footer-note">{picked.length ? t("zotero.picked", { n: picked.length }) : t("zotero.hint")}</span>
          <select className="input compact zotero-target" value={target} onChange={(e) => setTarget(e.target.value)} title={t("zotero.target")}>
            {bibs.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
            {bibs.length === 0 && <option value={NEW_BIB}>{t("zotero.newBib")}</option>}
          </select>
          <button className="btn zotero-add-only" disabled={!picked.length || working} onClick={() => void run(false)}>
            <BookPlus size={14} /> {t("zotero.addOnly")}
          </button>
          <button className="btn btn-primary zotero-cite" disabled={!picked.length || working} onClick={() => void run(true)}>
            {working ? <Loader2 size={14} className="spinner" /> : <Quote size={14} />} {t("zotero.cite")}
          </button>
        </>
      }
    >
      <div className={`zotero-status ${status ? (status.ok ? "ok" : "bad") : ""}`}>
        {status === null ? (
          <Loader2 size={14} className="spinner" />
        ) : status.ok ? (
          <CheckCircle2 size={14} className="ok-icon" />
        ) : (
          <XCircle size={14} className="bad-icon" />
        )}
        <span>{status?.text ?? t("zotero.connecting")}</span>
      </div>
      <div className="search-input-wrap">
        <input
          className="input zotero-query"
          value={query}
          placeholder={t("zotero.placeholder")}
          onChange={(e) => setQuery(e.target.value)}
          data-autofocus
          spellCheck={false}
        />
      </div>
      <div className="zotero-results">
        {busy && items.length === 0 && (
          <div className="panel-empty">
            <Loader2 size={18} className="spinner" />
          </div>
        )}
        {error && <div className="modal-error">{error}</div>}
        {!busy && !error && query.trim() && items.length === 0 && (
          <div className="panel-empty">
            <Search size={22} />
            {t("zotero.none")}
          </div>
        )}
        {items.map((it) => (
          <label key={it.citekey} className={`zotero-item ${picked.includes(it.citekey) ? "picked" : ""}`}>
            <input type="checkbox" checked={picked.includes(it.citekey)} onChange={() => toggle(it.citekey)} />
            <span className="zotero-item-main">
              <span className="zotero-item-title">{it.title || it.citekey}</span>
              <span className="zotero-item-meta">
                {[it.authors, it.year, it.container].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="zotero-item-side">
              <code>{it.citekey}</code>
              {it.in_project && <span className="pill ok">{t("zotero.inProject")}</span>}
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
