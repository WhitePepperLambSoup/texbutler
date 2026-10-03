import { useEffect, useState } from "react";
import { Folder, FolderOpen, FolderPlus, X } from "lucide-react";
import { loadRecent, removeRecent, type RecentProject } from "../store/recent";
import { useUiStore } from "../store/uiStore";
import { useI18n, useT } from "../i18n";
import * as actions from "../actions";

function relativeTime(ts: number, lang: string): string {
  if (!ts) return "";
  const diff = (ts - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(lang === "zh" ? "zh-CN" : "en", { numeric: "auto" });
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.35, "week"],
    [12, "month"],
  ];
  let value = diff;
  for (const [size, unit] of steps) {
    if (Math.abs(value) < size) return rtf.format(Math.round(value), unit);
    value /= size;
  }
  return rtf.format(Math.round(value), "year");
}

/** Welcome screen shown when no project is open: open/create actions and
 *  recently opened projects for one-click restore. */
export default function WelcomePanel() {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const [recent, setRecent] = useState<RecentProject[]>(() => loadRecent());
  const openModal = useUiStore((s) => s.openModal);

  // re-read when the window regains focus (another action may have changed it)
  useEffect(() => {
    const onFocus = () => setRecent(loadRecent());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const openRecent = async (path: string) => {
    const ok = await actions.openProject(path);
    if (!ok) setRecent(loadRecent());
  };

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-hero">
          <span className="brand-mark welcome-logo" aria-hidden="true">
            T
          </span>
          <div>
            <h1>TeXButler</h1>
            <p className="welcome-sub">{t("welcome.subtitle")}</p>
          </div>
        </div>

        <div className="welcome-actions">
          <button className="welcome-action" onClick={() => void actions.openProject()}>
            <span className="welcome-action-icon">
              <FolderOpen size={20} />
            </span>
            <span>
              <span className="welcome-action-title">{t("welcome.open")}</span>
              <span className="welcome-action-desc">{t("welcome.openDesc")}</span>
            </span>
          </button>
          <button className="welcome-action" onClick={() => openModal({ kind: "newProject" })}>
            <span className="welcome-action-icon">
              <FolderPlus size={20} />
            </span>
            <span>
              <span className="welcome-action-title">{t("welcome.new")}</span>
              <span className="welcome-action-desc">{t("welcome.newDesc")}</span>
            </span>
          </button>
        </div>

        <section className="welcome-section">
          <h2>{t("welcome.recent")}</h2>
          {recent.length === 0 ? (
            <div className="welcome-empty">{t("welcome.recentEmpty")}</div>
          ) : (
            <ul className="welcome-recent">
              {recent.map((p) => (
                <li key={p.path}>
                  <button className="welcome-recent-item" onClick={() => void openRecent(p.path)} title={p.path}>
                    <Folder size={18} />
                    <span className="welcome-recent-text">
                      <span className="welcome-recent-name">{p.name}</span>
                      <span className="welcome-recent-path">{p.path}</span>
                    </span>
                    <span className="welcome-recent-time">{relativeTime(p.lastOpened, lang)}</span>
                  </button>
                  <button
                    className="icon-btn icon-btn-sm welcome-recent-del"
                    title={t("welcome.remove")}
                    aria-label={t("welcome.remove")}
                    onClick={() => {
                      removeRecent(p.path);
                      setRecent(loadRecent());
                    }}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="welcome-hints">
          <span>
            <kbd>Ctrl</kbd> <kbd>O</kbd> {t("welcome.open")}
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>N</kbd> {t("welcome.new")}
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>P</kbd> {t("cmd.palette")}
          </span>
        </div>
      </div>
    </div>
  );
}
