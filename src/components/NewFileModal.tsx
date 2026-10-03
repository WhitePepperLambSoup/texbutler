import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { api, type MarketTemplate } from "../api";
import { useProjectStore } from "../store/projectStore";
import { dialog } from "../store/feedbackStore";
import { useT } from "../i18n";
import { currentDirectory, joinProjectRelative, validateFileName } from "../fileDestination";
import Modal from "./ui/Modal";

interface Props {
  onClose: () => void;
}

type NewFileTab = "basic" | "user" | "market";

type UserTemplate = { id: string; name: string; source: string };

type NewFileModalComponent = (props: Props) => React.ReactElement | null;

const ALL_CATEGORY = "__all__";

const basicTemplates = [
  ["article", "tree.tplArticle"],
  ["ctexart", "tree.tplCtexart"],
  ["report", "tree.tplReport"],
  ["beamer", "tree.tplBeamer"],
  ["minimal", "tree.tplMinimal"],
  ["", "tree.tplEmpty"],
] as const;

const NewFileModal: NewFileModalComponent = ({ onClose }) => {
  const t = useT();
  const activeTab = useProjectStore((state) => state.activeTab);
  const [tab, setTab] = useState<NewFileTab>("basic");
  const [fileName, setFileName] = useState("new-file.tex");
  const [fileTemplate, setFileTemplate] = useState("article");
  const [userTemplates, setUserTemplates] = useState<UserTemplate[]>([]);
  const [marketTemplates, setMarketTemplates] = useState<MarketTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORY);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentDir = currentDirectory(activeTab);

  const loadTemplates = async () => {
    const [users, market] = await Promise.all([
      api.listTemplates().catch(() => []),
      api.listMarketTemplates().catch(() => []),
    ]);
    setUserTemplates(users);
    setMarketTemplates(market);
  };

  useEffect(() => {
    void loadTemplates();
  }, []);

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
      setBusy(true);
      try {
        const name = validateFileName(fileName);
        const path = joinProjectRelative(currentDir, name);
        await api.newFile(path, name.toLowerCase().endsWith(".tex") ? fileTemplate : undefined);
        await useProjectStore.getState().refresh();
        await useProjectStore.getState().openFile(path);
        onClose();
      } catch (e) {
        setError(e instanceof Error && e.message === "filename-only" ? t("newFile.filenameOnly") : String(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!selectedTemplate) {
      setError(t("newFile.selectTemplate"));
      return;
    }
    setBusy(true);
    try {
      const result = await api.importProjectTemplate(
        currentDir,
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

  const deleteUserTemplate = async (id: string, name: string) => {
    setError(null);
    const ok = await dialog.confirm({
      title: t("newFile.deleteTemplate"),
      message: t("newFile.deleteTemplateConfirm", { name }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
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
      // downloaded = chosen: no second click needed to select it
      setSelectedTemplate(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <Modal
      title={t("toolbar.newFile")}
      onClose={onClose}
      onSubmit={() => void doCreate()}
      className="new-file-modal"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={() => void doCreate()} disabled={busy}>
            {busy ? t("newFile.importing") : tab === "basic" ? t("tree.newFileCreate") : t("newFile.import")}
          </button>
        </>
      }
    >
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
            <div className="new-file-destination">
              <span>{t("newFile.currentDirectory")}</span>
              <code>{currentDir || "/"}</code>
            </div>
            {tab === "basic" && (
              <>
                <label className="field new-file-name-row">
                  <span className="field-label">{t("tree.newFileName")}</span>
                  <input
                    className="input new-file-name-input"
                    value={fileName}
                    spellCheck={false}
                    onFocus={(event) => {
                      // select the base name so typing replaces "new-file"
                      const dot = event.target.value.lastIndexOf(".");
                      event.target.setSelectionRange(0, dot > 0 ? dot : event.target.value.length);
                    }}
                    onChange={(event) => setFileName(event.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void doCreate()}
                  />
                  {!fileName.toLowerCase().endsWith(".tex") && <span className="field-hint">{t("newFile.nonTexHint")}</span>}
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
                <div className="field">
                  <span className="field-label">{t("tree.newFileTemplate")}</span>
                  <div className="template-grid">
                    {basicTemplates.map(([id, label]) => (
                      <button
                        key={id || "empty"}
                        type="button"
                        data-template-id={id || "empty"}
                        disabled={!fileName.toLowerCase().endsWith(".tex")}
                        className={`template-card ${fileTemplate === id ? "template-active" : ""}`}
                        onClick={() => setFileTemplate(id)}
                      >
                        {t(label)}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {tab === "user" && (
              <>
                <div className="template-grid">
                  {userTemplates.map((template) => (
                    <span key={template.id} className="template-wrap">
                      <button
                        type="button"
                        data-template-id={template.id}
                        className={`template-card ${selectedTemplate === template.id ? "template-active" : ""}`}
                        onClick={() => setSelectedTemplate(template.id)}
                      >
                        {template.name}
                      </button>
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm template-del"
                        title={t("newFile.deleteTemplate")}
                        aria-label={t("newFile.deleteTemplate")}
                        onClick={() => void deleteUserTemplate(template.id, template.name)}
                      >
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                </div>
                {userTemplates.length === 0 && <div className="panel-empty">{t("newFile.userEmpty")}</div>}
              </>
            )}

            {tab === "market" && (
              <>
                <div className="market-panel">
                  <div className="market-toolbar">
                    <input
                      className="input market-search"
                      placeholder={t("newProject.marketSearch")}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    <select className="input market-cat" value={category} onChange={(event) => setCategory(event.target.value)}>
                      {categories.map((value) => (
                        <option key={value} value={value}>
                          {value === ALL_CATEGORY ? t("newFile.allCategories") : value}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="market-list">
                    {visibleMarketTemplates.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        data-template-id={template.id}
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
    </Modal>
  );
};

export default NewFileModal;
