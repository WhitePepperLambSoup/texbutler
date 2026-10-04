// Small line diff (LCS) for the file-history view. Inputs are source files
// of at most a few thousand lines; above the cell budget a prefix/suffix
// trim plus a plain "removed then added" block keeps it linear.

export interface DiffRow {
  kind: "ctx" | "add" | "del";
  text: string;
  /** 1-based line in the OLD text (ctx/del) or NEW text (add). */
  line: number;
}

const MAX_CELLS = 4_000_000;

export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  // trim common prefix / suffix (cheap and usually most of the file)
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i++) rows.push({ kind: "ctx", text: a[i], line: i + 1 });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) {
    midA.forEach((text, i) => rows.push({ kind: "del", text, line: start + i + 1 }));
    midB.forEach((text, i) => rows.push({ kind: "add", text, line: start + i + 1 }));
  } else {
    // LCS table over the middle part
    const n = midA.length;
    const m = midB.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        rows.push({ kind: "ctx", text: midA[i], line: start + i + 1 });
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
        rows.push({ kind: "add", text: midB[j], line: start + j + 1 });
        j++;
      } else {
        rows.push({ kind: "del", text: midA[i], line: start + i + 1 });
        i++;
      }
    }
  }
  for (let i = endA; i < a.length; i++) rows.push({ kind: "ctx", text: a[i], line: i + 1 });
  return rows;
}

/** Keep `context` unchanged lines around each change; collapse the rest. */
export function foldContext(rows: DiffRow[], context = 3): (DiffRow | { kind: "fold"; count: number })[] {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind === "ctx") return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffRow | { kind: "fold"; count: number })[] = [];
  let hidden = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (hidden) out.push({ kind: "fold", count: hidden });
      hidden = 0;
      out.push(r);
    } else hidden++;
  });
  if (hidden) out.push({ kind: "fold", count: hidden });
  return out;
}
