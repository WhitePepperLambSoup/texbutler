// Project state with browser-style multi-tabs: each open file keeps its own
// content + dirty flag; switching tabs never loses edits and never blocks.

import { create } from "zustand";
import { api, type Issue, type ProjectFileNode, type ProjectInfo } from "../api";
import { useI18n } from "../i18n";
import { saveFlow } from "../flow";

export interface Tab {
  path: string;
  content: string;
  dirty: boolean;
}

interface ProjectState {
  root: string;
  mainFile: string;
  files: ProjectFileNode[];
  /** Open editor tabs (in opening order). */
  tabs: Tab[];
  /** Path of the active tab (null = none). */
  activeTab: string | null;
  pdfPath: string | null;

  openProject: (path?: string) => Promise<void>;
  createProject: (parent: string, name: string, template?: string) => Promise<void>;
  refresh: () => Promise<void>;
  openFile: (rel: string) => Promise<void>;
  saveFile: () => Promise<void>;
  closeTab: (rel: string) => Promise<void>;
  setTabContent: (rel: string, content: string) => void;
  closeProject: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  root: "",
  mainFile: "main.tex",
  files: [],
  tabs: [],
  activeTab: null,
  pdfPath: null,

  async openProject(path) {
    const info: ProjectInfo = await api.openProject(path);
    set({
      root: info.root,
      mainFile: info.main_file,
      files: info.files,
      pdfPath: info.pdf_url ?? null,
    });
    saveFlow({ lastProject: info.root });
    // keep tabs from a previous project? no — reset, then auto-open main
    set({ tabs: [], activeTab: null });
    await get().openFile(info.main_file);
  },

  async createProject(parent, name, template?: string) {
    const info = await api.newProject(parent, name, template);
    set({
      root: info.root,
      mainFile: info.main_file,
      files: info.files,
      pdfPath: info.pdf_url ?? null,
      tabs: [],
      activeTab: null,
    });
    await get().openFile(info.main_file);
  },

  async refresh() {
    const info = await api.projectInfo();
    set({ files: info.files, pdfPath: info.pdf_url ?? null });
  },

  async openFile(rel) {
    const { tabs } = get();
    // already open → just activate it (no confirm, no loss)
    if (tabs.some((t) => t.path === rel)) {
      set({ activeTab: rel });
      saveFlow({ lastFile: rel });
      return;
    }
    const content = await api.readFile(rel);
    // re-read state after await: another openFile may have completed first
    const cur = get();
    if (cur.tabs.some((t) => t.path === rel)) {
      set({ activeTab: rel });
      return;
    }
    set({
      tabs: [...cur.tabs, { path: rel, content, dirty: false }],
      activeTab: rel,
    });
    saveFlow({ lastFile: rel });
    // keep tab count sane (hard cap at 12; close the oldest CLEAN tab)
    const st = get();
    if (st.tabs.length > 12) {
      const oldest = [...st.tabs].find((t) => !t.dirty);
      if (oldest) {
        void get().closeTab(oldest.path);
      }
    }
  },

  async saveFile() {
    const { tabs, activeTab } = get();
    const tab = tabs.find((t) => t.path === activeTab);
    if (!tab) return;
    await api.writeFile(tab.path, tab.content);
    // re-read after await: if the user kept typing during the write, keep
    // the newer content and stay dirty instead of reverting it
    const cur = get();
    const latest = cur.tabs.find((t) => t.path === tab.path);
    if (!latest) return;
    const stillSame = latest.content === tab.content;
    set({
      tabs: cur.tabs.map((t) =>
        t.path === tab.path ? { ...t, dirty: stillSame ? false : t.dirty } : t
      ),
    });
    if (stillSame) {
      window.dispatchEvent(new Event("tb:file-saved"));
    }
  },

  /** Close a tab; unsaved edits are auto-saved first (no blocking dialog). */
  async closeTab(rel) {
    const { tabs } = get();
    const tab = tabs.find((t) => t.path === rel);
    if (!tab) return;
    if (tab.dirty) {
      try {
        await api.writeFile(tab.path, tab.content);
      } catch {
        /* keep the tab open if saving fails */
        return;
      }
    }
    // re-read after await (the list may have changed meanwhile)
    const cur = get();
    const stillThere = cur.tabs.some((t) => t.path === rel);
    if (!stillThere) return;
    const next = cur.tabs.filter((t) => t.path !== rel);
    const nextActive =
      rel === cur.activeTab
        ? next[0]?.path ?? null
        : cur.activeTab;
    set({ tabs: next, activeTab: nextActive });
  },

  setTabContent(rel, content) {
    const { tabs } = get();
    set({
      tabs: tabs.map((t) => (t.path === rel ? { ...t, content, dirty: true } : t)),
    });
  },

  closeProject() {
    set({
      root: "",
      mainFile: "main.tex",
      files: [],
      tabs: [],
      activeTab: null,
      pdfPath: null,
    });
  },
}));

/** Map an issue severity to a localized label (used by ProblemsPanel). */
export function severityLabel(s: Issue["severity"]): string {
  const t = useI18n.getState().t;
  switch (s) {
    case "error":
      return t("sev.error");
    case "warning":
      return t("sev.warning");
    case "info":
      return t("sev.info");
    default:
      return t("sev.suggestion");
  }
}
