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
}

let msgId = 0;

export const useAiStore = create<AiState>((set, get) => ({
  settings: null,
  messages: [],
  busy: false,
  busyKind: null,
  diffPending: null,
  suggestMode: false,
  pendingSelection: null,
  lastEdits: [],

  setSelection(sel) {
    set({ pendingSelection: sel });
  },

  async askAi(question) {
    const q = question.trim();
    if (!q) return;
    if (get().busy) return;
    set({ busy: true, busyKind: "diagnose" });
    const st = useProjectStore.getState();
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
    return id;
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
