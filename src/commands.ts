// Command registry for the command palette (Ctrl+Shift+P). Each command is
// the same operation the toolbar/menus run, so the palette is a complete
// keyboard path to the app.

import { useProjectStore } from "./store/projectStore";
import { useCompileStore } from "./store/compileStore";
import { useUiStore, type ThemeId } from "./store/uiStore";
import { useI18n } from "./i18n";
import { useAiStore } from "./store/aiStore";
import { comboLabel, loadKeymap } from "./store/keymap";
import * as actions from "./actions";

export interface Command {
  id: string;
  title: string;
  shortcut?: string;
  run: () => void;
}

export function buildCommands(): Command[] {
  const t = useI18n.getState().t;
  const project = useProjectStore.getState();
  const compile = useCompileStore.getState();
  const ui = useUiStore.getState();
  const keymap = loadKeymap();
  const hasProject = Boolean(project.root);
  const hasFile = Boolean(project.activeTab);
  const list: (Command | false)[] = [
    hasProject && !compile.running && {
      id: "compile",
      title: t("cmd.compile"),
      shortcut: comboLabel(keymap.compileMain),
      run: () => actions.compile("main"),
    },
    hasFile && !compile.running && {
      id: "compile-current",
      title: t("cmd.compileCurrent"),
      shortcut: comboLabel(keymap.compileCurrent),
      run: () => actions.compile("current"),
    },
    compile.running && { id: "compile-cancel", title: t("cmd.compileCancel"), run: () => compile.cancel() },
    hasFile && { id: "save", title: t("cmd.save"), shortcut: "Ctrl+S", run: () => void actions.saveActive() },
    hasProject && { id: "save-all", title: t("cmd.saveAll"), shortcut: "Ctrl+Shift+S", run: () => void actions.saveAll() },
    hasProject && { id: "new-file", title: t("cmd.newFile"), shortcut: "Ctrl+N", run: () => ui.openModal({ kind: "newFile" }) },
    { id: "open-project", title: t("cmd.openProject"), shortcut: "Ctrl+O", run: () => void actions.openProject() },
    { id: "new-project", title: t("cmd.newProject"), run: () => ui.openModal({ kind: "newProject" }) },
    hasProject && { id: "close-project", title: t("cmd.closeProject"), run: () => void actions.closeProject() },
    hasProject && { id: "quick-open", title: t("cmd.quickOpen"), shortcut: "Ctrl+P", run: () => ui.openPalette("files") },
    hasProject && { id: "split", title: t("cmd.split"), run: () => ui.openPalette("split") },
    hasFile && { id: "locate-pdf", title: t("cmd.locatePdf"), run: () => void actions.locateInPdf() },
    hasProject && { id: "toggle-sidebar", title: t("cmd.toggleSidebar"), run: () => ui.togglePanel("sidebar") },
    hasProject && { id: "toggle-problems", title: t("cmd.toggleProblems"), shortcut: "Ctrl+J", run: () => ui.togglePanel("bottom") },
    hasProject && { id: "toggle-pdf", title: t("cmd.togglePdf"), run: () => ui.togglePanel("pdf") },
    hasProject && { id: "toggle-ai", title: t("cmd.toggleAi"), run: () => ui.togglePanel("ai") },
    hasProject && { id: "ask-ai", title: t("cmd.askAi"), run: () => ui.focusAi() },
    hasProject && { id: "outline", title: t("cmd.showOutline"), run: () => ui.setSidebarTab("outline") },
    hasProject && { id: "bib", title: t("cmd.showBib"), run: () => ui.setSidebarTab("bib") },
    hasProject && { id: "todo", title: t("cmd.showTodo"), run: () => ui.setSidebarTab("todo") },
    hasProject && { id: "rules", title: t("cmd.runRules"), run: () => { ui.showProblems("rules"); void compile.runCheck(); } },
    hasProject && { id: "log", title: t("cmd.showLog"), run: () => void actions.showCompileLog() },
    hasProject && { id: "import-word", title: t("toolbar.importWord"), run: () => void actions.importWord() },
    hasFile && { id: "export-md", title: t("toolbar.exportMd"), run: () => void actions.exportActive("md") },
    hasFile && { id: "export-docx", title: t("toolbar.exportDocx"), run: () => void actions.exportActive("docx") },
    hasProject && { id: "save-template", title: t("tree.saveTemplate"), run: () => void actions.saveAsTemplate() },
    hasProject && { id: "find-in-project", title: t("cmd.findInProject"), shortcut: "Ctrl+Shift+F", run: () => ui.searchInProject("") },
    hasProject && { id: "new-folder", title: t("files.newFolder"), run: () => void actions.newFolder("") },
    hasFile && { id: "history", title: t("history.title"), run: () => actions.showHistory() },
    hasProject && { id: "output-folder", title: t("pdf.outputFolder"), run: () => void actions.openOutputFolder() },
    hasProject && Boolean(project.pdfPath) && { id: "save-pdf", title: t("pdf.saveAs"), run: () => void actions.savePdfAs() },
    hasProject && { id: "reveal-project", title: t("files.revealProject"), run: () => void actions.revealInExplorer(null) },
    { id: "engine", title: t("engine.title"), run: () => ui.openModal({ kind: "engine" }) },
    { id: "updates", title: t("settings.updatesNow"), run: () => void actions.checkForUpdates(true) },
    {
      id: "spellcheck",
      title: ui.editorPrefs.spellcheck ? t("cmd.spellOff") : t("cmd.spellOn"),
      run: () => ui.setEditorPrefs({ spellcheck: !ui.editorPrefs.spellcheck }),
    },
    hasProject && compile.compileIssues.some((i) => i.severity === "error") && {
      id: "fix-all",
      title: t("problems.fixAll"),
      run: () => {
        ui.setPanel("ai", true);
        void useAiStore.getState().fixAllIssues();
      },
    },
    ...(["liquid", "dark", "light"] as ThemeId[]).map((id) => ({
      id: `theme-${id}`,
      title: `${t("cmd.theme")}: ${t(`theme.${id}`)}`,
      run: () => ui.setTheme(id),
    })),
    {
      id: "language",
      title: t("cmd.language"),
      run: () => {
        const i18n = useI18n.getState();
        i18n.setLang(i18n.lang === "zh" ? "en" : "zh");
      },
    },
    { id: "settings", title: t("cmd.settings"), shortcut: "Ctrl+,", run: () => ui.openModal({ kind: "settings" }) },
    { id: "settings-ai", title: t("cmd.settingsAi"), run: () => ui.openModal({ kind: "settings", section: "ai" }) },
  ];
  return list.filter((c): c is Command => Boolean(c));
}

/** Subsequence fuzzy match; returns a score (higher = better) or -1. */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 0;
  const hay = text.toLowerCase();
  const q = query.toLowerCase();
  const direct = hay.indexOf(q);
  if (direct >= 0) return 1000 - direct - hay.length * 0.01;
  let score = 0;
  let pos = 0;
  let streak = 0;
  for (const ch of q) {
    const found = hay.indexOf(ch, pos);
    if (found < 0) return -1;
    streak = found === pos ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - pos);
    pos = found + 1;
  }
  return score;
}
