// Crash-recovery drafts: editor content is debounce-persisted to
// localStorage so an unexpected process exit does not lose unsaved edits.
// On open, a draft that differs from disk is restored as a dirty tab.

const KEY = (path: string) => `tb-draft:${path}`;
const timers = new Map<string, number>();

/** Debounced draft save (default 4s after the last keystroke). */
export function saveDraft(path: string, content: string, delayMs = 4000): void {
  const prev = timers.get(path);
  if (prev !== undefined) window.clearTimeout(prev);
  const t = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY(path), content);
    } catch {
      /* storage full/unavailable — drafts are best-effort */
    }
    timers.delete(path);
  }, delayMs);
  timers.set(path, t);
}

/** Read the persisted draft for a file, or null. */
export function loadDraft(path: string): string | null {
  try {
    return localStorage.getItem(KEY(path));
  } catch {
    return null;
  }
}

/** Drop the draft (after a successful save or explicit discard). */
export function clearDraft(path: string): void {
  const prev = timers.get(path);
  if (prev !== undefined) window.clearTimeout(prev);
  timers.delete(path);
  try {
    localStorage.removeItem(KEY(path));
  } catch {
    /* ignore */
  }
}
