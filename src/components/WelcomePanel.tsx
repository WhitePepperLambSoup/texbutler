import { useState } from "react";
import { loadRecent, removeRecent, type RecentProject } from "../store/recent";
import { useT } from "../i18n";

interface Props {
  onOpen: (path: string) => void;
  onBrowse: () => void;
  onNew: () => void;
}

/** Welcome screen shown when no project is open: recently opened projects
 *  for one-click restore, plus browse/new actions. */
export default function WelcomePanel({ onOpen, onBrowse, onNew }: Props) {
  const t = useT();
  const [recent, setRecent] = useState<RecentProject[]>(() => loadRecent());

  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>TeXButler</h1>
        <p className="welcome-sub">{t("welcome.subtitle")}</p>
        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={onBrowse}>
            {t("welcome.open")}
          </button>
          <button className="btn" onClick={onNew}>
            {t("welcome.new")}
          </button>
        </div>
        {recent.length > 0 && (
          <>
            <h2>{t("welcome.recent")}</h2>
            <ul className="welcome-recent">
              {recent.map((p) => (
                <li key={p.path}>
                  <button className="welcome-recent-item" onClick={() => onOpen(p.path)}>
                    <span className="welcome-recent-name">{p.name}</span>
                    <span className="welcome-recent-path" title={p.path}>
                      {p.path}
                    </span>
                  </button>
                  <button
                    className="btn-mini welcome-recent-del"
                    title={t("welcome.remove")}
                    onClick={() => {
                      removeRecent(p.path);
                      setRecent(loadRecent());
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
