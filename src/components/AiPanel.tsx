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

/** Highlight a unified diff for the AI-applied edit: added lines green,
 * removed lines red, context grey — so the user can SEE what changed. */
function DiffHighlight({ diff }: { diff: string }) {
  const rows = diff.split("\n").map((line, i) => {
    let cls = "ctx";
    let text = line;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      cls = "add";
      text = line.slice(1);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      cls = "del";
      text = line.slice(1);
    } else if (line.startsWith("@@")) {
      cls = "hunk";
    } else if (line.startsWith("+++") || line.startsWith("---")) {
      cls = "head";
      text = line.slice(4);
    } else if (line.startsWith(" ")) {
      text = line.slice(1);
    }
    return (
      <div key={i} className={`diff-line ${cls}`}>
        <span className="diff-mark">{cls === "add" ? "+" : cls === "del" ? "−" : ""}</span>
        <span className="diff-text">{text || "\u00A0"}</span>
      </div>
    );
  });
  return <div className="diff-view">{rows}</div>;
}

export default function AiPanel() {
  const { messages, busy, busyKind, diffPending, acceptDiff, rejectDiff, applyHunk, clearMessages, suggestMode, toggleSuggestMode, pendingSelection, setSelection, askAi, lastEdits, rollbackEdit, sessions, sessionId, newSession, switchSession, renameSession, deleteSession } =
    useAiStore();
  const [expandedRaw, setExpandedRaw] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const [genInput, setGenInput] = useState("");
  const [snapshots, setSnapshots] = useState<{ path: string; ts: string; file: string }[] | null>(null);
  const newestAppliedId = messages.filter((m) => m.applied).slice(-1)[0]?.id ?? null;
  const [usage, setUsage] = useState<{ prompt_tokens: number; completion_tokens: number; requests: number; cost_usd: number } | null>(null);

  const refreshUsage = async () => {
    try {
      setUsage(await api.tokenUsage());
    } catch {
      setUsage(null);
    }
  };

  useEffect(() => {
    void refreshUsage();
  }, [messages.length]);

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
        <select
          className="session-select"
          value={sessionId ?? ""}
          onChange={(e) => switchSession(e.target.value || null)}
          title={t("ai.sessionTitle")}
          disabled={busy}
        >
          <option value="">{t("ai.sessionScratch")}</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          className="btn-mini"
          title={t("ai.sessionNew")}
          onClick={newSession}
          disabled={busy}
        >
          +
        </button>
        {sessionId && (
          <>
            <button
              className="btn-mini"
              title={t("ai.sessionRename")}
              disabled={busy}
              onClick={() => {
                const name = window.prompt(t("ai.sessionRename"), sessions.find((s) => s.id === sessionId)?.name ?? "");
                if (name) renameSession(sessionId, name);
              }}
            >
              ✎
            </button>
            <button
              className="btn-mini"
              title={t("ai.sessionDelete")}
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("ai.sessionDeleteConfirm"))) deleteSession(sessionId);
              }}
            >
              ✕
            </button>
          </>
        )}
        {usage && (
          <span className="ai-usage" title={t("ai.usageTitle")}>
            {t("ai.usage", {
              p: usage.prompt_tokens,
              c: usage.completion_tokens,
              cost: (usage.cost_usd * 7.2).toFixed(2),
            })}
            <button
              className="btn-mini"
              title={t("ai.usageReset")}
              onClick={async () => {
                await api.tokenUsageReset();
                setUsage(null);
                void refreshUsage();
              }}
            >
              {t("ai.usageReset")}
            </button>
          </span>
        )}
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
          <button
            className="btn-mini"
            title={t("ai.guideTitle")}
            onClick={() => {
              const req = window.prompt(t("ai.guidePrompt"));
              if (!req) return;
              void (async () => {
                try {
                  const guide = await api.aiCreateGuide(req);
                  const preview = guide.length > 12000 ? `${guide.slice(0, 12000)}\n…（指南过长，仅预览前 12000 字符）` : guide;
                  const ok = window.confirm(`${t("ai.guideGenerated")}\n\n${preview}`);
                  if (ok) {
                    await api.writeFile("AI_GUIDE.md", guide);
                    window.alert(t("ai.guideSaved"));
                  }
                } catch (e) {
                  window.alert(String(e));
                }
              })();
            }}
          >
            {t("ai.guide")}
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
            {/* collaborative edit: the AI changed a file — roll back right
                inside the message bubble (compile-check then decide).
                Only the newest applied message shows the buttons. */}
            {m.role === "assistant" && m.applied && lastEdits.length > 0 && m.id === newestAppliedId && (
              <div className="ai-msg-actions">
                {lastEdits.map((e) => (
                  <div key={e.file} className="ai-rollback-row">
                    {e.diff && <DiffHighlight diff={e.diff} />}
                    <button className="btn-mini btn-danger" onClick={() => void rollbackEdit(e.file)}>
                      {t("ai.rollback", { file: e.file })}
                    </button>
                  </div>
                ))}
              </div>
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
            rows={3}
            onKeyDown={(e) => {
              // Enter sends (also Ctrl/Cmd+Enter for muscle memory);
              // Shift+Enter inserts a newline. isComposing guards the IME
              // confirmation Enter (Chinese input methods) from sending.
              if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing) {
                if (!busy && genInput.trim()) {
                  e.preventDefault();
                  void askAi(genInput);
                  setGenInput("");
                }
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
          {lastEdits.map((e) => (
            <button
              key={e.file}
              className="btn-mini btn-danger"
              title={t("ai.rollbackTitle")}
              onClick={() => void rollbackEdit(e.file)}
            >
              {t("ai.rollback", { file: e.file })}
            </button>
          ))}
          {pendingSelection && (
            <button
              className="btn-mini"
              title={t("ai.askClearSel")}
              onClick={() => setSelection(null)}
            >
              {t("ai.askSelection", { n: pendingSelection.length })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
