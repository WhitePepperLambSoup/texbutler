import { create } from "zustand";
import { api, onEvent, events, type CompileProgress, type CompileResult, type Issue } from "../api";
import { useProjectStore } from "./projectStore";
import { useI18n } from "../i18n";

interface CompileState {
  running: boolean;
  progress: CompileProgress | null;
  lastResult: CompileResult | null;
  compileIssues: Issue[];
  ruleIssues: Issue[];
  checkRunning: boolean;
  startedAt: number | null;
  elapsedSec: number | null;

  compile: (target?: "main" | "current" | string) => Promise<void>;
  cancel: () => void;
  runCheck: (onlyFile?: string) => Promise<void>;
  refreshDiagnostics: () => Promise<void>;
}

export const useCompileStore = create<CompileState>((set, get) => ({
  running: false,
  progress: null,
  lastResult: null,
  compileIssues: [],
  ruleIssues: [],
  checkRunning: false,
  startedAt: null,
  elapsedSec: null,

  async compile(target?: "main" | "current" | string) {
    if (get().running) return;
    let override: string | undefined;
    if (target === "current") {
      override = useProjectStore.getState().activeTab ?? undefined;
    } else if (target && target !== "main") {
      // multi-document root: compile that file directly
      override = target;
    }
    set({
      running: true,
      startedAt: Date.now(),
      elapsedSec: null,
      progress: { stage: "prepare", progress: 0, message: useI18n.getState().t("compile.prepare") },
    });
    try {
      await api.compile(override ?? undefined);
    } catch (e) {
      set({
        running: false,
        progress: { stage: "error", progress: 0, message: String(e) },
      });
    }
  },

  cancel() {
    api.cancelCompile();
  },

  async runCheck(onlyFile?: string) {
    set({ checkRunning: true });
    try {
      const res = await api.runCheck(onlyFile);
      set({ ruleIssues: res.issues, checkRunning: false });
    } catch (e) {
      console.error("runCheck failed", e);
      set({ checkRunning: false });
    }
  },

  async refreshDiagnostics() {
    try {
      const d = await api.diagnostics();
      set({ compileIssues: d.compile_issues, ruleIssues: d.rule_issues });
    } catch {
      /* not opened yet */
    }
  },
}));

// ---- event wiring ----
onEvent<CompileProgress>(events.compileProgress, (p) => {
  useCompileStore.setState({ progress: p });
});
onEvent<CompileResult>(events.compileDone, (r) => {
  const startedAt = useCompileStore.getState().startedAt;
  const elapsedSec = startedAt ? Math.round((Date.now() - startedAt) / 100) / 10 : null;
  useCompileStore.setState({
    running: false,
    lastResult: r,
    elapsedSec,
    progress: { stage: "done", progress: 1, message: r.ok ? useI18n.getState().t("compile.done") : useI18n.getState().t("compile.failed") },
    compileIssues: r.issues,
  });
  // refresh the PDF preview path
  if (r.pdf_path) {
    useProjectStore.setState({ pdfPath: r.pdf_path });
  }
  void useCompileStore.getState().refreshDiagnostics();
  // auto-run the rule check right after a compile (in addition to save-debounce)
  void useCompileStore.getState().runCheck();
});
onEvent(events.fileChanged, () => {
  // Debounce external file-change events: the notify watcher can burst
  // (multiple files saved at once), and every event used to trigger a full
  // tree re-scan + diagnostics refresh which made the UI lag.
  if (fileChangeTimer) window.clearTimeout(fileChangeTimer);
  fileChangeTimer = window.setTimeout(() => {
    fileChangeTimer = null;
    const st = useProjectStore.getState();
    if (st.root) {
      void st.refresh();
    }
    const cs = useCompileStore.getState();
    if (cs.lastResult) {
      void cs.refreshDiagnostics();
    }
  }, 400);
});
let fileChangeTimer: number | null = null;
