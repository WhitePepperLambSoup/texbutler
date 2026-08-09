import { create } from "zustand";
import { api, onEvent, events, type AiDiagnosis, type AiSettings, type FixReport, type Issue } from "../api";
import { useI18n } from "../i18n";
import { useProjectStore } from "./projectStore";
import {
  bindingKey,
  defaultSessionName,
  loadScopedBindings,
  persistScopedBindings,
} from "./aiSessionBindings";

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

function persistSessions(sessions: AiSession[]) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    /* storage full / unavailable — sessions are best-effort */
  }
}

function createSessionId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
  /** Per-project/file conversation bindings (scoped key → session id). */
  fileSessions: Record<string, string>;
  /** The project root associated with activeFile. */
  activeProjectRoot: string;
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
  attachFile: (projectRoot: string, file: string | null) => void;
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

interface AiRequestContext {
  sessionId: string | null;
  projectRoot: string;
  file: string | null;
}

function captureRequestContext(): AiRequestContext {
  const state = useAiStore.getState();
  return {
    sessionId: state.sessionId,
    projectRoot: state.activeProjectRoot,
    file: state.activeFile,
  };
}

function requestContextIsActive(state: AiState, context: AiRequestContext): boolean {
  return state.sessionId === context.sessionId
    && state.activeProjectRoot === context.projectRoot
    && state.activeFile === context.file;
}

function messagesForRequestContext(context: AiRequestContext): AiMessage[] {
  const state = useAiStore.getState();
  if (context.sessionId) {
    return state.sessions.find((session) => session.id === context.sessionId)?.messages ?? [];
  }
  return requestContextIsActive(state, context) ? state.messages : [];
}

function appendMessageToRequest(
  context: AiRequestContext,
  message: Omit<AiMessage, "id">,
): number | null {
  const state = useAiStore.getState();
  if (context.sessionId) {
    const target = state.sessions.find((session) => session.id === context.sessionId);
    if (!target) return null;
    const id = ++msgId;
    const messages = [...target.messages, { ...message, id }];
    const sessions = state.sessions.map((session) => session.id === context.sessionId
      ? { ...session, messages, updatedAt: Date.now() }
      : session);
    useAiStore.setState({
      sessions,
      ...(requestContextIsActive(state, context) ? { messages: [...messages] } : {}),
    });
    persistSessions(sessions);
    return id;
  }
  if (!requestContextIsActive(state, context)) return null;
  const id = ++msgId;
  useAiStore.setState({ messages: [...state.messages, { ...message, id }] });
  return id;
}

function updateRequestMessage(
  context: AiRequestContext,
  messageId: number,
  update: (message: AiMessage) => AiMessage,
  persist: boolean,
): void {
  const state = useAiStore.getState();
  if (context.sessionId) {
    const target = state.sessions.find((session) => session.id === context.sessionId);
    if (!target) return;
    const messages = target.messages.map((message) => message.id === messageId ? update(message) : message);
    const sessions = state.sessions.map((session) => session.id === context.sessionId
      ? { ...session, messages, updatedAt: Date.now() }
      : session);
    useAiStore.setState({
      sessions,
      ...(requestContextIsActive(state, context) ? { messages: [...messages] } : {}),
    });
    if (persist) persistSessions(sessions);
    return;
  }
  if (!requestContextIsActive(state, context)) return;
  useAiStore.setState({
    messages: state.messages.map((message) => message.id === messageId ? update(message) : message),
  });
}

function setRequestDiffPending(context: AiRequestContext, report: FixReport | null): void {
  if (requestContextIsActive(useAiStore.getState(), context)) {
    useAiStore.setState({ diffPending: report });
  }
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
  fileSessions: loadScopedBindings(),
  activeProjectRoot: "",
  activeFile: null,

  setSelection(sel) {
    set({ pendingSelection: sel });
  },

  async askAi(question) {
    const q = question.trim();
    if (!q) return;
    if (get().busy) return;
    const context = captureRequestContext();
    set({ busy: true, busyKind: "diagnose" });
    const st = useProjectStore.getState();
    get().recordFileBinding();
    appendMessageToRequest(context, { role: "user", kind: "plain", text: q });
    const requestSelection = get().pendingSelection;
    const history = messagesForRequestContext(context).slice(-12)
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.kind === "plain")
      .map((m) => ({ role: m.role, content: (m.text || "").slice(0, 3000) }));
    // streaming answer: collect tb://ai-stream deltas into a live message
    let streamed = "";
    const answerMessageId = appendMessageToRequest(context, { role: "assistant", kind: "plain", text: "" });
    const listenP = onEvent<{ delta?: string; done?: boolean; error?: string }>("tb://ai-stream", (payload) => {
      if (typeof payload.delta === "string") {
        streamed += payload.delta;
        if (answerMessageId != null) {
          updateRequestMessage(context, answerMessageId, (message) => ({ ...message, text: streamed }), false);
        }
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
      const answer = await api.aiChatStream(q, st.activeTab, requestSelection, history);
      // finalize the live message with the complete answer; mark it as
      // applied only when the AI edited files THIS round (a leftover
      // lastEdit from a previous round must not flag a plain chat reply)
      if (answerMessageId != null) {
        updateRequestMessage(
          context,
          answerMessageId,
          (message) => ({ ...message, text: answer, applied: editedThisRound }),
          true,
        );
      }
    } catch (e) {
      const errorText = useI18n.getState().t("ai.chatFailed", { e: String(e) });
      if (answerMessageId != null) {
        updateRequestMessage(context, answerMessageId, (message) => ({ ...message, kind: "error", text: errorText }), true);
      }
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
    const context = captureRequestContext();
    set({ busy: true, busyKind: "fix" });
    try {
      await api.aiRollback(edit.backup);
      useProjectStore.getState().reloadTab(edit.file);
      useAiStore.setState((s) => ({ lastEdits: s.lastEdits.filter((e) => e.file !== edit.file) }));
      // refresh the rule-issue list so it no longer shows stale entries
      await useCompileStoreRefresh();
      appendMessageToRequest(context, { role: "assistant", kind: "plain", text: useI18n.getState().t("ai.editRolledBack", { file: edit.file }) });
    } catch (e) {
      appendMessageToRequest(context, { role: "assistant", kind: "error", text: useI18n.getState().t("ai.chatFailed", { e: String(e) }) });
    } finally {
      set({ busy: false, busyKind: null });
    }
  },

  toggleSuggestMode() {
    set({ suggestMode: !get().suggestMode });
  },

  async applyHunk(file, patch) {
    const context = captureRequestContext();
    try {
      await api.aiApplyPatch(file, patch);
      appendMessageToRequest(context, {
        role: "system",
        kind: "plain",
        text: useI18n.getState().t("ai.hunkApplied", { file }),
      });
      await useProjectStore.getState().reloadTab(file);
      await useCompileStoreRefresh();
    } catch (e) {
      appendMessageToRequest(context, {
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
    const id = createSessionId();
    const session: AiSession = { id, name: useI18n.getState().t("ai.sessionNew"), messages: [], updatedAt: Date.now() };
    const state = get();
    const sessions = [session, ...state.sessions];
    const scoped = Boolean(state.activeProjectRoot && state.activeFile && /\.tex$/i.test(state.activeFile));
    const fileSessions = scoped
      ? { ...state.fileSessions, [bindingKey(state.activeProjectRoot, state.activeFile!)]: id }
      : state.fileSessions;
    set({ sessions, fileSessions, sessionId: id, messages: [], diffPending: null });
    persistSessions(sessions);
    if (scoped) persistScopedBindings(fileSessions);
  },

  switchSession(id) {
    const state = get();
    const session = state.sessions.find((candidate) => candidate.id === id);
    const selectedId = session?.id ?? null;
    const fileSessions = { ...state.fileSessions };
    const scoped = Boolean(state.activeProjectRoot && state.activeFile && /\.tex$/i.test(state.activeFile));
    if (scoped) {
      const key = bindingKey(state.activeProjectRoot, state.activeFile!);
      if (selectedId) fileSessions[key] = selectedId;
      else delete fileSessions[key];
    }
    set({
      sessionId: selectedId,
      messages: session ? [...session.messages] : [],
      diffPending: null,
      fileSessions,
    });
    if (scoped) persistScopedBindings(fileSessions);
  },

  /** Per-file conversations: switching the active editor tab auto-switches
   *  the AI conversation to the one bound to that file. The binding is
   *  remembered on every message sent while the file is active. */
  attachFile(projectRoot, file) {
    const scoped = Boolean(projectRoot && file && /\.tex$/i.test(file));
    if (!scoped) {
      set({
        activeProjectRoot: projectRoot,
        activeFile: file,
        sessionId: null,
        messages: [],
        diffPending: null,
      });
      return;
    }
    const key = bindingKey(projectRoot, file!);
    const state = get();
    const boundId = state.fileSessions[key];
    const bound = state.sessions.find((session) => session.id === boundId);
    if (bound) {
      set({
        activeProjectRoot: projectRoot,
        activeFile: file,
        sessionId: bound.id,
        messages: [...bound.messages],
        diffPending: null,
      });
      return;
    }
    const session: AiSession = {
      id: createSessionId(),
      name: defaultSessionName(file!),
      messages: [],
      updatedAt: Date.now(),
    };
    const sessions = [session, ...state.sessions];
    const fileSessions = { ...state.fileSessions, [key]: session.id };
    set({
      activeProjectRoot: projectRoot,
      activeFile: file,
      sessions,
      fileSessions,
      sessionId: session.id,
      messages: [],
      diffPending: null,
    });
    persistSessions(sessions);
    persistScopedBindings(fileSessions);
  },

  /** Called when a message is sent: bind the active conversation to the
   *  active file so switching back restores it. */
  recordFileBinding() {
    const { activeProjectRoot, activeFile, fileSessions, sessionId } = get();
    if (!activeProjectRoot || !activeFile || !/\.tex$/i.test(activeFile) || sessionId == null) return;
    const next = { ...fileSessions, [bindingKey(activeProjectRoot, activeFile)]: sessionId };
    set({ fileSessions: next });
    persistScopedBindings(next);
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
    // drop every file binding that pointed at the deleted session so
    // switching back to that file cannot resurrect a dead session id
    const fs = { ...get().fileSessions };
    let changed = false;
    for (const [f, sid] of Object.entries(fs)) {
      if (sid === id) {
        delete fs[f];
        changed = true;
      }
    }
    set({
      sessions: next,
      sessionId: isCurrent ? null : get().sessionId,
      messages: isCurrent ? [] : get().messages,
      diffPending: isCurrent ? null : get().diffPending,
      fileSessions: fs,
    });
    persistSessions(next);
    if (changed) persistScopedBindings(fs);
  },

  async diagnoseIssue(issue, index) {
    if (get().busy) return;
    const context = captureRequestContext();
    set({ busy: true, busyKind: "diagnose" });
    const t = useI18n.getState().t;
    appendMessageToRequest(context, {
      role: "user",
      kind: "plain",
      text: t("ai.explainReq", { msg: issue.message, loc: `${issue.file ?? "?"}:${issue.line ?? "?"}` }),
      issue,
    });
    try {
      const d: AiDiagnosis = await api.aiDiagnose(index);
      if (d.ok) {
        appendMessageToRequest(context, {
          role: "assistant",
          kind: "diagnosis",
          text: `**${d.explanation}**\n\n修复建议：${d.suggestion || "（AI 未给出具体建议）"}\n\n置信度：${d.confidence}`,
          raw: d.raw,
        });
      } else {
        appendMessageToRequest(context, { role: "assistant", kind: "error", text: useI18n.getState().t("ai.diagFailed", { e: d.error ?? "未知错误" }) });
      }
    } catch (e) {
      appendMessageToRequest(context, { role: "assistant", kind: "error", text: useI18n.getState().t("ai.diagFailed", { e: String(e) }) });
    }
    set({ busy: false, busyKind: null });
  },

  async fixIssue(issue, index) {
    if (get().busy) return;
    const context = captureRequestContext();
    set({ busy: true, busyKind: "fix" });
    const t = useI18n.getState().t;
    appendMessageToRequest(context, {
      role: "user",
      kind: "plain",
      text: t("ai.oneKeyFix", { msg: issue.message, loc: `${issue.file ?? "?"}:${issue.line ?? "?"}` }),
      issue,
    });
    try {
      const report: FixReport = await api.aiFix(index, 3, !get().suggestMode);
      if (report.diff) {
        setRequestDiffPending(context, report);
        appendMessageToRequest(context, {
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
        appendMessageToRequest(context, {
          role: "assistant",
          kind: "error",
          text: report.summary,
          report,
        });
      }
    } catch (e) {
      appendMessageToRequest(context, { role: "assistant", kind: "error", text: useI18n.getState().t("ai.fixFailedMsg", { e: String(e) }) });
    }
    set({ busy: false, busyKind: null });
  },

  async acceptDiff() {
    const { diffPending } = get();
    if (!diffPending) return;
    const context = captureRequestContext();
    appendMessageToRequest(context, {
      role: "assistant",
      kind: diffPending.ok ? "fix" : "error",
      text: diffPending.ok
        ? useI18n.getState().t("ai.fixApplied", { n: diffPending.rounds, summary: diffPending.summary })
        : useI18n.getState().t("ai.fixFailed", { summary: diffPending.summary }),
      report: diffPending,
    });
    setRequestDiffPending(context, null);
    // Sync the editor with the fixed file on disk (the fix loop wrote it).
    if (context.file) await useProjectStore.getState().reloadTab(context.file);
    await useCompileStoreRefresh();
  },

  async rejectDiff() {
    const { diffPending } = get();
    if (!diffPending) return;
    const context = captureRequestContext();
    const backup = diffPending.backup;
    setRequestDiffPending(context, null);
    if (backup) {
      // Real rollback: restore the pre-fix snapshot, then reload the editor.
      try {
        const rel = await api.aiRollback(backup);
        await useProjectStore.getState().reloadTab(rel);
        appendMessageToRequest(context, {
          role: "system",
          kind: "plain",
          text: useI18n.getState().t("ai.rolledBack", { file: rel }),
        });
      } catch (e) {
        appendMessageToRequest(context, {
          role: "assistant",
          kind: "error",
          text: useI18n.getState().t("ai.rollbackFailed", { e: String(e) }),
        });
      }
    } else {
      // Nothing was written (fix failed / rolled back server-side already).
      appendMessageToRequest(context, { role: "system", kind: "plain", text: useI18n.getState().t("ai.rejected") });
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
    const { sessions, sessionId } = get();
    if (!sessionId) {
      set({ messages: [], diffPending: null });
      return;
    }
    const next = sessions.map((session) => (
      session.id === sessionId
        ? { ...session, messages: [], updatedAt: Date.now() }
        : session
    ));
    set({ sessions: next, messages: [], diffPending: null });
    persistSessions(next);
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
