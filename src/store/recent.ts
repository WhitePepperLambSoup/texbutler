// Recently opened projects, persisted in localStorage (most recent first,
// capped at 10). The welcome screen uses this for one-click restore.

const KEY = "tb-recent-projects";

export interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
}

export function loadRecent(): RecentProject[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as RecentProject[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p) => typeof p?.path === "string")
      .slice(0, 10);
  } catch {
    return [];
  }
}

export function recordRecent(path: string): void {
  try {
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    const next = [
      { path, name, lastOpened: Date.now() },
      ...loadRecent().filter((p) => p.path !== path),
    ].slice(0, 10);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full/unavailable — non-fatal */
  }
}

export function removeRecent(path: string): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(loadRecent().filter((p) => p.path !== path))
    );
  } catch {
    /* ignore */
  }
}
