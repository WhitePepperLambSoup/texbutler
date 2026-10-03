import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpenText,
  Bot,
  Eraser,
  FileText,
  History,
  ListChecks,
  MoreHorizontal,
  PanelRightClose,
  Pencil,
  Plus,
  RotateCcw,
  ScanSearch,
  SendHorizontal,
  Settings,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { aiEditBelongsToScope, sessionIsMeaningful, useAiStore } from "../store/aiStore";
import { useUiStore } from "../store/uiStore";
import { dialog, toast } from "../store/feedbackStore";
import { usePopover } from "../hooks/usePopover";
import { api } from "../api";
import { useT } from "../i18n";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

/** Small, safe markdown subset for AI replies: fenced code, headings,
 *  bullet / numbered lists, inline code, bold. Everything is escaped first. */
export function renderText(text: string): string {
  const out: string[] = [];
  const parts = text.split(/```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre><code>${escapeHtml(part.replace(/\n$/, ""))}</code></pre>`);
      return;
    }
    let list: "ul" | "ol" | null = null;
    let para: string[] = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join("<br/>")}</p>`);
      para = [];
    };
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    for (const line of part.split("\n")) {
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)、]\s+(.*)$/);
      const heading = line.match(/^#{1,4}\s+(.*)$/);
      if (bullet || numbered) {
        flushPara();
        const kind = bullet ? "ul" : "ol";
        if (list !== kind) {
          closeList();
          out.push(`<${kind}>`);
          list = kind;
        }
        out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`);
      } else if (heading) {
        flushPara();
        closeList();
        out.push(`<h4>${inline(heading[1])}</h4>`);
      } else if (!line.trim()) {
        flushPara();
        closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    flushPara();
    closeList();
  });
  return out.join("");
}

/** Highlight a unified diff for the AI-applied edit: added lines green,
 * removed lines red, context grey — so the user can SEE what changed. */
function DiffHighlight({ diff }: { diff: string }) {
  // Track each hunk's declared line counts: text after the last hunk (the
  // AI's explanation, often a `- ` bullet list) is NOT part of the diff and
  // must not be painted as deleted lines.
  let oldLeft = 0;
  let newLeft = 0;
  const rows = diff.replace(/\n+$/, "").split("\n").map((line, i) => {
    let cls = "ctx";
    let text = line;
    const header = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (header) {
      cls = "hunk";
      oldLeft = header[1] === undefined ? 1 : Number(header[1]);
      newLeft = header[2] === undefined ? 1 : Number(header[2]);
    } else if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("+")) {
        cls = "add";
        text = line.slice(1);
        newLeft--;
      } else if (line.startsWith("-")) {
        cls = "del";
        text = line.slice(1);
        oldLeft--;
      } else {
        text = line.startsWith(" ") ? line.slice(1) : line;
        oldLeft--;
        newLeft--;
      }
    } else if (line.startsWith("+++") || line.startsWith("---")) {
      cls = "head";
      text = line.slice(4);
    } else {
      cls = "note";
    }
    return (
      <div key={i} className={`diff-line ${cls}`}>
        <span className="diff-mark">{cls === "add" ? "+" : cls === "del" ? "−" : ""}</span>
        <span className="diff-text">{text || " "}</span>
      </div>
    );
  });
  return <div className="diff-view">{rows}</div>;
}

export default function AiPanel({ onCollapse }: { onCollapse: () => void }) {
  const {
    messages, busy, busyKind, diffPending, acceptDiff, rejectDiff, applyHunk, clearMessages, suggestMode,
    toggleSuggestMode, pendingSelection, setSelection, askAi, lastEdits, rollbackEdit, restoreTimelineSnapshot,
    sessions, sessionId, newSession, switchSession, renameSession, deleteSession, activeProjectRoot, activeFile,
    settings, loadSettings,
  } = useAiStore();
  const [expandedRaw, setExpandedRaw] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menu = usePopover();
  const t = useT();
  const [input, setInput] = useState("");
  const [snapshots, setSnapshots] = useState<{ path: string; ts: string; file: string }[] | null>(null);
  const [usage, setUsage] = useState<{ prompt_tokens: number; completion_tokens: number } | null>(null);
  const focusNonce = useUiStore((s) => s.aiFocusNonce);
  const newestAppliedId = messages.filter((m) => m.applied).slice(-1)[0]?.id ?? null;
  const scopedLastEdits = lastEdits.filter((edit) => aiEditBelongsToScope(edit, sessionId, activeProjectRoot, activeFile));

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const configured = useMemo(() => {
    if (!settings) return true; // unknown yet: do not nag
    return settings.provider.kind === "ollama" || Boolean(settings.api_key?.trim());
  }, [settings]);

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

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, diffPending]);

  // "Ask AI" from the editor / palette: focus the composer
  useEffect(() => {
    if (focusNonce > 0) window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [focusNonce]);

  // auto-grow the composer up to its CSS max-height
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [input]);

  const send = (text = input) => {
    if (busy || !text.trim()) return;
    void askAi(text);
    setInput("");
  };

  const loadSnapshots = async () => {
    try {
      setSnapshots(await api.aiSnapshots());
    } catch {
      setSnapshots([]);
    }
  };

  const createGuide = async () => {
    const req = await dialog.prompt({
      title: t("ai.guide"),
      message: t("ai.guidePrompt"),
      multiline: true,
      confirmLabel: t("ai.guideGenerate"),
    });
    if (!req) return;
    try {
      toast.info(t("ai.guideGenerating"));
      const guide = await api.aiCreateGuide(req);
      const ok = await dialog.confirm({
        title: t("ai.guideGenerated"),
        message: guide.length > 4000 ? `${guide.slice(0, 4000)}\n…` : guide,
        confirmLabel: t("ai.guideWrite"),
      });
      if (!ok) return;
      await api.writeFile("AI_GUIDE.md", guide);
      toast.success(t("ai.guideSaved"));
    } catch (e) {
      toast.error(e);
    }
  };

  const suggestions = [
    { icon: ScanSearch, text: t("ai.suggest.review") },
    { icon: ListChecks, text: t("ai.suggest.structure") },
    { icon: Sparkles, text: t("ai.suggest.abstract") },
  ];

  const pick = (fn: () => void) => () => {
    menu.close();
    fn();
  };

  return (
    <div className="ai-panel">
      <header className="ai-header">
        <div className="ai-header-main">
          <span className="ai-heading">
            <Bot size={16} aria-hidden="true" />
            {t("ai.title")}
          </span>
          <select
            className="session-select"
            value={sessionId ?? ""}
            onChange={(e) => switchSession(e.target.value || null)}
            title={t("ai.sessionTitle")}
            disabled={busy}
          >
            <option value="">{t("ai.sessionScratch")}</option>
            {sessions.filter((session) => session.id === sessionId || sessionIsMeaningful(session)).map((session) => (
              <option key={session.id} value={session.id}>
                {session.name}
              </option>
            ))}
          </select>
          <button className="icon-btn" title={t("ai.sessionNew")} aria-label={t("ai.sessionNew")} onClick={newSession} disabled={busy}>
            <Plus size={16} aria-hidden="true" />
          </button>
          <div className="ai-menu-anchor" ref={menu.anchorRef}>
            <button
              ref={menu.triggerRef}
              className="icon-btn"
              title={t("ai.more")}
              aria-label={t("ai.more")}
              aria-expanded={menu.open}
              onClick={menu.toggle}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
            {menu.open && (
              <div className="ai-menu" role="menu">
                <button
                  className="ai-menu-item"
                  disabled={!sessionId || busy}
                  onClick={pick(async () => {
                    if (!sessionId) return;
                    const name = await dialog.prompt({
                      title: t("ai.sessionRename"),
                      initial: sessions.find((session) => session.id === sessionId)?.name ?? "",
                      confirmLabel: t("common.save"),
                    });
                    if (name?.trim()) renameSession(sessionId, name.trim());
                  })}
                >
                  <Pencil size={14} aria-hidden="true" />
                  <span>{t("ai.sessionRename")}</span>
                </button>
                <button
                  className="ai-menu-item danger"
                  disabled={!sessionId || busy}
                  onClick={pick(async () => {
                    if (!sessionId) return;
                    const ok = await dialog.confirm({
                      title: t("ai.sessionDelete"),
                      message: t("ai.sessionDeleteConfirm"),
                      confirmLabel: t("common.delete"),
                      danger: true,
                    });
                    if (ok) deleteSession(sessionId);
                  })}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  <span>{t("ai.sessionDelete")}</span>
                </button>
                <div className="ai-menu-separator" />
                <button className="ai-menu-item" onClick={pick(() => void loadSnapshots())}>
                  <History size={14} aria-hidden="true" />
                  <span>{t("ai.timeline")}</span>
                </button>
                <button className="ai-menu-item" title={t("ai.guideTitle")} onClick={pick(() => void createGuide())}>
                  <BookOpenText size={14} aria-hidden="true" />
                  <span>{t("ai.guide")}</span>
                </button>
                <button className="ai-menu-item" disabled={messages.length === 0} onClick={pick(clearMessages)}>
                  <Eraser size={14} aria-hidden="true" />
                  <span>{t("ai.clear")}</span>
                </button>
                <button
                  className="ai-menu-item"
                  disabled={!usage}
                  onClick={pick(async () => {
                    await api.tokenUsageReset();
                    setUsage(null);
                    void refreshUsage();
                  })}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  <span>{t("ai.usageReset")}</span>
                </button>
                <div className="ai-menu-separator" />
                <button className="ai-menu-item" onClick={pick(() => useUiStore.getState().openModal({ kind: "settings", section: "ai" }))}>
                  <Settings size={14} aria-hidden="true" />
                  <span>{t("ai.configure")}</span>
                </button>
              </div>
            )}
          </div>
          <button className="icon-btn" title={t("ai.collapse")} aria-label={t("ai.collapse")} onClick={onCollapse}>
            <PanelRightClose size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="ai-context-row">
          <span className="ai-file-badge" title={t("ai.sessionFileTitle")}>
            <FileText size={13} aria-hidden="true" />
            <span>{activeFile ? activeFile.split("/").pop() : t("ai.sessionNoFile")}</span>
          </span>
          {busy ? (
            <span className="ai-usage-compact">{busyKind === "fix" ? t("ai.busyFix") : t("ai.busyDiagnose")}</span>
          ) : usage && usage.prompt_tokens + usage.completion_tokens > 0 ? (
            <span className="ai-usage-compact" title={t("ai.usageTitle")}>
              {t("ai.usageCompact", { n: usage.prompt_tokens + usage.completion_tokens })}
            </span>
          ) : null}
          <button
            className="switch ai-suggest-toggle"
            role="switch"
            aria-checked={suggestMode}
            title={t("ai.suggestModeTitle")}
            onClick={toggleSuggestMode}
          >
            <span className="switch-track" />
            {t("ai.suggestModeShort")}
          </button>
        </div>
      </header>

      <div className="ai-body" ref={bodyRef}>
        {messages.length === 0 && (
          <div className="ai-empty">
            <Bot size={30} />
            <div className="ai-empty-title">{t("ai.emptyTitle")}</div>
            <div>{t("ai.emptyBody")}</div>
            {!configured ? (
              <div className="ai-setup">
                <span>{t("ai.notConfigured")}</span>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => useUiStore.getState().openModal({ kind: "settings", section: "ai" })}
                >
                  <Settings size={13} /> {t("ai.configure")}
                </button>
              </div>
            ) : (
              <div className="ai-suggestions">
                {suggestions.map(({ icon: Icon, text }) => (
                  <button key={text} className="ai-chip" disabled={busy || !activeFile} onClick={() => send(text)}>
                    <Icon size={14} /> {text}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`ai-msg ai-${m.role} ${m.kind === "error" ? "ai-error" : ""}`}>
            {m.role === "assistant" && !m.text && busy ? (
              <span className="ai-typing" aria-label={t("ai.busyDiagnose")}>
                <i />
                <i />
                <i />
              </span>
            ) : (
              <div className="ai-text" dangerouslySetInnerHTML={{ __html: renderText(m.text) }} />
            )}
            {m.diff && <DiffHighlight diff={m.diff} />}
            {/* collaborative edit: the AI changed a file — roll back right
                inside the message bubble. Only the newest applied message
                shows the buttons. */}
            {m.role === "assistant" && m.applied && scopedLastEdits.length > 0 && m.id === newestAppliedId && (
              <div className="ai-msg-actions">
                {scopedLastEdits.map((e) => (
                  <div key={e.file} className="ai-rollback-row">
                    {e.diff && <DiffHighlight diff={e.diff} />}
                    <button className="btn btn-sm btn-danger" title={t("ai.rollbackTitle")} onClick={() => void rollbackEdit(e.file)}>
                      <RotateCcw size={13} /> {t("ai.rollback", { file: e.file })}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {m.raw && (
              <div className="ai-raw-toggle">
                <button className="btn btn-sm btn-ghost" onClick={() => setExpandedRaw(expandedRaw === m.id ? null : m.id)}>
                  {expandedRaw === m.id ? t("ai.rawToggleHide") : t("ai.rawToggleShow")}
                </button>
                {expandedRaw === m.id && <pre className="ai-raw">{m.raw}</pre>}
              </div>
            )}
          </div>
        ))}
        {diffPending && (
          <div className="ai-diff-bar">
            <span>{diffPending.suggested ? t("ai.suggestBar", { n: diffPending.rounds }) : t("ai.diffBar", { n: diffPending.rounds })}</span>
            {!diffPending.suggested && (
              <button className="btn btn-sm btn-primary" onClick={() => void acceptDiff()}>
                {t("ai.diffApply")}
              </button>
            )}
            <button className="btn btn-sm" onClick={rejectDiff}>
              {t("ai.diffReject")}
            </button>
          </div>
        )}
        {diffPending?.suggested && diffPending.hunks && diffPending.hunks.length > 0 && (
          <div className="ai-hunks">
            {diffPending.hunks.map((h, i) => (
              <div key={i} className="ai-hunk">
                <div className="ai-hunk-head">
                  <span>
                    {h.file}:{h.line}
                  </span>
                  {h.why && <span className="ai-hunk-why">{h.why}</span>}
                </div>
                {h.old && <pre className="ai-hunk-old">{h.old}</pre>}
                {h.new && <pre className="ai-hunk-new">{h.new}</pre>}
                <button
                  className="btn btn-sm btn-primary"
                  style={{ alignSelf: "flex-start" }}
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
              <button className="icon-btn icon-btn-sm" aria-label={t("ai.timelineClose")} onClick={() => setSnapshots(null)}>
                <X size={14} />
              </button>
            </div>
            {snapshots.length === 0 && <div className="ai-hunk-why">{t("ai.timelineEmpty")}</div>}
            {snapshots.map((snap, i) => (
              <div key={i} className="ai-hunk">
                <div className="ai-hunk-head">
                  <span>{snap.file}</span>
                  <span>{new Date(Number(snap.ts) * 1000).toLocaleString()}</span>
                </div>
                <button
                  className="btn btn-sm"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() => {
                    void restoreTimelineSnapshot(snap.path).then((rel) => {
                      if (rel) void loadSnapshots();
                    });
                  }}
                >
                  <RotateCcw size={13} /> {t("ai.timelineRestore")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="ai-generate">
        {pendingSelection && (
          <div className="ai-generate-actions">
            <span className="ai-selection-chip" title={t("ai.askClearSel")}>
              {t("ai.askSelection", { n: pendingSelection.length })}
              <button className="icon-btn icon-btn-sm" aria-label={t("ai.askClearSel")} onClick={() => setSelection(null)}>
                <X size={12} />
              </button>
            </span>
          </div>
        )}
        <div className="ai-chat-row">
          <textarea
            ref={inputRef}
            className="ai-generate-input"
            placeholder={pendingSelection ? t("ai.askPlaceholderSel") : t("ai.askPlaceholder")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={2}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter inserts a newline. isComposing
              // guards the IME confirmation Enter (Chinese input methods).
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            className="icon-btn btn-primary ai-send-action"
            disabled={busy || !input.trim()}
            title={t("ai.askTitle")}
            aria-label={t("ai.askSend")}
            onClick={() => send()}
          >
            <SendHorizontal size={15} aria-hidden="true" />
          </button>
        </div>
        <span className="ai-composer-hint">{t("ai.composerHint")}</span>
      </div>
    </div>
  );
}
