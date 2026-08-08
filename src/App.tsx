import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import ProjectTree from "./components/ProjectTree";
import OutlinePanel from "./components/OutlinePanel";
import BibPanel from "./components/BibPanel";
import TodoPanel from "./components/TodoPanel";
import EditorPane from "./components/Editor";
import SplitPane from "./components/SplitPane";
import PdfPreview from "./components/PdfPreview";
import ProblemsPanel from "./components/ProblemsPanel";
import AiPanel from "./components/AiPanel";
import SettingsModal from "./components/SettingsModal";
import { api } from "./api";
import { useProjectStore } from "./store/projectStore";
import { keyCombo, loadKeymap } from "./store/keymap";
import { loadStats, recordCompile, recordWords } from "./store/stats";
import { useCompileStore } from "./store/compileStore";
import { useAiStore } from "./store/aiStore";
import { useT } from "./i18n";
import { loadFlow } from "./flow";
import QuickOpenModal from "./components/QuickOpenModal";

/** Collapsible right rail hosting the AI panel: a thin
 * vertical strip when collapsed (does not take space), a full panel when
 * open. The state persists across launches. */
function AiRail() {
  const [open, setOpen] = useState(() => localStorage.getItem("tb-ai-rail") !== "0");
  const t = useT();
  const toggle = () => {
    const next = !open;
    setOpen(next);
    localStorage.setItem("tb-ai-rail", next ? "1" : "0");
  };
  return (
    <aside className={`ai-rail ${open ? "open" : "collapsed"}`}>
      <button className="ai-rail-toggle" onClick={toggle} title={open ? t("ai.collapse") : t("ai.expand")}>
        {open ? "◂" : "AI"}
      </button>
      {open && <AiPanel />}
    </aside>
  );
}

export type ThemeId = "liquid" | "dark" | "light";

function loadTheme(): ThemeId {
  try {
    const saved = window.localStorage.getItem("tb-theme");
    if (saved === "liquid" || saved === "dark" || saved === "light") return saved;
  } catch {
    /* ignore */
  }
  return "liquid";
}

export default function App() {
  const { root, mainFile, activeTab, pdfPath, toast } = useProjectStore();
  const { running, progress, compile, lastResult, elapsedSec, compileIssues, ruleIssues } =
    useCompileStore();
  const [compileCount, setCompileCount] = useState(() => {
    const s = loadStats(useProjectStore.getState().root);
    return s?.compiles ?? 0;
  });
  // dashboard: bump the per-project compile counter when a build finishes
  useEffect(() => {
    const unsub = useCompileStore.subscribe((s, prev) => {
      if (!s.running && prev.running && s.lastResult?.ok && s.lastResult !== prev.lastResult) {
        const root = useProjectStore.getState().root;
        if (root) setCompileCount(recordCompile(root).compiles);
      }
    });
    return () => unsub();
  }, []);
  // reload the counter when the project changes (open/switch)
  useEffect(() => {
    const unsub = useProjectStore.subscribe((s, prev) => {
      if (s.root !== prev.root) {
        const st = loadStats(s.root ?? "");
        setCompileCount(st?.compiles ?? 0);
      }
    });
    return () => unsub();
  }, []);
  const busy = useAiStore((s) => s.busy);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pdfRev, setPdfRev] = useState(0);
  const [leftTab, setLeftTab] = useState<"tree" | "outline" | "bib" | "todo">("tree");
  const [compileTarget, setCompileTarget] = useState<string>("main");
  const [roots, setRoots] = useState<string[]>([]);
  const [pdfPage, setPdfPage] = useState<number | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [splitFile, setSplitFile] = useState<string | null>(null);
  const [splitPick, setSplitPick] = useState(false);
  // "split view" button in the editor toolbar opens QuickOpen in split mode
  useEffect(() => {
    const onSplit = () => {
      setSplitPick(true);
      setQuickOpen(true);
    };
    window.addEventListener("tb:split-open", onSplit);
    return () => window.removeEventListener("tb:split-open", onSplit);
  }, []);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [wordCount, setWordCount] = useState<{ chars: number; cjk: number; words: number } | null>(null);
  const t = useT();

  // OTA: check GitHub for a newer release on startup (opt-out in Settings)
  useEffect(() => {
    const check = async () => {
      try {
        if (!(await api.getUpdateCheck())) return;
        const info = await api.checkUpdates();
        if (info) {
          const go = window.confirm(
            `${t("app.updateAvailable", { v: info.version })}\n\n${info.body.slice(0, 500)}\n\n${t("app.updateOpen")}`,
          );
          if (go) window.open(info.url, "_blank");
        }
      } catch {
        /* offline / rate-limited: stay quiet */
      }
    };
    const timer = window.setTimeout(() => void check(), 2500);
    return () => window.clearTimeout(timer);
  }, [t]);

  // multi-document roots: every compilable \documentclass file
  useEffect(() => {
    const load = async () => {
      const st = useProjectStore.getState();
      if (!st.root) return;
      try {
        setRoots(await api.listRoots());
      } catch {
        setRoots([]);
      }
    };
    void load();
    const unsub = useProjectStore.subscribe((s, prev) => {
      if (s.root !== prev.root) void load();
    });
    // auto-save: persist the active dirty tab on a configurable interval
    // (0 = off; the setting lives in localStorage, surfaced in Settings).
    // A 1s tick accumulates elapsed time and only saves once the chosen
    // interval has passed — the setting applies exactly.
    let lastSave = Date.now();
    const autoSaveIv = setInterval(() => {
      const secs = Number(localStorage.getItem("tb-autosave-secs") ?? "30");
      if (secs <= 0) return;
      if (Date.now() - lastSave < secs * 1000) return;
      lastSave = Date.now();
      const st = useProjectStore.getState();
      if (!st.root || !st.activeTab) return;
      const tab = st.tabs.find((t) => t.path === st.activeTab);
      if (tab?.dirty) void st.saveFile();
    }, 1000);
    // SyncTeX forward search: jump the PDF viewer to a page
    const onSynctex = (e: Event) => {
      const page = (e as CustomEvent<number>).detail;
      setPdfPage(page);
    };
    window.addEventListener("tb:synctex-page", onSynctex);
    return () => {
      unsub();
      clearInterval(autoSaveIv);
      window.removeEventListener("tb:synctex-page", onSynctex);
    };
  }, []);
  const refreshWordCount = useCallback(async () => {
    const st = useProjectStore.getState();
    if (!st.activeTab) {
      setWordCount(null);
      return;
    }
    try {
      const w = await api.countWords(st.activeTab);
      setWordCount({ chars: w.chars, cjk: w.cjk_chars, words: w.words });
      // dashboard: append the word sample to the project's history
      recordWords(st.root, w.chars, w.cjk_chars, w.words);
    } catch {
      setWordCount(null);
    }
  }, []);
  useEffect(() => {
    void refreshWordCount();
    const unsub = useProjectStore.subscribe((s, prev) => {
      if (s.activeTab !== prev.activeTab) void refreshWordCount();
    });
    window.addEventListener("tb:file-saved", refreshWordCount);
    return () => {
      unsub();
      window.removeEventListener("tb:file-saved", refreshWordCount);
    };
  }, [refreshWordCount]);
  const [theme, setTheme] = useState<ThemeId>(loadTheme());

  // apply theme to <html data-theme>
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("tb-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // close the theme picker on outside click / Escape
  useEffect(() => {
    if (!themePickerOpen) return;
    const onDown = (e: MouseEvent | KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setThemePickerOpen(false);
        return;
      }
      if (t && !t.closest(".theme-picker")) setThemePickerOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onDown);
    };
  }, [themePickerOpen]);

  // session restore + auto-compile + Ctrl+P quick open
  useEffect(() => {
    const flow = loadFlow();
    if (flow.restoreSession && flow.lastProject) {
      void useProjectStore
        .getState()
        .openProject(flow.lastProject)
        .then(() => {
          if (flow.lastFile) {
            void useProjectStore.getState().openFile(flow.lastFile);
          }
        })
        .catch(() => {
          /* project no longer exists — ignore */
        });
    }
    let timer: number | undefined;
    let ruleTimer: number | undefined;
    const onSaved = () => {
      const f = loadFlow();
      // refresh the ref/cite index + run the rule check (debounced) so the
      // dangling-ref rule and autocompletion stay current after a save
      window.clearTimeout(ruleTimer);
      ruleTimer = window.setTimeout(() => {
        void useProjectStore.getState().loadRefIndex();
        void useCompileStore.getState().runCheck();
      }, 600);
      if (!f.autoCompile) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void useCompileStore.getState().compile("main");
      }, 1200);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener("tb:file-saved", onSaved);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("tb:file-saved", onSaved);
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
      window.clearTimeout(ruleTimer);
    };
  }, []);

  const importWord = async () => {
    try {
      const file = await open({
        multiple: false,
        filters: [{ name: "Word", extensions: ["docx"] }],
      });
      if (!file || Array.isArray(file)) return;
      const r = await api.importDocx(file);
      window.alert(`已导入为 ${r.file}（${r.chars} 字符）。可在项目树中打开。`);
      await useProjectStore.getState().refresh();
      await useProjectStore.getState().openFile(r.file);
    } catch (e) {
      window.alert(String(e));
    }
  };

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

  // Global shortcuts: Ctrl+B compile (like VS Code), Ctrl+Shift+K compile current.
  // (Ctrl+Shift+B is reserved for the editor's bold-wrap; registering both
  // Compile shortcuts are configurable (Settings → 快捷键); the default
  // compile-main binding is Ctrl+B.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keyCombo(e) !== loadKeymap().compileMain) return;
      e.preventDefault();
      void useCompileStore.getState().compile("main");
    };
    const onKeyK = (e: KeyboardEvent) => {
      if (keyCombo(e) !== loadKeymap().compileCurrent) return;
      e.preventDefault();
      void useCompileStore.getState().compile("current");
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onKeyK);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onKeyK);
    };
  }, []);

  const totalIssues = compileIssues.length + ruleIssues.length;

  return (
    <div className="app">
      {theme === "liquid" && (
        <div className={`glass-blobs ${pdfPath ? "has-pdf" : ""}`} aria-hidden="true">
          <div className="blob blob-1" />
          <div className="blob blob-2" />
          <div className="blob blob-3" />
        </div>
      )}
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
          onChange={(e) => setCompileTarget(e.target.value)}
          disabled={running}
        >
          <option value="main">{t("toolbar.target.main", { file: mainFile || "main.tex" })}</option>
          {roots
            .filter((r) => r !== mainFile)
            .map((r) => (
              <option key={r} value={r}>
                {t("toolbar.target.root", { file: r })}
              </option>
            ))}
          <option value="current" disabled={!activeTab}>
            {activeTab
              ? t("toolbar.target.current", { file: activeTab.split("/").pop() ?? "" })
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
        <button className="btn" onClick={() => void importWord()} disabled={!root}>
          Word→LaTeX
        </button>
        {root && activeTab?.endsWith(".tex") && (
          <>
            <button
              className="btn"
              title={t("toolbar.exportMdTitle")}
              onClick={async () => {
                if (!activeTab) return;
                try {
                  const out = await api.exportFile(activeTab, "md");
                  window.alert(t("toolbar.exported", { file: out }));
                } catch (e) {
                  window.alert(String(e));
                }
              }}
            >
              {t("toolbar.exportMd")}
            </button>
            <button
              className="btn"
              title={t("toolbar.exportDocxTitle")}
              onClick={async () => {
                if (!activeTab) return;
                try {
                  const out = await api.exportFile(activeTab, "docx");
                  window.alert(t("toolbar.exported", { file: out }));
                } catch (e) {
                  window.alert(String(e));
                }
              }}
            >
              {t("toolbar.exportDocx")}
            </button>
          </>
        )}
        <button
          className="btn theme-picker-btn"
          title={t("theme.title")}
          onClick={() => setThemePickerOpen((v) => !v)}
        >
          <span className={`theme-swatch swatch-${theme}`} />
          {theme === "liquid" ? t("theme.liquid") : theme === "dark" ? t("theme.dark") : t("theme.light")}
        </button>
        {themePickerOpen && (
          <div className="theme-picker">
            <div className="theme-picker-menu">
              {(
                [
                  ["liquid", "theme.liquid", "swatch-liquid"],
                  ["dark", "theme.dark", "swatch-dark"],
                  ["light", "theme.light", "swatch-light"],
                ] as const
              ).map(([id, key, swatch]) => (
                <button
                  key={id}
                  className={`theme-option ${theme === id ? "active" : ""}`}
                  onClick={() => {
                    setTheme(id);
                    setThemePickerOpen(false);
                  }}
                >
                  <span className={`theme-swatch ${swatch}`} />
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        )}
        <button className="btn" onClick={() => setSettingsOpen(true)}>
          {t("toolbar.settings")}
        </button>
      </div>
      {progress && (running || progress.stage === "error") && (
        <div className={`compile-bar ${progress.stage === "error" ? "error" : ""}`}>
          <div
            className="compile-bar-fill"
            style={{ width: `${Math.round(progress.progress * 100)}%` }}
          />
          <span className="compile-bar-text">{progress.message}</span>
        </div>
      )}
      <div className="layout">
        <aside className="col-tree">
          <div className="tree-tabs">
            <button
              className={`tree-tab ${leftTab === "tree" ? "active" : ""}`}
              onClick={() => setLeftTab("tree")}
            >
              {t("tree.title")}
            </button>
            <button
              className={`tree-tab ${leftTab === "outline" ? "active" : ""}`}
              onClick={() => setLeftTab("outline")}
            >
              {t("outline.title")}
            </button>
            <button
              className={`tree-tab ${leftTab === "bib" ? "active" : ""}`}
              onClick={() => setLeftTab("bib")}
            >
              {t("bib.title")}
            </button>
            <button
              className={`tree-tab ${leftTab === "todo" ? "active" : ""}`}
              onClick={() => setLeftTab("todo")}
              title={t("todo.title")}
            >
              TODO
            </button>
          </div>
          {leftTab === "tree" && <ProjectTree />}
          {leftTab === "outline" && <OutlinePanel />}
          {leftTab === "bib" && <BibPanel />}
          {leftTab === "todo" && <TodoPanel />}
        </aside>
        <main className={`col-editor ${splitFile ? "is-split" : ""}`}>
          <EditorPane />
          {splitFile && <SplitPane file={splitFile} onClose={() => setSplitFile(null)} />}
        </main>
        <aside className={`col-pdf ${pdfPath ? "has-pdf" : ""}`}>
          <PdfPreview revision={pdfRev} page={pdfPage ?? undefined} />
        </aside>
        <AiRail />
      </div>
      <div className="bottom">
        <ProblemsPanel />
      </div>
      {toast && <div className="toast" key={toast.id}>{toast.text}</div>}
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
        {compileCount > 0 && (
          <span className="status-item" title={t("status.compilesTitle")}>
            {t("status.compiles", { n: compileCount })}
          </span>
        )}
        {wordCount && (
          <span className="status-item" title={t("status.wordsTitle")}>
            {t("status.words", { chars: wordCount.chars, cjk: wordCount.cjk, words: wordCount.words })}
          </span>
        )}
        <span className="status-spacer" />
        <span className="status-item status-root" title={root}>
          {root || t("status.noProject")}
        </span>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {quickOpen && (
        <QuickOpenModal
          onClose={() => {
            setQuickOpen(false);
            setSplitPick(false);
          }}
          onPick={(p) => {
            if (splitPick) {
              setSplitFile(p);
            } else {
              void useProjectStore.getState().openFile(p);
            }
            setSplitPick(false);
          }}
        />
      )}
      {busy && <div className="busy-overlay">{t("ai.busyDiagnose")}</div>}
    </div>
  );
}
