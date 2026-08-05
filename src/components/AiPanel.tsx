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
  const { messages, busy, busyKind, diffPending, acceptDiff, rejectDiff, applyHunk, clearMessages, suggestMode, toggleSuggestMode, pendingSelection, setSelection, askAi } =
    useAiStore();
  const [expandedRaw, setExpandedRaw] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const [genInput, setGenInput] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [genResult, setGenResult] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<{ path: string; ts: string; file: string }[] | null>(null);
  const activeTab = useProjectStore((s) => s.activeTab);

  const loadSnapshots = async () => {
    try {
      const list = await api.aiSnapshots();
      setSnapshots(list);
    } catch {
      setSnapshots([]);
    }
  };

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, diffPending]);

  return (
    <div className="ai-panel">
      <div className="panel-header">
        <span className="panel-title">{t("ai.title")}</span>
        <span className="panel-actions">
          {busy && <span className="ai-busy">{busyKind === "fix" ? t("ai.busyFix") : t("ai.busyDiagnose")}</span>}
          <button
            className={`btn-mini ${suggestMode ? "btn-primary" : ""}`}
            title={t("ai.suggestMode")}
            onClick={toggleSuggestMode}
          >
            {suggestMode ? "●" : "○"} {t("ai.suggestMode")}
          </button>
          <button className="btn-mini" title={t("ai.timeline")} onClick={() => void loadSnapshots()}>
            {t("ai.timeline")}
          </button>
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
          <span>{diffPending.suggested ? t("ai.suggestBar", { n: diffPending.rounds }) : t("ai.diffBar", { n: diffPending.rounds })}</span>
          {!diffPending.suggested && (
            <button className="btn-mini btn-primary" onClick={() => void acceptDiff()}>
              {t("ai.diffApply")}
            </button>
          )}
          <button className="btn-mini" onClick={rejectDiff}>
            {t("ai.diffReject")}
          </button>
        </div>
      )}
      {diffPending?.suggested && diffPending.hunks && diffPending.hunks.length > 0 && (
        <div className="ai-hunks">
          {diffPending.hunks.map((h, i) => (
            <div key={i} className="ai-hunk">
              <div className="ai-hunk-head">
                <span>{h.file}:{h.line}</span>
                {h.why && <span className="ai-hunk-why">{h.why}</span>}
              </div>
              {h.old && <pre className="ai-hunk-old">{h.old}</pre>}
              {h.new && <pre className="ai-hunk-new">{h.new}</pre>}
              <button
                className="btn-mini btn-primary"
                onClick={() => {
                  const patch = `--- a/${h.file}\n+++ b/${h.file}\n@@ -${Math.max(1, h.line - 1)},${h.old.split("\n").length} +${h.line},${h.new.split("\n").length} @@\n${h.old
                    .split("\n")
                    .map((l) => `-${l}`)
                    .join("\n")}\n${h.new
                    .split("\n")
                    .map((l) => `+${l}`)
                    .join("\n")}\n`;
                  void applyHunk(h.file, patch);
                }}
              >
                {t("ai.hunkApply")}
              </button>
            </div>
          ))}
        </div>
      )}
      {snapshots != null && (
        <div className="ai-hunks">
          <div className="ai-hunk-head">
            <span>{t("ai.timelineTitle")}</span>
            <button className="btn-mini" onClick={() => setSnapshots(null)}>
              {t("ai.timelineClose")}
            </button>
          </div>
          {snapshots.length === 0 && <div className="ai-hunk-why">{t("ai.timelineEmpty")}</div>}
          {snapshots.map((snap, i) => (
            <div key={i} className="ai-hunk">
              <div className="ai-hunk-head">
                <span>{snap.file}</span>
                <span className="ai-hunk-why">
                  {new Date(Number(snap.ts) * 1000).toLocaleString()}
                </span>
              </div>
              <button
                className="btn-mini btn-primary"
                onClick={() => {
                  void api.aiRollback(snap.path).then((rel) => {
                    useAiStore.getState().pushMessage({
                      role: "system",
                      kind: "plain",
                      text: t("ai.timelineRestored", { file: rel }),
                    });
                    const active = useProjectStore.getState().activeTab;
                    if (active) void useProjectStore.getState().reloadTab(active);
                    void loadSnapshots();
                  });
                }}
              >
                {t("ai.timelineRestore")}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="ai-generate">
        <div className="ai-chat-row">
          <textarea
            className="ai-generate-input"
            placeholder={pendingSelection ? t("ai.askPlaceholderSel") : t("ai.askPlaceholder")}
            value={genInput}
            onChange={(e) => setGenInput(e.target.value)}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void askAi(genInput);
                setGenInput("");
              }
            }}
          />
          <button
            className="btn-mini btn-primary"
            disabled={busy || !genInput.trim()}
            title={t("ai.askTitle")}
            onClick={() => {
              void askAi(genInput);
              setGenInput("");
            }}
          >
            {t("ai.askSend")}
          </button>
        </div>
        <div className="ai-generate-actions">
          {pendingSelection && (
            <button
              className="btn-mini"
              title={t("ai.askClearSel")}
              onClick={() => setSelection(null)}
            >
              {t("ai.askSelection", { n: pendingSelection.length })}
            </button>
          )}
          <button
            className="btn-mini"
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
                  const base = (activeTab ?? "main.tex").replace(/\.tex$/, "");
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
