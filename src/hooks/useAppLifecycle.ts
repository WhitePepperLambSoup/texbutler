import { useEffect } from "react";
import { api } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useCompileStore } from "../store/compileStore";
import { useAiStore } from "../store/aiStore";
import { useUiStore } from "../store/uiStore";
import { toast } from "../store/feedbackStore";
import { loadFlow, saveFlow } from "../flow";
import { removeRecent } from "../store/recent";
import { useI18n } from "../i18n";

/**
 * App-wide background behaviour that used to be spread over several
 * effects in App.tsx: session restore, auto-save, save-triggered checks and
 * auto-compile, the startup update check and AI conversation binding.
 */
export function useAppLifecycle() {
  // apply the theme to <html data-theme>
  const theme = useUiStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // keep <html lang> in sync for IME / screen readers
  const lang = useI18n((s) => s.lang);
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  useEffect(() => {
    // ---- session restore
    const flow = loadFlow();
    if (flow.restoreSession && flow.lastProject) {
      useProjectStore
        .getState()
        .openProject(flow.lastProject)
        .then(() => {
          const { files, activeTab } = useProjectStore.getState();
          if (flow.lastFile && flow.lastFile !== activeTab && fileExists(files, flow.lastFile)) {
            void useProjectStore.getState().openFile(flow.lastFile).catch(() => undefined);
          }
        })
        .catch(() => {
          // project no longer exists — drop it from the recent list and the
          // session flow so startup does not retry a dead project forever
          removeRecent(flow.lastProject);
          saveFlow({ lastProject: "", lastFile: "" });
        });
    }

    // ---- auto-save: persist dirty tabs on the configured interval
    // (0 = off). A 1 s tick checks elapsed time so the setting applies
    // exactly without restarting a timer when it changes.
    let lastSave = Date.now();
    const autoSave = window.setInterval(() => {
      const secs = Number(localStorage.getItem("tb-autosave-secs") ?? "30");
      if (secs <= 0 || Date.now() - lastSave < secs * 1000) return;
      lastSave = Date.now();
      const st = useProjectStore.getState();
      if (st.root && st.tabs.some((tab) => tab.dirty)) void st.saveAll().catch(() => undefined);
    }, 1000);

    // ---- after a save: refresh the ref index + rule check, auto-compile
    let compileTimer: number | undefined;
    let ruleTimer: number | undefined;
    const onSaved = () => {
      window.clearTimeout(ruleTimer);
      ruleTimer = window.setTimeout(() => {
        void useProjectStore.getState().loadRefIndex();
        void useCompileStore.getState().runCheck();
      }, 600);
      if (!loadFlow().autoCompile) return;
      window.clearTimeout(compileTimer);
      compileTimer = window.setTimeout(() => {
        // compile what the Compile button would compile (selected target)
        void useCompileStore.getState().compile();
      }, 1200);
    };
    window.addEventListener("tb:file-saved", onSaved);

    // ---- AI conversations are scoped to project + file; observe both
    // together so an old tab is never rebound under a newly opened root.
    useAiStore.getState().attachFile(useProjectStore.getState().root, useProjectStore.getState().activeTab);
    const unsubAi = useProjectStore.subscribe((s, prev) => {
      if (s.root !== prev.root || s.activeTab !== prev.activeTab) {
        useAiStore.getState().attachFile(s.root, s.activeTab);
      }
    });

    // ---- live rule check of the file being edited (debounced, current
    // file only so typing stays responsive)
    let typingTimer: number | undefined;
    const unsubTyping = useProjectStore.subscribe((s, prev) => {
      if (!s.root || !s.activeTab) return;
      const cur = s.tabs.find((tab) => tab.path === s.activeTab)?.content;
      const old = prev.tabs.find((tab) => tab.path === s.activeTab)?.content;
      if (cur === old && s.activeTab === prev.activeTab) return;
      const file = s.activeTab;
      window.clearTimeout(typingTimer);
      typingTimer = window.setTimeout(() => void useCompileStore.getState().runCheck(file), 500);
    });

    // ---- startup update check (opt-out in Settings); non-blocking toast
    const updateTimer = window.setTimeout(async () => {
      try {
        if (!(await api.getUpdateCheck())) return;
        const info = await api.checkUpdates();
        if (!info) return;
        const t = useI18n.getState().t;
        toast.info(t("app.updateAvailableShort", { v: info.version }), {
          label: t("app.updateView"),
          run: () => window.open(info.url, "_blank"),
        });
      } catch {
        /* offline / rate-limited: stay quiet */
      }
    }, 2500);

    return () => {
      window.clearInterval(autoSave);
      window.clearTimeout(compileTimer);
      window.clearTimeout(ruleTimer);
      window.clearTimeout(typingTimer);
      window.clearTimeout(updateTimer);
      window.removeEventListener("tb:file-saved", onSaved);
      unsubAi();
      unsubTyping();
    };
  }, []);
}

function fileExists(nodes: { path: string; is_dir: boolean; children: unknown[] }[], path: string): boolean {
  for (const n of nodes) {
    if (!n.is_dir && n.path === path) return true;
    if (n.is_dir && fileExists(n.children as typeof nodes, path)) return true;
  }
  return false;
}
