import { create } from "zustand";
import { api, onEvent, events, type AiDiagnosis, type AiSettings, type FixReport, type Issue } from "../api";
import { useI18n } from "../i18n";
import { useProjectStore } from "./projectStore";

export interface AiMessage {
  id: number;
  role: "user" | "assistant" | "system";
  text: string;
  kind: "diagnosis" | "fix" | "plain" | "error";
  raw?: string | null;
  diff?: string | null;
  issue?: Issue | null;
  report?: FixReport | null;
  /** True when the AI applied a collaborative edit (snapshot available). */
  applied?: boolean;
}

/** A persisted AI conversation: messages + name + last-updated. */
export interface AiSession {
  id: string;
  name: string;
  messages: AiMessage[];
  updatedAt: number;
}

const SESSIONS_KEY = "tb-ai-sessions";
const FILE_SESSIONS_KEY = "tb-ai-file-sessions";

function loadSessions(): AiSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AiSession[]) : [];
  } catch {
    return [];
  }
}

function loadFileSessions(): Record<string, string | null> {
  try {
    const raw = localStorage.getItem(FILE_SESSIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string | null>) : {};
  } catch {
    return {};
  }
}

function persistFileSessions(map: Record<string, string | null>) {
  try {
    localStorage.setItem(FILE_SESSIONS_KEY, JSON.stringify(map));
  } catch {
    /* storage full / unavailable — best-effort */
  }
}

function persistSessions(sessions: AiSession[]) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    /* storage full / unavailable — sessions are best-effort */
  }
}

interface AiState {
  settings: AiSettings | null;
  messages: AiMessage[];
  busy: boolean;
  busyKind: "diagnose" | "fix" | "test" | null;
  diffPending: FixReport | null; // awaiting accept/reject
  /** Suggest mode: AI proposals are NOT written; the user applies hunks manually. */
  suggestMode: boolean;
  /** Editor selection handed to the AI panel for "ask about this selection". */
  pendingSelection: string | null;
  /** Last collaborative edit applied by the AI (snapshot path for rollback). */
  lastEdits: { file: string; backup: string; diff?: string }[];
  /** Persisted conversations (localStorage). */
  sessions: AiSession[];
  /** Id of the active conversation; null = unsaved scratch chat. */
  sessionId: string | null;
  /** Per-file conversation bindings (rel path → session id). */
  fileSessions: Record<string, string | null>;
  /** The editor file currently bound to the AI panel. */
  activeFile: string | null;

  loadSettings: () => Promise<void>;
  diagnoseIssue: (issue: Issue, index: number) => Promise<void>;
  fixIssue: (issue: Issue, index: number) => Promise<void>;
  acceptDiff: () => Promise<void>;
  rejectDiff: () => void;
  applyHunk: (file: string, patch: string) => Promise<void>;
  toggleSuggestMode: () => void;
  setSelection: (sel: string | null) => void;
  askAi: (question: string) => Promise<void>;
  rollbackEdit: (file?: string) => Promise<void>;
  testConnection: () => Promise<string>;
  saveSettings: (s: AiSettings) => Promise<void>;
  pushMessage: (m: Omit<AiMessage, "id">) => number;
  clearMessages: () => void;
  /** Start a fresh named conversation (the old one stays persisted). */
  newSession: () => void;
  switchSession: (id: string | null) => void;
  attachFile: (file: string | null) => void;
  recordFileBinding: () => void;
  renameSession: (id: string, name: string) => void;
  deleteSession: (id: string) => void;
}

let msgId = 0;
// align the id counter with persisted messages so ids never collide after
// a restart (React keys + streamed-update lookups would double-match)
try {
  const raw = localStorage.getItem(SESSIONS_KEY);
  if (raw) {
    const sessions = JSON.parse(raw) as AiSession[];
    for (const s of sessions) {
      for (const m of s.messages) msgId = Math.max(msgId, m.id);
    }
  }
} catch {
  /* corrupted storage — start from 0 */
}

export const useAiStore = create<AiState>((set, get) => ({
  settings: null,
  messages: [],
  busy: false,
  busyKind: null,
  diffPending: null,
  suggestMode: false,
  pendingSelection: null,
  lastEdits: [],
  sessions: loadSessions(),
  sessionId: null,
  fileSessions: loadFileSessions(),
  activeFile: null,

  setSelection(sel) {
    set({ pendingSelection: sel });
  },

  async askAi(question) {
    const q = question.trim();
    if (!q) return;
    if (get().busy) return;
    set({ busy: true, busyKind: "diagnose" });
    const st = useProjectStore.getState();
    get().recordFileBinding();
    get().pushMessage({ role: "user", kind: "plain", text: q });
    // streaming answer: collect tb://ai-stream deltas into a live message
    let streamed = "";
    const msgId = get().pushMessage({ role: "assistant", kind: "plain", text: "" });
    const listenP = onEvent<{ delta?: string; done?: boolean; error?: string }>("tb://ai-stream", (payload) => {
      if (typeof payload.delta === "string") {
        streamed += payload.delta;
        useAiStore.setState((s) => ({
          messages: s.messages.map((m) =>
            m.id === msgId ? { ...m, text: streamed } : m,
          ),
        }));
      }
    });
    // collaborative edit: AI applied a diff to the project; remember the
    // snapshot so the user can roll it back after compiling (one entry per
    // file — a batch edit keeps every file independently rollback-able)
    let editedThisRound = false;
    const listenEditP = onEvent<{ file?: string; backup?: string; diff?: string }>("tb://ai-edit", (payload) => {
      if (payload.file && payload.backup) {
        editedThisRound = true;
        const { file, backup, diff } = payload as { file: string; backup: string; diff?: string };
        useAiStore.setState((s) => {
          const rest = s.lastEdits.filter((e) => e.file !== file);
          return { lastEdits: [...rest, { file, backup, diff }] };
        });
        // the file changed on disk — sync the open editor tab(s) so the
        // user immediately sees the AI's edits. If the user is mid-typing
        // in that same file (dirty), keep their unsaved edits — an AI edit
        // must never silently discard what the user is writing.
        const tab = useProjectStore.getState().tabs.find((t) => t.path === file);
        if (tab && !tab.dirty) {
          void useProjectStore.getState().reloadTab(file);
        }
        void useCompileStoreRefresh();
      }
    });
    // WAIT for the listeners to be registered before firing the request —
    // `tb://ai-edit` can arrive within milliseconds of the first tool call,
    // and a lost event would leave the disk edited with no editor refresh
    // and no rollback entry. If registering fails, degrade to sending the
    // request anyway (a missed event is better than no answer at all).
    let unListen: (() => void) | undefined;
    let unListenEdit: (() => void) | undefined;
    try {
      ([unListen, unListenEdit] = await Promise.all([listenP, listenEditP]));
      // conversation history: send the recent user/assistant turns so the
      // AI remembers what it did earlier (capped for context budget)
      const history = get().messages.slice(-12)
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.kind === "plain")
        .map((m) => ({ role: m.role, content: (m.text || "").slice(0, 3000) }));
      const answer = await api.aiChatStream(q, st.activeTab, get().pendingSelection, history);
      // finalize the live message with the complete answer; mark it as
      // applied only when the AI edited files THIS round (a leftover
      // lastEdit from a previous round must not flag a plain chat reply)
      useAiStore.setState((s) => ({
        messages: s.messages.map((m) =>
          m.id === msgId ? { ...m, text: answer, applied: editedThisRound } : m,
        ),
      }));
      // persist the finalized streamed answer into the active session
      const { sessions, sessionId } = useAiStore.getState();
      if (sessionId) {
        const next = sessions.map((s) =>
          s.id === sessionId
            ? { ...s, messages: useAiStore.getState().messages, updatedAt: Date.now() }
            : s,
        );
        useAiStore.setState({ sessions: next });
        persistSessions(next);
      }
    } catch (e) {
      get().pushMessage({ role: "assistant", kind: "error", text: useI18n.getState().t("ai.chatFailed", { e: String(e) }) });
    } finally {
      unListen?.();
      unListenEdit?.();
      // also unregister through the original promises: if Promise.all
      // failed after one listener registered, the destructured handle is
      // undefined and this path is the only cleanup (unlisten is idempotent)
      void listenP.then((fn) => fn?.()).catch(() => {});
      void listenEditP.then((fn) => fn?.()).catch(() => {});
    }
    set({ busy: false, busyKind: null });
  },

  async rollbackEdit(file?: string) {
    const edits = get().lastEdits;
    const edit = file ? edits.find((e) => e.file === file) : edits[edits.length - 1];
    if (!edit) return;
    set({ busy: true, busyKind: "fix" });
    try {
      await api.aiRollback(edit.backup);
      useProjectStore.getState().reloadTab(edit.file);
      useAiStore.setState((s) => ({ lastEdits: s.lastEdits.filter((e) => e.file !== edit.file) }));
      // refresh the rule-issue list so it no longer shows stale entries
      await useCompileStoreRefresh();
      get().pushMessage({ role: "assistant", kind: "plain", text: useI18n.getState().t("ai.editRolledBack", { file: edit.file }) });
    } catch (e) {
      get().pushMessage({ role: "assistant", kind: "error", text: useI18n.getState().t("ai.chatFailed", { e: String(e) }) });
    } finally {
      set({ busy: false, busyKind: null });
    }
  },

  toggleSuggestMode() {
    set({ suggestMode: !get().suggestMode });
  },

  async applyHunk(file, patch) {
    try {
      await api.aiApplyPatch(file, patch);
      get().pushMessage({
        role: "system",
        kind: "plain",
        text: useI18n.getState().t("ai.hunkApplied", { file }),
      });
      const active = useProjectStore.getState().activeTab;
      if (active) await useProjectStore.getState().reloadTab(active);
      await useCompileStoreRefresh();
    } catch (e) {
      get().pushMessage({
        role: "assistant",
        kind: "error",
        text: useI18n.getState().t("ai.hunkFailed", { e: String(e) }),
      });
    }
  },

  async loadSettings() {
    try {
      const s = await api.aiGetSettings();
      set({ settings: s });
    } catch (e) {
      console.error("load settings failed", e);
    }
  },

  pushMessage(m) {
    const id = ++msgId;
    set({ messages: [...get().messages, { ...m, id }] });
    // bind the conversation to the active file (fix/diagnose chat too)
    get().recordFileBinding();
    // persist the active conversation (best-effort; streamed text updates
    // are persisted on finalize, not per delta)
    const { sessions, sessionId } = get();
    if (sessionId) {
      const next = sessions.map((s) =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, { ...m, id }], updatedAt: Date.now() }
          : s,
      );
      set({ sessions: next });
      persistSessions(next);
    }
    return id;
  },

  newSession() {
    const id = `s${Date.now().toString(36)}`;
    const session: AiSession = { id, name: useI18n.getState().t("ai.sessionNew"), messages: [], updatedAt: Date.now() };
    const next = [session, ...get().sessions];
    set({ sessions: next, sessionId: id, messages: [], diffPending: null });
    persistSessions(next);
  },

  switchSession(id) {
    const s = get().sessions.find((x) => x.id === id);
    set({
      sessionId: id,
      messages: s ? [...s.messages] : [],
      diffPending: null,
    });
  },

  /** Per-file conversations: switching the active editor tab auto-switches
   *  the AI conversation to the one bound to that file. The binding is
   *  remembered on every message sent while the file is active. */
  attachFile(file: string | null) {
    const { fileSessions, sessionId, activeFile } = get();
    if (activeFile !== file) {
      // remember the outgoing binding, then restore the incoming one
      const next = { ...fileSessions };
      if (activeFile != null && sessionId != null) {
        next[activeFile] = sessionId;
      }
      const bound = file != null ? next[file] ?? null : null;
      set({ fileSessions: next, activeFile: file });
      persistFileSessions(next);
      if (file != null && bound != null) {
        get().switchSession(bound);
      }
    }
  },

  /** Called when a message is sent: bind the active conversation to the
   *  active file so switching back restores it. */
  recordFileBinding() {
    const { fileSessions, sessionId, activeFile } = get();
    if (activeFile == null || sessionId == null) return;
    const next = { ...fileSessions, [activeFile]: sessionId };
    set({ fileSessions: next });
    persistFileSessions(next);
  },

  renameSession(id, name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = get().sessions.map((s) => (s.id === id ? { ...s, name: trimmed } : s));
    set({ sessions: next });
    persistSessions(next);
  },

  deleteSession(id) {
    const next = get().sessions.filter((s) => s.id !== id);
    const isCurrent = get().sessionId === id;
    set({
      sessions: next,
      sessionId: isCurrent ? null : get().sessionId,
      messages: isCurrent ? [] : get().messages,
      diffPending: isCurrent ? null : get().diffPending,
    });
    persistSessions(next);
  },

  async diagnoseIssue(issue, index) {
    if (get().busy) return;
    set({ busy: true, busyKind: "diagnose" });
    const t = useI18n.getState().t;
    get().pushMessage({
      role: "user",
      kind: "plain",
      text: t("ai.explainReq", { msg: issue.message, loc: `${issue.file ?? "?"}:${issue.line ?? "?"}` }),
      issue,
    });
    try {
      const d: AiDiagnosis = await api.aiDiagnose(index);
      if (d.ok) {
        get().pushMessage({
          role: "assistant",
          kind: "diagnosis",
          text: `**${d.explanation}**\n\n修复建议：${d.suggestion || "（AI 未给出具体建议）"}\n\n置信度：${d.confidence}`,
          raw: d.raw,
        });
      } else {
        get().pushMessage({ role: "assistant", kind: "error", text: useI18n.getState().t("ai.diagFailed", { e: d.error ?? "未知错误" }) });
      }
    } catch (e) {
      get().pushMessage({ role: "assistant", kind: "error", text: useI18n.getState().t("ai.diagFailed", { e: String(e) }) });
    }
    set({ busy: false, busyKind: null });
  },

  async fixIssue(issue, index) {
    if (get().busy) return;
    set({ busy: true, busyKind: "fix" });
    const t = useI18n.getState().t;
    get().pushMessage({
      role: "user",
      kind: "plain",
      text: t("ai.oneKeyFix", { msg: issue.message, loc: `${issue.file ?? "?"}:${issue.line ?? "?"}` }),
      issue,
    });
    try {
      const report: FixReport = await api.aiFix(index, 3, !get().suggestMode);
      if (report.diff) {
        set({ diffPending: report });
        get().pushMessage({
          role: "assistant",
          kind: "fix",
          text: useI18n.getState().t(
            report.suggested ? "ai.suggestGenerated" : "ai.diffGenerated",
            { n: report.rounds },
          ),
          diff: report.diff,
          report,
        });
      } else {
        get().pushMessage({
          role: "assistant",
          kind: "error",
          text: report.summary,
          report,
        });
      }
    } catch (e) {
      get().pushMessage({ role: "assistant", kind: "error", text: useI18n.getState().t("ai.fixFailedMsg", { e: String(e) }) });
    }
    set({ busy: false, busyKind: null });
  },

  async acceptDiff() {
    const { diffPending } = get();
    if (!diffPending) return;
    get().pushMessage({
      role: "assistant",
      kind: diffPending.ok ? "fix" : "error",
      text: diffPending.ok
        ? useI18n.getState().t("ai.fixApplied", { n: diffPending.rounds, summary: diffPending.summary })
        : useI18n.getState().t("ai.fixFailed", { summary: diffPending.summary }),
      report: diffPending,
    });
    set({ diffPending: null });
    // Sync the editor with the fixed file on disk (the fix loop wrote it).
    const active = useProjectStore.getState().activeTab;
    if (active) await useProjectStore.getState().reloadTab(active);
    await useCompileStoreRefresh();
  },

  async rejectDiff() {
    const { diffPending } = get();
    if (!diffPending) return;
    const backup = diffPending.backup;
    set({ diffPending: null });
    if (backup) {
      // Real rollback: restore the pre-fix snapshot, then reload the editor.
      try {
        const rel = await api.aiRollback(backup);
        const active = useProjectStore.getState().activeTab;
        if (active) await useProjectStore.getState().reloadTab(active);
        get().pushMessage({
          role: "system",
          kind: "plain",
          text: useI18n.getState().t("ai.rolledBack", { file: rel }),
        });
      } catch (e) {
        get().pushMessage({
          role: "assistant",
          kind: "error",
          text: useI18n.getState().t("ai.rollbackFailed", { e: String(e) }),
        });
      }
    } else {
      // Nothing was written (fix failed / rolled back server-side already).
      get().pushMessage({ role: "system", kind: "plain", text: useI18n.getState().t("ai.rejected") });
    }
  },

  async testConnection() {
    try {
      return await api.aiTestConnection();
    } catch (e) {
      return useI18n.getState().t("settings.connFailed", { e: String(e) });
    }
  },

  async saveSettings(s) {
    const prev = get().settings;
    const apiKey =
      s.api_key === "••••••••" || (s.api_key == null && prev?.api_key)
        ? "••••••••"
        : s.api_key;
    await api.aiSetSettings({
      provider: s.provider,
      model: s.model,
      apiKey,
      temperature: s.temperature,
      maxTokens: s.max_tokens,
      timeoutSecs: s.timeout_secs,
      disableThinking: s.disable_thinking,
    });
    set({ settings: { ...s, api_key: apiKey } });
  },

  clearMessages() {
    set({ messages: [], diffPending: null });
  },
}));

async function useCompileStoreRefresh() {
  const { useCompileStore } = await import("./compileStore");
  await useCompileStore.getState().refreshDiagnostics();
}

onEvent(events.aiStatus, (p: { kind?: string; status?: string; ok?: boolean }) => {
  useAiStore.setState({
    busy: p.status === "start",
    busyKind: (p.kind as "diagnose" | "fix") ?? null,
  });
});
