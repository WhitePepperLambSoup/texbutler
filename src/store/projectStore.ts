// Project state with browser-style multi-tabs: each open file keeps its own
// content + dirty flag; switching tabs never loses edits and never blocks.

import { create } from "zustand";
import { api, type Issue, type ProjectFileNode, type ProjectInfo, type RefIndex } from "../api";
import { useI18n } from "../i18n";
import { saveFlow } from "../flow";

/** Monotonic openFile request counter (race guard for async tab activation). */
let openFileSeq = 0;

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
  /** Project-wide \label + .bib index for ref/cite autocompletion. */
  refIndex: RefIndex;
  /** Transient toast message (auto-dismissed). */
  toast: { id: number; text: string } | null;

  notify: (text: string) => void;

  openProject: (path?: string) => Promise<void>;
  createProject: (parent: string, name: string, template?: string) => Promise<void>;
  refresh: () => Promise<void>;
  openFile: (rel: string) => Promise<void>;
  saveFile: () => Promise<void>;
  reloadTab: (rel: string) => Promise<void>;
  closeTab: (rel: string) => Promise<void>;
  setTabContent: (rel: string, content: string) => void;
  closeProject: () => void;
  /** Refresh the label/bib index from the backend. */
  loadRefIndex: () => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  root: "",
  mainFile: "main.tex",
  files: [],
  tabs: [],
  activeTab: null,
  pdfPath: null,
  refIndex: { labels: [], bib: [] },
  toast: null,

  notify(text) {
    const id = Date.now();
    set({ toast: { id, text } });
    setTimeout(() => {
      set((s) => (s.toast?.id === id ? { toast: null } : s));
    }, 3500);
  },

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
    void get().loadRefIndex();
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
    void get().loadRefIndex();
  },

  async loadRefIndex() {
    try {
      const idx = await api.refIndex();
      set({ refIndex: idx });
    } catch {
      /* project not open yet */
    }
  },

  async openFile(rel) {
    // request sequence: only the LATEST openFile call may activate a tab.
    // Without this, opening A then quickly B could end up with A activating
    // after B finished (async race → activeTab on the wrong file).
    const seq = ++openFileSeq;
    const { tabs } = get();
    // already open → just activate it (no confirm, no loss)
    if (tabs.some((t) => t.path === rel)) {
      set({ activeTab: rel });
      saveFlow({ lastFile: rel });
      return;
    }
    const content = await api.readFile(rel);
    // a newer openFile superseded this one → drop this stale result
    if (seq !== openFileSeq) return;
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

  /** Reload a tab's content from disk (discards unsaved edits). Used after
   *  AI fixes / rollbacks so the editor reflects the file on disk. */
  async reloadTab(rel: string) {
    const content = await api.readFile(rel);
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === rel ? { ...t, content, dirty: false } : t)),
    }));
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
      // re-read after the await: if the user kept typing during the write,
      // write the newer content too so nothing is lost (bounded retries)
      let wrote = tab.content;
      for (let i = 0; i < 3; i++) {
        const latest = get().tabs.find((t) => t.path === rel);
        if (!latest || latest.content === wrote) break;
        wrote = latest.content;
        try {
          await api.writeFile(latest.path, latest.content);
        } catch {
          return; // keep the tab open on failure
        }
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
