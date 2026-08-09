import { useEffect, useMemo, useState } from "react";
import { api, type MarketTemplate } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useT } from "../i18n";

interface Props {
  open: boolean;
  onClose: () => void;
}

type NewFileTab = "basic" | "user" | "market";

type UserTemplate = { id: string; name: string; source: string };

type NewFileModalComponent = (props: Props) => React.ReactElement | null;

const ALL_CATEGORY = "全部";

const basicTemplates = [
  ["article", "tree.tplArticle"],
  ["ctexart", "tree.tplCtexart"],
  ["report", "tree.tplReport"],
  ["beamer", "tree.tplBeamer"],
  ["minimal", "tree.tplMinimal"],
  ["", "tree.tplEmpty"],
] as const;

const NewFileModal: NewFileModalComponent = ({ open, onClose }) => {
  const t = useT();
  const [tab, setTab] = useState<NewFileTab>("basic");
  const [filePath, setFilePath] = useState("new-file.tex");
  const [fileTemplate, setFileTemplate] = useState("article");
  const [userTemplates, setUserTemplates] = useState<UserTemplate[]>([]);
  const [marketTemplates, setMarketTemplates] = useState<MarketTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [targetDir, setTargetDir] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORY);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTemplates = async () => {
    const [users, market] = await Promise.all([
      api.listTemplates().catch(() => []),
      api.listMarketTemplates().catch(() => []),
    ]);
    setUserTemplates(users);
    setMarketTemplates(market);
  };

  useEffect(() => {
    if (open) void loadTemplates();
  }, [open]);

  const categories = useMemo(
    () => [ALL_CATEGORY, ...new Set(marketTemplates.map((template) => template.category))],
    [marketTemplates],
  );
  const visibleMarketTemplates = marketTemplates.filter((template) => {
    if (category !== ALL_CATEGORY && template.category !== category) return false;
    const query = search.trim().toLowerCase();
    return !query || template.name.toLowerCase().includes(query) || template.desc.toLowerCase().includes(query);
  });

  const doCreate = async () => {
    setError(null);
    if (tab === "basic") {
      const path = filePath.trim();
      if (!path) {
        setError(t("tree.newFileName"));
        return;
      }
      setBusy(true);
      try {
        await api.newFile(path, path.endsWith(".tex") ? fileTemplate : undefined);
        await useProjectStore.getState().refresh();
        await useProjectStore.getState().openFile(path);
        onClose();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!selectedTemplate) {
      setError(t("newFile.selectTemplate"));
      return;
    }
    if (!targetDir.trim()) {
      setError(t("newFile.targetRequired"));
      return;
    }
    setBusy(true);
    try {
      const result = await api.importProjectTemplate(
        targetDir.trim(),
        selectedTemplate,
        tab === "user" ? "user" : "market",
      );
      await useProjectStore.getState().refresh();
      await useProjectStore.getState().openFile(result.main_file);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteUserTemplate = async (id: string) => {
    setError(null);
    try {
      await api.deleteTemplate(id);
      if (selectedTemplate === id) setSelectedTemplate(null);
      await loadTemplates();
    } catch (e) {
      setError(String(e));
    }
  };

  const downloadMarketTemplate = async (id: string) => {
    setError(null);
    setSelectedTemplate(null);
    setDownloading(id);
    try {
      await api.downloadTemplate(id);
      await loadTemplates();
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(null);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal new-file-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <span>{t("toolbar.newFile")}</span>
          <button className="btn-mini" onClick={onClose} aria-label={t("settings.cancel")}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="new-file-tabs" role="tablist">
            {(["basic", "user", "market"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`new-file-tab ${tab === value ? "active" : ""}`}
                data-new-file-tab={value}
                onClick={() => {
                  if (value !== tab) setSelectedTemplate(null);
                  setTab(value);
                  setError(null);
                }}
              >
                {t(`newFile.tab${value[0].toUpperCase()}${value.slice(1)}`)}
              </button>
            ))}
          </div>

          <div className="new-file-panel">
            {tab === "basic" && (
              <>
                <label className="target-row">
                  {t("tree.newFileName")}
                  <input value={filePath} onChange={(event) => setFilePath(event.target.value)} />
                </label>
                <label className="new-file-template-select">
                  {t("tree.newFileTemplate")}
                  <select value={fileTemplate} onChange={(event) => setFileTemplate(event.target.value)}>
                    {basicTemplates.map(([id, label]) => (
                      <option key={id || "empty"} value={id}>
                        {t(label)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="template-grid">
                  {basicTemplates.map(([id, label]) => (
                    <button
                      key={id || "empty"}
                      type="button"
                      className={`template-card ${fileTemplate === id ? "template-active" : ""}`}
                      onClick={() => setFileTemplate(id)}
                    >
                      {t(label)}
                    </button>
                  ))}
                </div>
              </>
            )}

            {tab === "user" && (
              <>
                <label className="target-row">
                  {t("newFile.targetDir")}
                  <input value={targetDir} onChange={(event) => setTargetDir(event.target.value)} />
                </label>
                <div className="template-grid">
                  {userTemplates.map((template) => (
                    <span key={template.id} className="template-wrap">
                      <button
                        type="button"
                        className={`template-card ${selectedTemplate === template.id ? "template-active" : ""}`}
                        onClick={() => setSelectedTemplate(template.id)}
                      >
                        {template.name}
                      </button>
                      <button
                        type="button"
                        className="btn-mini template-del"
                        title={t("newFile.deleteTemplate")}
                        onClick={() => void deleteUserTemplate(template.id)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                {userTemplates.length === 0 && <div className="panel-empty">{t("newFile.userEmpty")}</div>}
              </>
            )}

            {tab === "market" && (
              <>
                <label className="target-row">
                  {t("newFile.targetDir")}
                  <input value={targetDir} onChange={(event) => setTargetDir(event.target.value)} />
                </label>
                <div className="market-panel">
                  <div className="market-toolbar">
                    <input
                      className="market-search"
                      placeholder={t("newProject.marketSearch")}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    <select className="market-cat" value={category} onChange={(event) => setCategory(event.target.value)}>
                      {categories.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="market-list">
                    {visibleMarketTemplates.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        className={`market-card ${selectedTemplate === template.id ? "template-active" : ""}`}
                        onClick={() => {
                          if (template.ready) setSelectedTemplate(template.id);
                          else void downloadMarketTemplate(template.id);
                        }}
                        disabled={downloading === template.id}
                      >
                        <span className="market-name">{template.name}</span>
                        <span className="market-desc">{template.desc}</span>
                        <span className="market-meta">
                          {template.stars > 0 ? `★ ${template.stars} · ` : ""}
                          {template.size_kb >= 1024
                            ? `${(template.size_kb / 1024).toFixed(1)} MB`
                            : `${template.size_kb} KB`}
                          {template.ready ? (
                            <span className="market-ready">✓ {t("newProject.marketReady")}</span>
                          ) : (
                            <span className="market-dl">
                              {downloading === template.id ? "…" : t("newProject.marketDownload")}
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                    {visibleMarketTemplates.length === 0 && (
                      <div className="panel-empty">{t("newFile.marketEmpty")}</div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
          {error && <div className="modal-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn-mini" onClick={onClose}>
            {t("settings.cancel")}
          </button>
          <button className="btn-mini btn-primary" onClick={() => void doCreate()} disabled={busy}>
            {busy ? t("newFile.importing") : tab === "basic" ? t("tree.newFileCreate") : t("newFile.import")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewFileModal;
