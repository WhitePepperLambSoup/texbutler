// In-app feedback: non-blocking toasts and promise-based dialogs that
// replace window.alert / confirm / prompt (those block the WebView2 UI
// thread, ignore the app theme and cannot be localized).

import { create } from "zustand";

export type ToastTone = "info" | "success" | "error";

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  action?: { label: string; run: () => void };
}

export type DialogRequest =
  | {
      kind: "confirm";
      title: string;
      message?: string;
      confirmLabel?: string;
      danger?: boolean;
      resolve: (ok: boolean) => void;
    }
  | {
      kind: "prompt";
      title: string;
      message?: string;
      initial?: string;
      placeholder?: string;
      confirmLabel?: string;
      multiline?: boolean;
      resolve: (value: string | null) => void;
    }
  | {
      kind: "alert";
      title: string;
      message?: string;
      /** Monospace, scrollable body (logs, generated files). */
      preformatted?: boolean;
      resolve: () => void;
    };

interface FeedbackState {
  toasts: Toast[];
  dialogs: DialogRequest[];
  pushToast: (toast: Omit<Toast, "id">, ttlMs?: number) => number;
  dismissToast: (id: number) => void;
  pushDialog: (dialog: DialogRequest) => void;
  /** Resolve and remove the front dialog. */
  popDialog: () => void;
}

let toastSeq = 0;

export const useFeedbackStore = create<FeedbackState>((set, get) => ({
  toasts: [],
  dialogs: [],

  pushToast(toast, ttlMs) {
    const id = ++toastSeq;
    // keep the stack short: the oldest toast yields to the newest
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id }] }));
    const ttl = ttlMs ?? (toast.tone === "error" ? 7000 : toast.action ? 9000 : 3500);
    window.setTimeout(() => get().dismissToast(id), ttl);
    return id;
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  pushDialog(dialog) {
    set((s) => ({ dialogs: [...s.dialogs, dialog] }));
  },

  popDialog() {
    set((s) => ({ dialogs: s.dialogs.slice(1) }));
  },
}));

export const toast = {
  info: (text: string, action?: Toast["action"]) =>
    useFeedbackStore.getState().pushToast({ text, tone: "info", action }),
  success: (text: string, action?: Toast["action"]) =>
    useFeedbackStore.getState().pushToast({ text, tone: "success", action }),
  error: (text: unknown) =>
    useFeedbackStore.getState().pushToast({ text: errorText(text), tone: "error" }),
};

/** Tauri command errors arrive as plain strings; keep them readable. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export const dialog = {
  confirm(opts: { title: string; message?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
    return new Promise((resolve) => {
      useFeedbackStore.getState().pushDialog({ kind: "confirm", ...opts, resolve });
    });
  },
  prompt(opts: {
    title: string;
    message?: string;
    initial?: string;
    placeholder?: string;
    confirmLabel?: string;
    multiline?: boolean;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      useFeedbackStore.getState().pushDialog({ kind: "prompt", ...opts, resolve });
    });
  },
  alert(opts: { title: string; message?: string; preformatted?: boolean }): Promise<void> {
    return new Promise((resolve) => {
      useFeedbackStore.getState().pushDialog({ kind: "alert", ...opts, resolve });
    });
  },
};
