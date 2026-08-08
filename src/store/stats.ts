// Per-project statistics (compiles, word-count history) persisted in
// localStorage so trends survive restarts. Keyed by project root.

export interface WordSample {
  ts: number;
  chars: number;
  cjk: number;
  words: number;
}

export interface ProjectStats {
  compiles: number;
  words: WordSample[];
  createdAt: number;
}

const KEY = (root: string) => `tb-stats:${root}`;
const MAX_SAMPLES = 120; // ~2h of 60s saves

export function loadStats(root: string): ProjectStats | null {
  if (!root) return null;
  try {
    const raw = localStorage.getItem(KEY(root));
    if (raw) return JSON.parse(raw) as ProjectStats;
  } catch {
    /* ignore */
  }
  return null;
}

function persist(root: string, s: ProjectStats): void {
  try {
    localStorage.setItem(KEY(root), JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function recordCompile(root: string): ProjectStats {
  const s = loadStats(root) ?? { compiles: 0, words: [], createdAt: Date.now() };
  s.compiles += 1;
  persist(root, s);
  return s;
}

export function recordWords(root: string, chars: number, cjk: number, words: number): ProjectStats {
  const s = loadStats(root) ?? { compiles: 0, words: [], createdAt: Date.now() };
  s.words.push({ ts: Date.now(), chars, cjk, words });
  if (s.words.length > MAX_SAMPLES) s.words.splice(0, s.words.length - MAX_SAMPLES);
  persist(root, s);
  return s;
}
