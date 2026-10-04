import { useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Info,
  Lightbulb,
  Loader2,
  Play,
  RefreshCw,
  ScrollText,
  Wrench,
  XCircle,
} from "lucide-react";
import type { Issue } from "../api";
import { useCompileStore } from "../store/compileStore";
import { useAiStore } from "../store/aiStore";
import { useUiStore } from "../store/uiStore";
import { severityLabel } from "../store/projectStore";
import { revealLocation } from "../editorBridge";
import { toast } from "../store/feedbackStore";
import { useT } from "../i18n";
import * as actions from "../actions";

/** Rule ids the backend repairs deterministically (no AI call). */
const DETERMINISTIC_RULES = new Set(["paragraph", "cjk_spacing"]);

function SeverityIcon({ severity }: { severity: Issue["severity"] }) {
  const props = { size: 15, className: "problem-sev-icon", "aria-label": severityLabel(severity) };
  if (severity === "error") return <XCircle {...props} />;
  if (severity === "warning") return <AlertTriangle {...props} />;
  if (severity === "info") return <Info {...props} />;
  return <Lightbulb {...props} />;
}

export default function ProblemsPanel() {
  const t = useT();
  const tab = useUiStore((s) => s.bottomTab);
  const open = useUiStore((s) => s.panels.bottom);
  const compileIssues = useCompileStore((s) => s.compileIssues);
  const ruleIssues = useCompileStore((s) => s.ruleIssues);
  const checkRunning = useCompileStore((s) => s.checkRunning);
  const lastResult = useCompileStore((s) => s.lastResult);
  const running = useCompileStore((s) => s.running);
  const aiBusy = useAiStore((s) => s.busy);
  const [busyIdx, setBusyIdx] = useState<number | null>(null);

  const issues = tab === "compile" ? compileIssues : ruleIssues;
  const compileErrors = compileIssues.filter((i) => i.severity === "error").length;

  const selectTab = (next: "compile" | "rules") => {
    useUiStore.getState().setBottomTab(next);
    useUiStore.getState().setPanel("bottom", true);
  };

  const jump = (issue: Issue) => {
    if (!issue.line && !issue.file) return;
    void revealLocation(issue.file ?? null, issue.line ?? 1, issue.col ?? 1).catch(toast.error);
  };

  const withBusy = async (i: number, job: () => Promise<unknown>) => {
    setBusyIdx(i);
    useUiStore.getState().setPanel("ai", true);
    try {
      await job();
    } finally {
      setBusyIdx(null);
    }
  };

  return (
    <div className="problems-panel">
      <div className="panel-header problems-header" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "compile"}
          className={`tab ${tab === "compile" ? "tab-active" : ""}`}
          onClick={() => selectTab("compile")}
        >
          {t("problems.compileTab")}
          <span className={`count-badge ${compileErrors > 0 ? "error" : ""}`}>{compileIssues.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "rules"}
          className={`tab ${tab === "rules" ? "tab-active" : ""}`}
          onClick={() => selectTab("rules")}
        >
          {t("problems.rulesTab")}
          {checkRunning ? (
            <Loader2 size={12} className="spinner" />
          ) : (
            <span className={`count-badge ${ruleIssues.length > 0 ? "warn" : ""}`}>{ruleIssues.length}</span>
          )}
        </button>
        <span className="toolbar-spacer" />
        {tab === "compile" && compileErrors > 0 && (
          <button
            className="btn btn-sm btn-primary problems-fix-all"
            disabled={aiBusy}
            title={t("problems.fixAllTitle")}
            onClick={() => {
              useUiStore.getState().setPanel("ai", true);
              void useAiStore.getState().fixAllIssues();
            }}
          >
            <Wrench size={13} /> {t("problems.fixAll")}
          </button>
        )}
        {tab === "rules" && (
          <button
            className="icon-btn icon-btn-sm"
            title={t("problems.runRules")}
            aria-label={t("problems.runRules")}
            disabled={checkRunning}
            onClick={() => void useCompileStore.getState().runCheck()}
          >
            <RefreshCw size={14} />
          </button>
        )}
        <button
          className="icon-btn icon-btn-sm"
          title={t("problems.logTitle")}
          aria-label={t("problems.log")}
          onClick={() => void actions.showCompileLog()}
        >
          <ScrollText size={14} />
        </button>
        <button
          className="icon-btn icon-btn-sm"
          title={open ? t("problems.collapse") : t("problems.expand")}
          aria-label={open ? t("problems.collapse") : t("problems.expand")}
          onClick={() => useUiStore.getState().togglePanel("bottom")}
        >
          {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
      </div>
      {open && (
        <div className="problems-body">
          {issues.length === 0 ? (
            <div className="problems-empty">
              {tab === "rules" ? (
                checkRunning ? (
                  <>
                    <Loader2 size={15} className="spinner" /> {t("problems.rulesRunning")}
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={15} className="ok" /> {t("problems.noRuleIssues")}
                  </>
                )
              ) : lastResult ? (
                <>
                  <CheckCircle2 size={15} className="ok" /> {t("problems.noErrors")}
                </>
              ) : (
                <>
                  {t("problems.notCompiled")}
                  <button className="btn btn-sm" disabled={running} onClick={() => actions.compile()}>
                    <Play size={13} /> {t("toolbar.compile")}
                  </button>
                </>
              )}
            </div>
          ) : (
            issues.map((issue, i) => (
              <div
                key={`${tab}-${i}`}
                className={`problem-row sev-${issue.severity}`}
                onClick={() => jump(issue)}
                title={issue.raw ?? issue.message}
              >
                <SeverityIcon severity={issue.severity} />
                <span className="problem-main">
                  <span className="problem-msg">{issue.message}</span>
                  {issue.fix_hint && <span className="problem-hint">{issue.fix_hint}</span>}
                </span>
                <span className={`problem-actions ${busyIdx === i ? "busy" : ""}`} onClick={(e) => e.stopPropagation()}>
                  <button
                    className="icon-btn icon-btn-sm"
                    title={t("problems.copy")}
                    aria-label={t("problems.copy")}
                    onClick={() => void actions.copyText(issue.raw ?? issue.message)}
                  >
                    <Copy size={13} />
                  </button>
                  {tab === "compile" ? (
                    <>
                      <button
                        className="btn btn-sm"
                        disabled={aiBusy}
                        onClick={() => void withBusy(i, () => useAiStore.getState().diagnoseIssue(issue, i))}
                      >
                        {busyIdx === i ? <Loader2 size={12} className="spinner" /> : <Bot size={13} />}
                        {t("problems.aiExplain")}
                      </button>
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={aiBusy}
                        onClick={() => void withBusy(i, () => useAiStore.getState().fixIssue(issue, i))}
                      >
                        <Wrench size={13} /> {t("problems.aiFix")}
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={aiBusy}
                      title={DETERMINISTIC_RULES.has(issue.rule_id ?? "") ? t("problems.ruleFixTitle") : t("problems.ruleAiFixTitle")}
                      onClick={() => void withBusy(i, () => useAiStore.getState().fixRuleIssueForSession(issue, 3, true))}
                    >
                      {busyIdx === i ? (
                        <Loader2 size={12} className="spinner" />
                      ) : DETERMINISTIC_RULES.has(issue.rule_id ?? "") ? (
                        <Wrench size={13} />
                      ) : (
                        <Bot size={13} />
                      )}
                      {DETERMINISTIC_RULES.has(issue.rule_id ?? "") ? t("problems.ruleFix") : t("problems.aiFix")}
                    </button>
                  )}
                </span>
                {issue.file && (
                  <span className="problem-loc">
                    {issue.file}
                    {issue.line ? `:${issue.line}` : ""}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
