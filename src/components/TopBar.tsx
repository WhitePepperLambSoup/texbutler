import { useEffect, useState } from "react";
import {
  BookmarkPlus,
  Bot,
  Check,
  ChevronDown,
  Command as CommandIcon,
  FileDown,
  FilePlus2,
  FileText,
  FileType2,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  Loader2,
  LogOut,
  PanelBottom,
  PanelLeft,
  Play,
  Settings,
  Square,
} from "lucide-react";
import { api } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useCompileStore } from "../store/compileStore";
import { useUiStore, type PanelId, type ThemeId } from "../store/uiStore";
import { loadRecent } from "../store/recent";
import { comboLabel, loadKeymap } from "../store/keymap";
import { usePopover } from "../hooks/usePopover";
import { useT } from "../i18n";
import * as actions from "../actions";

const THEMES: ThemeId[] = ["liquid", "dark", "light"];

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function ProjectMenu() {
  const t = useT();
  const root = useProjectStore((s) => s.root);
  const pop = usePopover();
  const recent = pop.open ? loadRecent().filter((p) => p.path !== root).slice(0, 6) : [];
  const ui = useUiStore.getState;
  const pick = (fn: () => void) => () => {
    pop.close();
    fn();
  };
  return (
    <div className="menu-anchor" ref={pop.anchorRef}>
      <button
        ref={pop.triggerRef}
        className="project-switcher"
        aria-expanded={pop.open}
        aria-haspopup="menu"
        title={root}
        onClick={pop.toggle}
      >
        <Folder size={15} aria-hidden="true" />
        <span className="toolbar-root">{basename(root)}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {pop.open && (
        <div className="menu menu-left project-menu" role="menu">
          <button className="menu-item" onClick={pick(() => void actions.openProject())}>
            <FolderOpen size={15} /> {t("toolbar.open")}
            <span className="menu-kbd">Ctrl+O</span>
          </button>
          <button className="menu-item" onClick={pick(() => ui().openModal({ kind: "newProject" }))}>
            <FolderPlus size={15} /> {t("toolbar.new")}
          </button>
          {recent.length > 0 && (
            <>
              <div className="menu-separator" />
              <div className="menu-label">{t("welcome.recent")}</div>
              {recent.map((p) => (
                <button key={p.path} className="menu-item" title={p.path} onClick={pick(() => void actions.openProject(p.path))}>
                  <History size={15} /> {p.name}
                  <span className="menu-detail">{p.path}</span>
                </button>
              ))}
            </>
          )}
          <div className="menu-separator" />
          <button className="menu-item" onClick={pick(() => void actions.saveAsTemplate())}>
            <BookmarkPlus size={15} /> {t("tree.saveTemplate")}
          </button>
          <button className="menu-item" onClick={pick(() => void actions.closeProject())}>
            <LogOut size={15} /> {t("toolbar.closeProject")}
          </button>
        </div>
      )}
    </div>
  );
}

function CompileControl() {
  const t = useT();
  const root = useProjectStore((s) => s.root);
  const mainFile = useProjectStore((s) => s.mainFile);
  const activeTab = useProjectStore((s) => s.activeTab);
  const running = useCompileStore((s) => s.running);
  const target = useCompileStore((s) => s.target);
  const setTarget = useCompileStore((s) => s.setTarget);
  const [roots, setRoots] = useState<string[]>([]);
  const pop = usePopover();

  // multi-document projects: every compilable \documentclass file
  useEffect(() => {
    let alive = true;
    if (!root) return;
    api
      .listRoots()
      .then((r) => alive && setRoots(r))
      .catch(() => alive && setRoots([]));
    return () => {
      alive = false;
    };
  }, [root, pop.open]);

  const targetLabel =
    target === "main"
      ? mainFile || "main.tex"
      : target === "current"
        ? t("toolbar.target.currentShort")
        : basename(target);

  const choose = (value: string) => {
    setTarget(value);
    pop.close();
  };
  const keymap = loadKeymap();

  return (
    <div className="compile-group menu-anchor" ref={pop.anchorRef}>
      <button
        className="btn btn-primary toolbar-compile"
        onClick={() => actions.compile()}
        disabled={running || !root}
        title={`${t("toolbar.compileTitle", { file: targetLabel })} (${comboLabel(keymap.compileMain)})`}
      >
        {running ? <Loader2 size={15} className="spinner" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        {running ? t("toolbar.compiling") : t("toolbar.compile")}
      </button>
      <button
        ref={pop.triggerRef}
        className="btn btn-primary compile-target-btn"
        aria-haspopup="menu"
        aria-expanded={pop.open}
        title={t("toolbar.targetTitle")}
        disabled={running}
        onClick={pop.toggle}
      >
        <span className="compile-target-label">{targetLabel}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {pop.open && (
        <div className="menu menu-left compile-target-menu" role="menu">
          <div className="menu-label">{t("toolbar.targetTitle")}</div>
          <button className={`menu-item ${target === "main" ? "checked" : ""}`} onClick={() => choose("main")}>
            <span className="menu-check">{target === "main" && <Check size={14} />}</span>
            {t("toolbar.target.main", { file: mainFile || "main.tex" })}
          </button>
          {roots
            .filter((r) => r !== mainFile)
            .map((r) => (
              <button key={r} className={`menu-item ${target === r ? "checked" : ""}`} onClick={() => choose(r)}>
                <span className="menu-check">{target === r && <Check size={14} />}</span>
                {t("toolbar.target.root", { file: r })}
              </button>
            ))}
          <button
            className={`menu-item ${target === "current" ? "checked" : ""}`}
            disabled={!activeTab}
            onClick={() => choose("current")}
          >
            <span className="menu-check">{target === "current" && <Check size={14} />}</span>
            {activeTab ? t("toolbar.target.current", { file: basename(activeTab) }) : t("toolbar.target.currentEmpty")}
            <span className="menu-kbd">{comboLabel(keymap.compileCurrent)}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ImportExportMenu() {
  const t = useT();
  const activeTab = useProjectStore((s) => s.activeTab);
  const hasPdf = useProjectStore((s) => Boolean(s.pdfPath));
  const pop = usePopover();
  const isTex = Boolean(activeTab?.endsWith(".tex"));
  const pick = (fn: () => void) => () => {
    pop.close();
    fn();
  };
  return (
    <div className="toolbar-more menu-anchor" ref={pop.anchorRef}>
      <button
        ref={pop.triggerRef}
        className="icon-btn toolbar-more-btn"
        aria-haspopup="menu"
        aria-expanded={pop.open}
        title={t("toolbar.more")}
        aria-label={t("toolbar.more")}
        onClick={pop.toggle}
      >
        <FileDown size={17} aria-hidden="true" />
      </button>
      {pop.open && (
        <div className="toolbar-more-menu menu-right" role="menu">
          <div className="menu-label">{t("toolbar.more")}</div>
          <button className="menu-item toolbar-word-import" onClick={pick(() => void actions.importWord())}>
            <FileType2 size={15} /> {t("toolbar.importWord")}
          </button>
          <div className="menu-separator" />
          <button
            className="menu-item toolbar-export-md"
            title={t("toolbar.exportMdTitle")}
            disabled={!isTex}
            onClick={pick(() => void actions.exportActive("md"))}
          >
            <FileText size={15} /> {t("toolbar.exportMd")}
          </button>
          <button
            className="menu-item toolbar-export-docx"
            title={t("toolbar.exportDocxTitle")}
            disabled={!isTex}
            onClick={pick(() => void actions.exportActive("docx"))}
          >
            <FileType2 size={15} /> {t("toolbar.exportDocx")}
          </button>
          <div className="menu-separator" />
          <button className="menu-item toolbar-save-pdf" disabled={!hasPdf} onClick={pick(() => void actions.savePdfAs())}>
            <FileDown size={15} /> {t("pdf.saveAs")}
          </button>
          <button className="menu-item toolbar-output-folder" onClick={pick(() => void actions.openOutputFolder())}>
            <FolderOpen size={15} /> {t("pdf.outputFolder")}
          </button>
        </div>
      )}
    </div>
  );
}

function ThemePicker() {
  const t = useT();
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const pop = usePopover();
  return (
    <div className="theme-picker menu-anchor" ref={pop.anchorRef}>
      <button
        ref={pop.triggerRef}
        className="icon-btn theme-picker-btn"
        title={t("theme.title")}
        aria-label={t("theme.title")}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        onClick={pop.toggle}
      >
        <span className={`theme-swatch swatch-${theme}`} />
      </button>
      {pop.open && (
        <div className="theme-picker-menu menu-right" role="menu">
          <div className="menu-label">{t("theme.title")}</div>
          {THEMES.map((id) => (
            <button
              key={id}
              className={`theme-option ${theme === id ? "active" : ""}`}
              onClick={() => {
                setTheme(id);
                pop.close();
              }}
            >
              <span className={`theme-swatch swatch-${id}`} />
              {t(`theme.${id}`)}
              {theme === id && <Check size={14} className="theme-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TopBar({
  visible,
  onTogglePanel,
}: {
  visible: Record<Exclude<PanelId, "bottom">, boolean> & { bottom: boolean };
  onTogglePanel: (panel: PanelId) => void;
}) {
  const t = useT();
  const root = useProjectStore((s) => s.root);
  const running = useCompileStore((s) => s.running);
  const progress = useCompileStore((s) => s.progress);
  const openModal = useUiStore((s) => s.openModal);
  const openPalette = useUiStore((s) => s.openPalette);

  const toggles: { id: PanelId; icon: JSX.Element; label: string }[] = [
    { id: "sidebar", icon: <PanelLeft size={17} />, label: t("cmd.toggleSidebar") },
    { id: "bottom", icon: <PanelBottom size={17} />, label: `${t("cmd.toggleProblems")} (Ctrl+J)` },
    { id: "pdf", icon: <FileText size={17} />, label: t("cmd.togglePdf") },
    { id: "ai", icon: <Bot size={17} />, label: t("cmd.toggleAi") },
  ];

  return (
    <header className="toolbar">
      <span className="brand">
        <span className="brand-mark" aria-hidden="true">
          T
        </span>
        <span className="hide-narrow">TeXButler</span>
      </span>
      {root && (
        <>
          <ProjectMenu />
          <span className="divider-v" />
          <CompileControl />
          {running && (
            <button
              className="icon-btn toolbar-cancel"
              title={t("toolbar.cancel")}
              aria-label={t("toolbar.cancel")}
              onClick={() => useCompileStore.getState().cancel()}
            >
              <Square size={14} fill="currentColor" aria-hidden="true" />
            </button>
          )}
        </>
      )}
      <div className="toolbar-spacer" />
      {root && (
        <>
          <div className="toolbar-group">
            <button
              className="icon-btn toolbar-new-file"
              title={`${t("tree.newFile")} (Ctrl+N)`}
              aria-label={t("tree.newFile")}
              onClick={() => openModal({ kind: "newFile" })}
            >
              <FilePlus2 size={17} aria-hidden="true" />
            </button>
            <ImportExportMenu />
          </div>
          <span className="divider-v" />
          <div className="toolbar-group" role="group" aria-label={t("toolbar.layout")}>
            {toggles.map((tg) => (
              <button
                key={tg.id}
                className="icon-btn layout-toggle"
                aria-pressed={visible[tg.id]}
                title={tg.label}
                aria-label={tg.label}
                onClick={() => onTogglePanel(tg.id)}
              >
                {tg.icon}
              </button>
            ))}
          </div>
          <span className="divider-v" />
        </>
      )}
      <div className="toolbar-group">
        <button
          className="icon-btn"
          title={`${t("cmd.palette")} (Ctrl+Shift+P)`}
          aria-label={t("cmd.palette")}
          onClick={() => openPalette("commands")}
        >
          <CommandIcon size={16} aria-hidden="true" />
        </button>
        <ThemePicker />
        <button
          className="icon-btn toolbar-settings"
          title={`${t("toolbar.settings")} (Ctrl+,)`}
          aria-label={t("toolbar.settings")}
          onClick={() => openModal({ kind: "settings" })}
        >
          <Settings size={17} aria-hidden="true" />
        </button>
      </div>
      {running && progress && (
        <div className={`compile-progress ${progress.progress <= 0.02 ? "indeterminate" : ""}`} aria-hidden="true">
          <div className="compile-progress-fill" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
        </div>
      )}
    </header>
  );
}
