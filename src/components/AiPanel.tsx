import { useEffect, useRef, useState } from "react";
import { useAiStore } from "../store/aiStore";
import { useT } from "../i18n";

/** Minimal markdown-ish rendering for AI messages (bold, inline code, breaks). */
function renderText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br/>");
}

export default function AiPanel() {
  const { messages, busy, busyKind, diffPending, acceptDiff, rejectDiff, clearMessages } =
    useAiStore();
  const [expandedRaw, setExpandedRaw] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, diffPending]);

  return (
    <div className="ai-panel">
      <div className="panel-header">
        <span className="panel-title">{t("ai.title")}</span>
        <span className="panel-actions">
          {busy && <span className="ai-busy">{busyKind === "fix" ? t("ai.busyFix") : t("ai.busyDiagnose")}</span>}
          <button className="btn-mini" onClick={clearMessages}>
            {t("ai.clear")}
          </button>
        </span>
      </div>
      <div className="ai-body" ref={bodyRef}>
        {messages.length === 0 && (
          <div className="ai-empty">{t("ai.empty")}</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`ai-msg ai-${m.role}`}>
            <div
              className="ai-text"
              dangerouslySetInnerHTML={{ __html: renderText(m.text) }}
            />
            {m.diff && (
              <pre className="ai-diff">{m.diff}</pre>
            )}
            {m.raw && (
              <div className="ai-raw-toggle">
                <button className="btn-mini" onClick={() => setExpandedRaw(expandedRaw === m.id ? null : m.id)}>
                  {expandedRaw === m.id ? t("ai.rawToggleHide") : t("ai.rawToggleShow")}
                </button>
                {expandedRaw === m.id && <pre className="ai-raw">{m.raw}</pre>}
              </div>
            )}
          </div>
        ))}
      </div>
      {diffPending && (
        <div className="ai-diff-bar">
          <span>{t("ai.diffBar", { n: diffPending.rounds })}</span>
          <button className="btn-mini btn-primary" onClick={() => void acceptDiff()}>
            {t("ai.diffApply")}
          </button>
          <button className="btn-mini" onClick={rejectDiff}>
            {t("ai.diffReject")}
          </button>
        </div>
      )}
    </div>
  );
}
