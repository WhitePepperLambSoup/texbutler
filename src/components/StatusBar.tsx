import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Loader2, XCircle } from "lucide-react";
import { api } from "../api";
import { useProjectStore } from "../store/projectStore";
import { useCompileStore } from "../store/compileStore";
import { useUiStore } from "../store/uiStore";
import { recordWords } from "../store/stats";
import { useT } from "../i18n";

function useWordCount() {
  const activeTab = useProjectStore((s) => s.activeTab);
  const [count, setCount] = useState<{ chars: number; cjk: number; words: number } | null>(null);

  const refresh = useCallback(async () => {
    const st = useProjectStore.getState();
    if (!st.activeTab || !st.activeTab.endsWith(".tex")) {
      setCount(null);
      return;
    }
    try {
      const w = await api.countWords(st.activeTab);
      setCount({ chars: w.chars, cjk: w.cjk_chars, words: w.words });
      // dashboard: append the sample to the project's word history
      recordWords(st.root, w.chars, w.cjk_chars, w.words);
    } catch {
      setCount(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [activeTab, refresh]);

  useEffect(() => {
    window.addEventListener("tb:file-saved", refresh);
    return () => window.removeEventListener("tb:file-saved", refresh);
  }, [refresh]);

  return count;
}

export default function StatusBar() {
  const t = useT();
  const root = useProjectStore((s) => s.root);
  const running = useCompileStore((s) => s.running);
  const progress = useCompileStore((s) => s.progress);
  const lastResult = useCompileStore((s) => s.lastResult);
  const elapsedSec = useCompileStore((s) => s.elapsedSec);
  const compileCount = useCompileStore((s) => s.compileCount);
  const errors = useCompileStore(
    (s) => s.compileIssues.filter((i) => i.severity === "error").length + s.ruleIssues.filter((i) => i.severity === "error").length,
  );
  const total = useCompileStore((s) => s.compileIssues.length + s.ruleIssues.length);
  const cursor = useUiStore((s) => s.cursor);
  const hasEditor = useProjectStore((s) => Boolean(s.activeTab));
  const words = useWordCount();

  if (!root) {
    return (
      <footer className="statusbar">
        <span className="status-item">{t("status.noProject")}</span>
      </footer>
    );
  }

  const warnings = total - errors;
  const engine = lastResult ? (lastResult.engine === "tectonic" ? "Tectonic" : "TeX Live / MiKTeX") : null;

  return (
    <footer className="statusbar">
      <button
        className={`status-item ${errors > 0 ? "has-errors" : ""} ${warnings > 0 ? "has-warnings" : ""}`}
        title={t("status.issuesTitle")}
        onClick={() => useUiStore.getState().togglePanel("bottom")}
      >
        <XCircle size={13} aria-hidden="true" /> {errors}
        <AlertTriangle size={13} aria-hidden="true" /> {warnings}
      </button>
      {running ? (
        <span className="status-item">
          <Loader2 size={13} className="spinner" aria-hidden="true" />
          {progress?.message ?? t("toolbar.compiling")}
        </span>
      ) : lastResult ? (
        <button
          className={`status-item ${lastResult.ok ? "ok" : "fail"}`}
          title={t("status.resultTitle")}
          onClick={() => useUiStore.getState().showProblems("compile")}
        >
          {lastResult.ok ? <CheckCircle2 size={13} aria-hidden="true" /> : <XCircle size={13} aria-hidden="true" />}
          {lastResult.ok ? t("status.ok") : t("status.fail")}
          {elapsedSec != null && ` · ${t("status.duration", { s: elapsedSec })}`}
        </button>
      ) : null}
      {engine && (
        <span className="status-item" title={t("status.engineTitle")}>
          <Cpu size={13} aria-hidden="true" />
          {engine}
          {lastResult?.fell_back ? t("status.engineFellBack") : ""}
        </span>
      )}
      {compileCount > 0 && (
        <span className="status-item" title={t("status.compilesTitle")}>
          {t("status.compiles", { n: compileCount })}
        </span>
      )}
      <span className="status-spacer" />
      {hasEditor && cursor && (
        <span className="status-item" title={t("status.cursorTitle")}>
          {t("status.cursor", { line: cursor.line, col: cursor.col })}
          {cursor.selected > 0 && ` (${t("status.selected", { n: cursor.selected })})`}
        </span>
      )}
      {words && (
        <span className="status-item" title={t("status.wordsTitle")}>
          {t("status.words", { chars: words.chars, cjk: words.cjk, words: words.words })}
        </span>
      )}
      <span className="status-item status-root" title={root}>
        {root}
      </span>
    </footer>
  );
}
