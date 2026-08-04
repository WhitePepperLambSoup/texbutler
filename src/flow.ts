// UI flow preferences (auto-compile, session restore) — localStorage only.
// Not part of settings.json since these are editor-behavior preferences.

export interface FlowPrefs {
  autoCompile: boolean;
  restoreSession: boolean;
  lastProject: string;
  lastFile: string;
}

const KEY = "tb-flow";

const DEFAULTS: FlowPrefs = {
  autoCompile: false,
  restoreSession: true,
  lastProject: "",
  lastFile: "",
};

export function loadFlow(): FlowPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<FlowPrefs>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export function saveFlow(patch: Partial<FlowPrefs>) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...loadFlow(), ...patch }));
  } catch {
    /* ignore */
  }
}
