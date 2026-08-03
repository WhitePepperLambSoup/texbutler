import { useEffect, useRef, useState } from "react";
import { useAiStore } from "../store/aiStore";
import { api } from "../api";
import { useProjectStore } from "../store/projectStore";
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
  const [genInput, setGenInput] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [genResult, setGenResult] = useState<string | null>(null);
  const { openPath } = useProjectStore();

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
      <div className="ai-generate">
        <textarea
          className="ai-generate-input"
          placeholder={t("ai.generatePlaceholder")}
          value={genInput}
          onChange={(e) => setGenInput(e.target.value)}
          rows={2}
        />
        <div className="ai-generate-actions">
          <button
            className="btn-mini btn-primary"
            disabled={genBusy || !genInput.trim()}
            onClick={async () => {
              setGenBusy(true);
              setGenResult(null);
              try {
                const code = await api.aiGenerate(genInput.trim());
                setGenResult(code);
                useAiStore
                  .getState()
                  .pushMessage({
                    role: "user",
                    kind: "plain",
                    text: genInput.trim(),
                  });
              } catch (e) {
                window.alert(String(e));
              }
              setGenBusy(false);
            }}
          >
            {genBusy ? t("ai.busyFix") : t("ai.generate")}
          </button>
          {genResult != null && (
            <>
              <button
                className="btn-mini"
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent("tb:insert-text", { detail: { text: genResult } })
                  );
                }}
              >
                {t("ai.insertEditor")}
              </button>
              <button
                className="btn-mini"
                onClick={async () => {
                  const base = (openPath ?? "main.tex").replace(/\.tex$/, "");
                  const fname = window.prompt("保存为文件（相对路径）", `${base}-ai.tex`);
                  if (!fname) return;
                  try {
                    await api.writeFile(fname, genResult);
                    window.alert(t("ai.savedFile", { f: fname }));
                  } catch (e) {
                    window.alert(String(e));
                  }
                }}
              >
                {t("ai.saveFile")}
              </button>
            </>
          )}
        </div>
        {genResult != null && <pre className="ai-diff ai-gen-result">{genResult}</pre>}
      </div>
    </div>
  );
}
