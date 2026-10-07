// Workbench UI state: theme, panel visibility, open dialogs and cross-panel
// requests (split view, PDF page, AI focus). Replaces the ad-hoc window
// CustomEvents and the local state that used to live in App.tsx.

import { create } from "zustand";
import type { UpdateInfo } from "../api";

export type ThemeId = "liquid" | "dark" | "light";
export type PanelId = "sidebar" | "pdf" | "ai" | "bottom";
export type SidebarTab = "files" | "search" | "outline" | "bib" | "todo";
export type BottomTab = "compile" | "rules";
export type SettingsSection = "general" | "editor" | "compile" | "ai" | "rules";
export type PaletteMode = "files" | "commands" | "split";

export type ModalState =
  | { kind: "settings"; section?: SettingsSection }
  | { kind: "newProject" }
  /** `dir`: create inside this folder instead of the active file's folder */
  | { kind: "newFile"; dir?: string }
  | { kind: "history"; file: string }
  | { kind: "engine" }
  | { kind: "update"; info: UpdateInfo }
  | { kind: "zotero" };

export interface EditorPrefs {
  fontSize: number;
  fontFamily: string;
  wordWrap: boolean;
  lineNumbers: boolean;
  minimap: boolean;
  tabSize: number;
  spellcheck: boolean;
}

export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Microsoft YaHei UI', monospace",
  wordWrap: true,
  lineNumbers: true,
  minimap: false,
  tabSize: 2,
  spellcheck: true,
};

function loadEditorPrefs(): EditorPrefs {
  try {
    const raw = localStorage.getItem("tb-editor-prefs");
    if (raw) return { ...DEFAULT_EDITOR_PREFS, ...(JSON.parse(raw) as Partial<EditorPrefs>) };
  } catch {
    /* corrupted: defaults */
  }
  return { ...DEFAULT_EDITOR_PREFS };
}

const PANEL_KEYS: Record<PanelId, string> = {
  sidebar: "tb-ui-sidebar",
  pdf: "tb-ui-pdf",
  // kept from 0.7 so the saved rail state survives the upgrade
  ai: "tb-ai-rail",
  bottom: "tb-ui-bottom",
};

const PANEL_DEFAULTS: Record<PanelId, boolean> = {
  sidebar: true,
  pdf: true,
  ai: true,
  bottom: false,
};

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* storage unavailable */
  }
  return fallback;
}

function writeBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* best-effort */
  }
}

function loadTheme(): ThemeId {
  try {
    const saved = localStorage.getItem("tb-theme");
    if (saved === "liquid" || saved === "dark" || saved === "light") return saved;
  } catch {
    /* ignore */
  }
  return "liquid";
}

interface UiState {
  theme: ThemeId;
  panels: Record<PanelId, boolean>;
  /** Most recently opened side panel: kept visible when space runs out. */
  lastOpened: PanelId | null;
  /** Editor cursor for the status bar. */
  cursor: { line: number; col: number; selected: number } | null;
  sidebarTab: SidebarTab;
  bottomTab: BottomTab;
  modal: ModalState | null;
  palette: PaletteMode | null;
  /** File pinned in the side-by-side split editor. */
  splitFile: string | null;
  /** SyncTeX forward-search target (`y` in PDF points from the top, when
   *  known); `nonce` re-triggers the same page. */
  pdfTarget: { page: number; y?: number; h?: number; nonce: number } | null;
  /** Bumped to ask the AI panel to focus its input. */
  aiFocusNonce: number;
  editorPrefs: EditorPrefs;
  /** Prefill for the search panel (e.g. "find in project" on a selection). */
  searchSeed: { query: string; nonce: number } | null;

  setEditorPrefs: (patch: Partial<EditorPrefs>) => void;
  searchInProject: (query: string) => void;
  setTheme: (theme: ThemeId) => void;
  setPanel: (panel: PanelId, open: boolean) => void;
  togglePanel: (panel: PanelId) => void;
  setCursor: (cursor: UiState["cursor"]) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  /** Open the bottom panel on a given tab. */
  showProblems: (tab?: BottomTab) => void;
  setBottomTab: (tab: BottomTab) => void;
  openModal: (modal: ModalState) => void;
  closeModal: () => void;
  openPalette: (mode: PaletteMode) => void;
  closePalette: () => void;
  setSplitFile: (file: string | null) => void;
  showPdfPage: (page: number, y?: number, h?: number) => void;
  focusAi: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: loadTheme(),
  panels: {
    sidebar: readBool(PANEL_KEYS.sidebar, PANEL_DEFAULTS.sidebar),
    pdf: readBool(PANEL_KEYS.pdf, PANEL_DEFAULTS.pdf),
    ai: readBool(PANEL_KEYS.ai, PANEL_DEFAULTS.ai),
    bottom: readBool(PANEL_KEYS.bottom, PANEL_DEFAULTS.bottom),
  },
  lastOpened: null,
  cursor: null,
  sidebarTab: "files",
  bottomTab: "compile",
  modal: null,
  palette: null,
  splitFile: null,
  pdfTarget: null,
  aiFocusNonce: 0,
  editorPrefs: loadEditorPrefs(),
  searchSeed: null,

  setEditorPrefs(patch) {
    const next = { ...get().editorPrefs, ...patch };
    next.fontSize = Math.min(32, Math.max(9, Math.round(next.fontSize)));
    next.tabSize = Math.min(8, Math.max(1, Math.round(next.tabSize)));
    try {
      localStorage.setItem("tb-editor-prefs", JSON.stringify(next));
    } catch {
      /* best-effort */
    }
    set({ editorPrefs: next });
  },

  searchInProject(query) {
    set((s) => ({ searchSeed: { query, nonce: (s.searchSeed?.nonce ?? 0) + 1 } }));
    get().setSidebarTab("search");
  },

  setTheme(theme) {
    try {
      localStorage.setItem("tb-theme", theme);
    } catch {
      /* ignore */
    }
    set({ theme });
  },

  setPanel(panel, open) {
    if (get().panels[panel] === open) {
      // re-opening a pane that the layout auto-hid brings it to the front
      if (open) set({ lastOpened: panel });
      return;
    }
    writeBool(PANEL_KEYS[panel], open);
    set((s) => ({
      panels: { ...s.panels, [panel]: open },
      lastOpened: open ? panel : s.lastOpened === panel ? null : s.lastOpened,
    }));
  },

  setCursor(cursor) {
    set({ cursor });
  },

  togglePanel(panel) {
    get().setPanel(panel, !get().panels[panel]);
  },

  setSidebarTab(tab) {
    set({ sidebarTab: tab });
    get().setPanel("sidebar", true);
  },

  showProblems(tab) {
    if (tab) set({ bottomTab: tab });
    get().setPanel("bottom", true);
  },

  setBottomTab(tab) {
    set({ bottomTab: tab });
  },

  openModal(modal) {
    set({ modal, palette: null });
  },

  closeModal() {
    set({ modal: null });
  },

  openPalette(mode) {
    set({ palette: mode });
  },

  closePalette() {
    set({ palette: null });
  },

  setSplitFile(file) {
    set({ splitFile: file });
  },

  showPdfPage(page, y, h) {
    set((s) => ({ pdfTarget: { page, y, h, nonce: (s.pdfTarget?.nonce ?? 0) + 1 } }));
    get().setPanel("pdf", true);
  },

  focusAi() {
    get().setPanel("ai", true);
    set((s) => ({ aiFocusNonce: s.aiFocusNonce + 1 }));
  },
}));
