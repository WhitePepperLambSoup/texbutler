import { create } from "zustand";
import { api, type Issue, type ProjectFileNode, type ProjectInfo } from "../api";
import { useI18n } from "../i18n";
import { saveFlow } from "../flow";

interface ProjectState {
  root: string;
  mainFile: string;
  files: ProjectFileNode[];
  openPath: string | null; // currently open file (relative)
  openContent: string;
  dirty: boolean;
  pdfPath: string | null;

  openProject: (path?: string) => Promise<void>;
  createProject: (parent: string, name: string, template?: string) => Promise<void>;
  refresh: () => Promise<void>;
  openFile: (rel: string) => Promise<void>;
  saveFile: () => Promise<void>;
  closeProject: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  root: "",
  mainFile: "main.tex",
  files: [],
  openPath: null,
  openContent: "",
  dirty: false,
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
    // auto-open the main file
    await get().openFile(info.main_file);
  },

  async createProject(parent, name, template?: string) {
    const info = await api.newProject(parent, name, template);
    set({
      root: info.root,
      mainFile: info.main_file,
      files: info.files,
      pdfPath: info.pdf_url ?? null,
    });
    await get().openFile(info.main_file);
  },

  async refresh() {
    const info = await api.projectInfo();
    set({ files: info.files, pdfPath: info.pdf_url ?? null });
  },

  async openFile(rel) {
    const { openPath, dirty, saveFile } = get();
    // protect unsaved edits when switching files
    if (openPath && openPath !== rel && dirty) {
      const keep = window.confirm(`「${openPath}」有未保存的修改，是否先保存？`);
      if (keep) {
        await saveFile();
      }
    }
    const content = await api.readFile(rel);
    set({ openPath: rel, openContent: content, dirty: false });
    saveFlow({ lastFile: rel });
  },

  async saveFile() {
    const { openPath, openContent } = get();
    if (!openPath) return;
    await api.writeFile(openPath, openContent);
    set({ dirty: false });
    // notify listeners (App triggers auto-compile when enabled)
    window.dispatchEvent(new Event("tb:file-saved"));
  },

  closeProject() {
    set({
      root: "",
      mainFile: "main.tex",
      files: [],
      openPath: null,
      openContent: "",
      dirty: false,
      pdfPath: null,
    });
  },
}));

/** Quick helper used by ProblemsPanel: map issue severity to class names. */
export function severityLabel(s: Issue["severity"]): string {
  const t = useI18n.getState().t;
  switch (s) {
    case "error":
      return t("sev.error");
    case "warning":
      return t("sev.warning");
    case "info":
      return t("sev.info");
    case "suggestion":
      return t("sev.suggestion");
  }
}
