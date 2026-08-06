import { useEffect, useState } from "react";
import { api, type Issue } from "../api";
import { useCompileStore } from "../store/compileStore";
import { useProjectStore } from "../store/projectStore";
import { useAiStore } from "../store/aiStore";
import { severityLabel } from "../store/projectStore";
import { useT } from "../i18n";

type Tab = "compile" | "rules" | "ai";

export default function ProblemsPanel() {
  const [tab, setTab] = useState<Tab>("compile");
  const { compileIssues, ruleIssues, runCheck, checkRunning, lastResult } = useCompileStore();
  const { openFile } = useProjectStore();
  const { diagnoseIssue, fixIssue, busy } = useAiStore();
  const [aiBusyIdx, setAiBusyIdx] = useState<number | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [logText, setLogText] = useState("");
  const t = useT();

  // debounce rule check when editor content changes (500ms) — only the
  // current file is scanned so typing stays responsive
  const activeTab = useProjectStore((s) => s.activeTab);
  const openContent = useProjectStore((s) => s.tabs.find((t) => t.path === s.activeTab)?.content ?? "");
  useEffect(() => {
    const root = useProjectStore.getState().root;
    const file = useProjectStore.getState().activeTab;
    if (!root || !file) return;
    const t = window.setTimeout(() => {
      void useCompileStore.getState().runCheck(file);
    }, 500);
    return () => window.clearTimeout(t);
  }, [openContent, activeTab]);

  const issues = tab === "compile" ? compileIssues : ruleIssues;

  const jump = (issue: Issue) => {
    const file = issue.file ?? null;
    const needOpen = !!file && file !== useProjectStore.getState().activeTab;
    if (needOpen) {
      void openFile(file);
    }
    if (issue.line) {
      // Wait for the file (and Monaco model) to load before jumping.
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("tb:goto-line", { detail: { line: issue.line } })
        );
      }, needOpen ? 250 : 50);
    }
  };

  return (
    <div className="problems-panel">
      <div className="panel-header tabs">
        <button
          className={`tab ${tab === "compile" ? "tab-active" : ""}`}
          onClick={() => setTab("compile")}
        >
          {t("problems.compile", { n: compileIssues.length })}
        </button>
        <button
          className={`tab ${tab === "rules" ? "tab-active" : ""}`}
          onClick={() => setTab("rules")}
        >
          {t("problems.rules", { n: ruleIssues.length })}
          {checkRunning ? " …" : ""}
        </button>
        <span className="toolbar-spacer" />
        <button
          className="btn-mini"
          title={t("problems.logTitle")}
          onClick={() => {
            void api.readLog().then((tt) => {
              setLogText(tt);
              setLogOpen(true);
            }).catch((e) => window.alert(String(e)));
          }}
        >
          {t("problems.log")}
        </button>
      </div>
      <div className="problems-body">
        {issues.length === 0 ? (
          <div className="problems-empty">
            {tab === "rules" && !checkRunning && (
              <button onClick={() => void runCheck()}>{t("problems.runRules")}</button>
            )}
            {tab === "rules" && checkRunning && <span>{t("problems.rulesRunning")}</span>}
            {tab === "compile" && (lastResult ? t("problems.noErrors") : t("problems.notCompiled"))}
          </div>
        ) : (
          issues.map((issue, i) => (
            <div
              key={`${tab}-${i}`}
              className={`problem-row sev-${issue.severity}`}
              onClick={() => jump(issue)}
            >
              <span className="problem-sev">{severityLabel(issue.severity)}</span>
              <span className="problem-loc">
                {issue.file ?? "?"}:{issue.line ?? "?"}
                {issue.col ? `:${issue.col}` : ""}
              </span>
              <span className="problem-main">
                <span className="problem-msg" title={issue.raw ?? ""}>
                  {issue.message}
                </span>
                {issue.fix_hint && (
                  <span className="problem-hint">{issue.fix_hint}</span>
                )}
              </span>
              <span className="problem-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn-mini"
                  title={t("problems.copy")}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(issue.raw ?? issue.message)
                      .catch(() => undefined);
                  }}
                >
                  ⧉
                </button>
                {tab === "compile" && (
                  <>
                    <button
                      className="btn-mini"
                      disabled={busy}
                      onClick={() => {
                        setAiBusyIdx(i);
                        void diagnoseIssue(issue, i).finally(() => setAiBusyIdx(null));
                      }}
                    >
                      {aiBusyIdx === i ? "…" : t("problems.aiExplain")}
                    </button>
                    <button
                      className="btn-mini btn-primary"
                      disabled={busy}
                      onClick={() => {
                        setAiBusyIdx(i);
                        void fixIssue(issue, i).finally(() => setAiBusyIdx(null));
                      }}
                    >
                      {aiBusyIdx === i ? "…" : t("problems.aiFix")}
                    </button>
                  </>
                )}
                {tab === "rules" && (
                  <button
                    className="btn-mini btn-primary"
                    disabled={busy}
                    title={t("problems.ruleFixTitle")}
                    onClick={() => {
                      setAiBusyIdx(i);
                      void (async () => {
                        try {
                          const report = await api.fixRuleIssue(issue, 3, true);
                          await runCheck();
                          useAiStore
                            .getState()
                            .pushMessage({
                              role: "assistant",
                              kind: "fix",
                              text: report.summary,
                              report,
                            });
                        } catch (e) {
                          useAiStore
                            .getState()
                            .pushMessage({ role: "assistant", kind: "error", text: String(e) });
                        } finally {
                          setAiBusyIdx(null);
                        }
                      })();
                    }}
                  >
                    {aiBusyIdx === i ? "…" : t("problems.ruleFix")}
                  </button>
                )}
              </span>
            </div>
          ))
        )}
      </div>
      {logOpen && (
        <div className="modal-backdrop" onClick={() => setLogOpen(false)}>
          <div className="modal log-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>{t("problems.logTitle")}</span>
              <span className="panel-actions">
                <button
                  className="btn-mini"
                  onClick={() => {
                    void navigator.clipboard.writeText(logText).catch(() => undefined);
                  }}
                >
                  {t("problems.copyAll")}
                </button>
                <button className="btn-mini" onClick={() => setLogOpen(false)}>
                  ×
                </button>
              </span>
            </div>
            <pre className="log-viewer">{logText}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
