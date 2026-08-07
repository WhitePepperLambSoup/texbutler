// Customizable keyboard shortcuts (persisted in localStorage).
// Combo format: `ctrl+shift+k` (ctrl also matches meta on macOS).

export interface Keymap {
  compileMain: string;
  compileCurrent: string;
}

const DEFAULTS: Keymap = {
  compileMain: "ctrl+b",
  compileCurrent: "ctrl+shift+k",
};

const KEY = "tb-keymap";

/** Normalize a KeyboardEvent into a combo string. */
export function keyCombo(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("ctrl");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  const key = e.key.toLowerCase();
  if (["control", "shift", "alt", "meta"].includes(key)) return "";
  return [...mods, key].join("+");
}

export function loadKeymap(): Keymap {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Keymap>) };
  } catch {
    /* corrupted storage — defaults */
  }
  return DEFAULTS;
}

export function saveKeymap(k: Keymap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(k));
  } catch {
    /* ignore */
  }
}

/** Human-readable label for a combo, e.g. `Ctrl+Shift+K`. */
export function comboLabel(combo: string): string {
  const parts = combo.split("+");
  const map: Record<string, string> = { ctrl: "Ctrl", shift: "Shift", alt: "Alt" };
  return parts.map((p) => map[p] ?? p.toUpperCase()).join("+");
}
