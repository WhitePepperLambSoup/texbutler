import { useEffect, useState } from "react";
import { Download, ExternalLink, Loader2, Rocket } from "lucide-react";
import { api, events, onEvent, type DownloadProgress, type UpdateInfo } from "../api";
import { dialog } from "../store/feedbackStore";
import { useProjectStore } from "../store/projectStore";
import { useT } from "../i18n";
import Modal from "./ui/Modal";
import { formatBytes } from "./EngineSetupModal";

/** In-app updater: release notes → download the installer → run it. */
export default function UpdateModal({ info, onClose }: { info: UpdateInfo; onClose: () => void }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "downloading" | "ready" | "error">("idle");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [installer, setInstaller] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const un = onEvent<DownloadProgress>(events.updateProgress, (p) => setProgress(p));
    return () => void un.then((f) => f());
  }, []);

  const download = async () => {
    if (!info.asset_url) return;
    setState("downloading");
    setError(null);
    try {
      const path = await api.downloadUpdate(info.asset_url, info.asset_size ?? null);
      setInstaller(path);
      setState("ready");
    } catch (e) {
      setError(String(e));
      setState("error");
    }
  };

  const install = async () => {
    if (!installer) return;
    const ok = await dialog.confirm({
      title: t("update.installTitle"),
      message: t("update.installMsg"),
      confirmLabel: t("update.installGo"),
    });
    if (!ok) return;
    await useProjectStore.getState().saveAll().catch(() => 0);
    try {
      await api.installUpdate(installer);
    } catch (e) {
      setError(String(e));
    }
  };

  const total = progress?.total || info.asset_size || 0;
  const pct = total ? Math.round(((progress?.downloaded ?? 0) / total) * 100) : 0;

  return (
    <Modal
      title={t("update.title", { v: info.version })}
      onClose={onClose}
      className="update-modal"
      footer={
        <>
          <a className="btn btn-ghost" href={info.url} target="_blank" rel="noreferrer">
            {t("update.releasePage")} <ExternalLink size={12} />
          </a>
          <span className="toolbar-spacer" />
          <button className="btn" onClick={onClose}>
            {t("update.later")}
          </button>
          {state === "ready" ? (
            <button className="btn btn-primary update-install" onClick={() => void install()}>
              <Rocket size={14} /> {t("update.install")}
            </button>
          ) : (
            <button
              className="btn btn-primary update-download"
              disabled={!info.asset_url || state === "downloading"}
              onClick={() => void download()}
            >
              {state === "downloading" ? <Loader2 size={14} className="spinner" /> : <Download size={14} />}
              {state === "downloading" ? t("update.downloading") : t("update.download")}
            </button>
          )}
        </>
      }
    >
      <div className="update-hero">
        <div>
          <div className="update-version">TeXButler {info.version}</div>
          <div className="settings-row-sub">
            {info.asset_name ?? ""} {info.asset_size ? `· ${formatBytes(info.asset_size)}` : ""}
          </div>
        </div>
      </div>
      {info.body && <pre className="dialog-pre update-notes">{info.body.slice(0, 4000)}</pre>}
      {(state === "downloading" || state === "ready") && (
        <div className="progress-row">
          <div className="progress">
            <div className="progress-fill" style={{ width: `${state === "ready" ? 100 : pct}%` }} />
          </div>
          <span className="settings-row-sub progress-text">
            {state === "ready" ? t("update.ready") : `${formatBytes(progress?.downloaded ?? 0)} / ${formatBytes(total)}`}
          </span>
        </div>
      )}
      {!info.asset_url && <div className="settings-row-sub">{t("update.noAsset")}</div>}
      {error && <div className="modal-error">{error}</div>}
    </Modal>
  );
}
