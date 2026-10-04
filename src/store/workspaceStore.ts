// Background workspace state: Git status of the project and the available
// compile engines. Refreshed on project open, after saves and after
// external file changes (debounced).

import { create } from "zustand";
import { api, onEvent, events, type EngineStatus, type GitStatus } from "../api";
import { useProjectStore } from "./projectStore";

interface WorkspaceState {
  git: GitStatus | null;
  engine: EngineStatus | null;
  refreshGit: () => Promise<void>;
  refreshEngine: () => Promise<EngineStatus | null>;
}

let gitSeq = 0;

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  git: null,
  engine: null,

  async refreshGit() {
    const seq = ++gitSeq;
    const root = useProjectStore.getState().root;
    if (!root) {
      set({ git: null });
      return;
    }
    try {
      const git = await api.gitStatus();
      if (seq === gitSeq && useProjectStore.getState().root === root) set({ git });
    } catch {
      if (seq === gitSeq) set({ git: null });
    }
  },

  async refreshEngine() {
    try {
      const engine = await api.engineStatus();
      set({ engine });
      return engine;
    } catch {
      return null;
    }
  },
}));

/** Status letter + tone for a file in the tree. */
export function gitBadge(status: GitStatus["files"][number]["status"]): { letter: string; tone: string } {
  switch (status) {
    case "untracked":
      return { letter: "U", tone: "git-untracked" };
    case "added":
      return { letter: "A", tone: "git-added" };
    case "deleted":
      return { letter: "D", tone: "git-deleted" };
    case "renamed":
      return { letter: "R", tone: "git-added" };
    case "conflict":
      return { letter: "!", tone: "git-conflict" };
    default:
      return { letter: "M", tone: "git-modified" };
  }
}

// ---- refresh triggers
let timer: number | undefined;
function scheduleGit(delay = 600) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void useWorkspaceStore.getState().refreshGit(), delay);
}

useProjectStore.subscribe((s, prev) => {
  if (s.root !== prev.root) scheduleGit(50);
});
window.addEventListener("tb:file-saved", () => scheduleGit());
void onEvent(events.fileChanged, () => scheduleGit(1000));
window.addEventListener("focus", () => scheduleGit(300));
