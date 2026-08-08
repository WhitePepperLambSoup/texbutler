import { useEffect, useState } from "react";
import { api, type MarketTemplate } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useT } from "../i18n";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
interface Props {
  open: boolean;
  onClose: () => void;
}

const CATEGORIES = ["全部", "985", "双一流", "科研院所", "海外QS100", "通用"];

/** New-project dialog: parent dir + name + template picker with a
 *  marketplace tab (search / category filter / download-on-demand). */
export default function NewProjectModal({ open, onClose }: Props) {
  const [templates, setTemplates] = useState<{ id: string; name: string; source: string }[]>([]);
  const [market, setMarket] = useState<MarketTemplate[]>([]);
  const [marketTab, setMarketTab] = useState<"basic" | "market">("basic");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("全部");
  const [downloading, setDownloading] = useState<string | null>(null);
  const [parent, setParent] = useState("");
  const browseDir = async () => {
    try {
      const dir = await openDialog({ directory: true, title: t("newProject.browseTitle") });
      if (typeof dir === "string") setParent(dir);
    } catch {
      /* cancelled */
    }
  };
  const [name, setName] = useState("my-latex-project");
  const [template, setTemplate] = useState("article");
  const [busy, setBusy] = useState(false);
  const { createProject } = useProjectStore();
  const t = useT();

  const reloadMarket = () => {
    void api.listMarketTemplates().then(setMarket).catch(() => setMarket([]));
  };

  useEffect(() => {
    if (open) {
      void api.listTemplates().then(setTemplates).catch(() => setTemplates([]));
      reloadMarket();
    }
  }, [open]);

  if (!open) return null;

  const doCreate = async () => {
    if (!parent.trim()) {
      window.alert(t("newProject.parentRequired"));
      return;
    }
    if (!name.trim()) {
      window.alert(t("newProject.nameRequired"));
      return;
    }
    setBusy(true);
    try {
      const marketTpl = market.find((m) => m.id === template);
      if (marketTpl) {
        // marketplace template: the backend copies the template tree
        const dir = await api.createFromMarketTemplate(parent.trim(), name.trim(), template);
        await useProjectStore.getState().openProject(dir);
        onClose();
      } else {
        await createProject(parent.trim(), name.trim(), template);
        onClose();
      }
    } catch (e) {
      window.alert(t("newProject.failed", { e: String(e) }));
    }
    setBusy(false);
  };

  const filtered = market.filter((m) => {
    if (category !== "全部" && m.category !== category) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      if (!m.name.toLowerCase().includes(q) && !m.desc.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t("newProject.title")}</span>
          <button className="btn-mini" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <label>
            {t("newProject.parent")}
            <div className="path-row">
              <input
                value={parent}
                placeholder="如 D:\documents"
                onChange={(e) => setParent(e.target.value)}
              />
              <button className="btn-mini" type="button" onClick={() => void browseDir()}>
                {t("newProject.browse")}
              </button>
            </div>
          </label>
          <label>
            {t("newProject.name")}
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <div className="market-tabs">
            <button
              className={`market-tab ${marketTab === "basic" ? "active" : ""}`}
              onClick={() => setMarketTab("basic")}
            >
              {t("newProject.tabBasic")}
            </button>
            <button
              className={`market-tab ${marketTab === "market" ? "active" : ""}`}
              onClick={() => setMarketTab("market")}
            >
              {t("newProject.tabMarket")}
            </button>
          </div>

          {marketTab === "basic" ? (
            <label>
              {t("newProject.template")}
              <div className="template-grid">
                {templates.map((tp) => (
                  <span key={tp.id} className="template-wrap">
                    <button
                      className={`template-card ${template === tp.id ? "template-active" : ""}`}
                      onClick={() => setTemplate(tp.id)}
                    >
                      {tp.name}
                    </button>
                    {tp.source === "user" && (
                      <button
                        className="btn-mini template-del"
                        title="删除模板"
                        onClick={async () => {
                          await api.deleteTemplate(tp.id).catch((e) => window.alert(String(e)));
                          void api.listTemplates().then(setTemplates).catch(() => undefined);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </label>
          ) : (
            <div className="market-panel">
              <div className="market-toolbar">
                <input
                  className="market-search"
                  placeholder={t("newProject.marketSearch")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  className="market-cat"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="market-list">
                {filtered.map((m) => (
                  <button
                    key={m.id}
                    className={`market-card ${template === m.id ? "template-active" : ""}`}
                    onClick={() => {
                      if (m.ready) setTemplate(m.id);
                    }}
                    disabled={!m.ready}
                  >
                    <span className="market-name">{m.name}</span>
                    <span className="market-desc">{m.desc}</span>
                    <span className="market-meta">
                      {m.stars > 0 ? `★ ${m.stars} · ` : ""}
                      {m.size_kb >= 1024 ? `${(m.size_kb / 1024).toFixed(1)} MB` : `${m.size_kb} KB`}
                      {m.verified ? (
                        <span className="market-ready">✓ {t("newProject.marketVerified")}</span>
                      ) : m.ready ? (
                        <span className="market-ready">✓ {t("newProject.marketReady")}</span>
                      ) : (
                        <span
                          className="market-dl"
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (downloading) return;
                            setDownloading(m.id);
                            void api
                              .downloadTemplate(m.id)
                              .then(() => reloadMarket())
                              .catch((err) => window.alert(String(err)))
                              .finally(() => setDownloading(null));
                          }}
                        >
                          {downloading === m.id ? "…" : t("newProject.marketDownload")}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
                {filtered.length === 0 && (
                  <div className="panel-empty">{t("newProject.marketEmpty")}</div>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-mini" onClick={onClose}>
            {t("settings.cancel")}
          </button>
          <button className="btn-mini btn-primary" onClick={() => void doCreate()} disabled={busy}>
            {busy ? t("newProject.creating") : t("newProject.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
