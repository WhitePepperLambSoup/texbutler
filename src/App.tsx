import { useEffect, useState } from "react";
import ProjectTree from "./components/ProjectTree";
import EditorPane from "./components/Editor";
import PdfPreview from "./components/PdfPreview";
import ProblemsPanel from "./components/ProblemsPanel";
import AiPanel from "./components/AiPanel";
import SettingsModal from "./components/SettingsModal";
import { useProjectStore } from "./store/projectStore";
import { useCompileStore } from "./store/compileStore";
import { useAiStore } from "./store/aiStore";
import { useT } from "./i18n";

export default function App() {
  const { root, mainFile, openPath } = useProjectStore();
  const { running, progress, compile, lastResult, elapsedSec, compileIssues, ruleIssues } =
    useCompileStore();
  const busy = useAiStore((s) => s.busy);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pdfRev, setPdfRev] = useState(0);
  const [compileTarget, setCompileTarget] = useState<"main" | "current">("main");
  const t = useT();

  // Bump the PDF iframe key on every successful compile.
  useEffect(() => {
    const un = useCompileStore.subscribe((s, prev) => {
      if (s.lastResult?.ok && s.lastResult !== prev.lastResult) {
        setPdfRev((r) => r + 1);
      }
    });
    return un;
  }, []);

  const handleCompile = async () => {
    await compile(compileTarget);
  };

  // Global shortcuts: Ctrl+B compile (like VS Code), Ctrl+Shift+B compile current
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "b") return;
      e.preventDefault();
      const target = e.shiftKey ? "current" : "main";
      void useCompileStore.getState().compile(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const totalIssues = compileIssues.length + ruleIssues.length;

  return (
    <div className="app">
      <div className="toolbar">
        <span className="brand">TeXButler</span>
        {root && (
          <span className="toolbar-root" title={root}>
            {root.split(/[\\/]/).pop()}
          </span>
        )}
        <div className="toolbar-spacer" />
        <select
          className="compile-target"
          value={compileTarget}
          onChange={(e) => setCompileTarget(e.target.value as "main" | "current")}
          disabled={running}
          title={
            compileTarget === "main"
              ? t("toolbar.target.main", { file: mainFile })
              : t("toolbar.target.current", { file: openPath?.split("/").pop() ?? "" })
          }
        >
          <option value="main">{t("toolbar.target.main", { file: mainFile || "main.tex" })}</option>
          <option value="current" disabled={!openPath}>
            {openPath
              ? t("toolbar.target.current", { file: openPath.split("/").pop() ?? "" })
              : t("toolbar.target.currentEmpty")}
          </option>
        </select>
        <button className="btn" onClick={handleCompile} disabled={running || !root}>
          {running ? t("toolbar.compiling") : t("toolbar.compile")}
        </button>
        {running && (
          <button className="btn" onClick={() => useCompileStore.getState().cancel()}>
            {t("toolbar.cancel")}
          </button>
        )}
        <button className="btn" onClick={() => setSettingsOpen(true)}>
          {t("toolbar.settings")}
        </button>
      </div>
      {running && progress && (
        <div className="compile-bar">
          <div className="compile-bar-fill" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
          <span className="compile-bar-text">{progress.message}</span>
        </div>
      )}
      <div className="layout">
        <aside className="col-tree">
          <ProjectTree />
        </aside>
        <main className="col-editor">
          <EditorPane />
        </main>
        <aside className="col-pdf">
          <PdfPreview revision={pdfRev} />
        </aside>
      </div>
      <div className="bottom">
        <ProblemsPanel />
        <AiPanel />
      </div>
      <div className="statusbar">
        <span className="status-item" title={t("status.engine")}>
          {t("status.engine", {
            name: lastResult
              ? lastResult.engine === "tectonic"
                ? "Tectonic"
                : "TeX Live / MiKTeX"
              : "—",
          })}
          {lastResult?.fell_back ? t("status.engineFellBack") : ""}
        </span>
        {elapsedSec != null && (
          <span className="status-item" title={t("status.duration")}>
            {t("status.duration", { s: elapsedSec })}
          </span>
        )}
        {lastResult && (
          <span className="status-item" title={t("status.result")}>
            {t("status.result", { ok: lastResult.ok ? t("status.ok") : t("status.fail") })}
          </span>
        )}
        <span className="status-item">{t("status.issues", { n: totalIssues })}</span>
        <span className="status-spacer" />
        <span className="status-item status-root" title={root}>
          {root || t("status.noProject")}
        </span>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {busy && <div className="busy-overlay">{t("ai.busyDiagnose")}</div>}
    </div>
  );
}
