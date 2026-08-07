// Crash-recovery drafts: editor content is debounce-persisted to
// localStorage so an unexpected process exit does not lose unsaved edits.
// On open, a draft that differs from disk is restored as a dirty tab.
// Keys are scoped by project root so drafts never leak across projects.

const KEY = (root: string, path: string) => `tb-draft:${root}|${path}`;
const timers = new Map<string, number>();

/** Debounced draft save (default 4s after the last keystroke). */
export function saveDraft(root: string, path: string, content: string, delayMs = 4000): void {
  const key = KEY(root, path);
  const prev = timers.get(key);
  if (prev !== undefined) window.clearTimeout(prev);
  const t = window.setTimeout(() => {
    try {
      localStorage.setItem(key, content);
    } catch {
      /* storage full/unavailable — drafts are best-effort */
    }
    timers.delete(key);
  }, delayMs);
  timers.set(key, t);
}

/** Read the persisted draft for a file, or null. */
export function loadDraft(root: string, path: string): string | null {
  try {
    return localStorage.getItem(KEY(root, path));
  } catch {
    return null;
  }
}

/** Drop the draft (after a successful save or explicit discard). */
export function clearDraft(root: string, path: string): void {
  const key = KEY(root, path);
  const prev = timers.get(key);
  if (prev !== undefined) window.clearTimeout(prev);
  timers.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
