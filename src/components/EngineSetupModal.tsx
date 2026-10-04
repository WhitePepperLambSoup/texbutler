import { useEffect, useState } from "react";
import { CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, XCircle } from "lucide-react";
import { api, events, onEvent, type DownloadProgress } from "../api";
import { useWorkspaceStore } from "../store/workspaceStore";
import { useProjectStore } from "../store/projectStore";
import { toast } from "../store/feedbackStore";
import { useT } from "../i18n";
import * as actions from "../actions";
import Modal from "./ui/Modal";

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** Engine onboarding: what is installed, one-click Tectonic install, links
 *  to the full TeX distributions. */
export default function EngineSetupModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const engine = useWorkspaceStore((s) => s.engine);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recheck = async () => {
    setChecking(true);
    await useWorkspaceStore.getState().refreshEngine();
    setChecking(false);
  };

  useEffect(() => {
    void recheck();
    const un = onEvent<DownloadProgress>(events.installProgress, (p) => setProgress(p));
    return () => void un.then((f) => f());
  }, []);

  const install = async () => {
    setInstalling(true);
    setError(null);
    setProgress(null);
    try {
      const path = await api.installTectonic();
      const st = await useWorkspaceStore.getState().refreshEngine();
      toast.success(t("engine.installed", { path }));
      if (st?.can_compile && useProjectStore.getState().root) {
        toast.info(t("engine.readyToCompile"), { label: t("toolbar.compile"), run: () => actions.compile() });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  const pct = progress && progress.total > 0 ? Math.round((progress.downloaded / progress.total) * 100) : null;

  return (
    <Modal
      title={t("engine.title")}
      onClose={onClose}
      className="engine-modal"
      footer={
        <>
          <button className="btn" onClick={() => void recheck()} disabled={checking || installing}>
            <RefreshCw size={14} className={checking ? "spinner" : undefined} /> {t("engine.recheck")}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            {t("common.done")}
          </button>
        </>
      }
    >
      <p className="dialog-message">{t("engine.intro")}</p>
      <div className="settings-group">
        <div className="settings-row">
          <span className="settings-row-label">
            Tectonic
            <span className="settings-row-sub">{engine?.tectonic ?? t("engine.notFound")}</span>
          </span>
          {engine?.tectonic ? <CheckCircle2 size={18} className="ok-icon" /> : <XCircle size={18} className="bad-icon" />}
        </div>
        <div className="settings-row">
          <span className="settings-row-label">
            {t("engine.system")}
            <span className="settings-row-sub">
              {engine?.system_engine ? `${engine.system_engine} · ${engine.system_path}` : t("engine.notFound")}
            </span>
          </span>
          {engine?.system_engine ? <CheckCircle2 size={18} className="ok-icon" /> : <XCircle size={18} className="bad-icon" />}
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-row">
          <span className="settings-row-label">
            {t("engine.installTectonic")}
            <span className="settings-row-sub">{t("engine.installTectonicSub")}</span>
          </span>
          <button className="btn btn-primary engine-install" onClick={() => void install()} disabled={installing}>
            {installing ? <Loader2 size={14} className="spinner" /> : <Download size={14} />}
            {installing ? t("engine.installing") : engine?.tectonic ? t("engine.reinstall") : t("engine.install")}
          </button>
        </div>
        {installing && (
          <div className="settings-row">
            <div className="progress">
              <div className="progress-fill" style={{ width: `${pct ?? (progress?.stage === "extract" ? 100 : 5)}%` }} />
            </div>
            <span className="settings-row-sub progress-text">
              {progress?.stage === "extract"
                ? t("engine.extracting")
                : progress
                  ? `${formatBytes(progress.downloaded)}${progress.total ? ` / ${formatBytes(progress.total)}` : ""}`
                  : t("engine.connecting")}
            </span>
          </div>
        )}
        <div className="settings-row">
          <span className="settings-row-label">
            {t("engine.fullDistro")}
            <span className="settings-row-sub">{t("engine.fullDistroSub")}</span>
          </span>
          <span className="settings-row-actions">
            <a className="btn btn-sm" href="https://miktex.org/download" target="_blank" rel="noreferrer">
              MiKTeX <ExternalLink size={12} />
            </a>
            <a className="btn btn-sm" href="https://www.tug.org/texlive/acquire-netinstall.html" target="_blank" rel="noreferrer">
              TeX Live <ExternalLink size={12} />
            </a>
          </span>
        </div>
      </div>
      {error && <div className="modal-error">{error}</div>}
    </Modal>
  );
}
