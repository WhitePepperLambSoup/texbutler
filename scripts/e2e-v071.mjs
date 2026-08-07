// e2e: v0.7.0 batch 2 — TODO scanner, ref index w/ bib locations, CSV→
// tabular logic, academic polish (real API).
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v071-check";
const FILE = PROJ + "/main.tex";
const BIB = PROJ + "/refs.bib";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(1000);
  }
  throw new Error("CDP not reachable");
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close: () => ws.close(),
    });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      }
    };
  });
}

// mirrors TableModal.buildFromCsv row parsing
function parseCsvRow(l, sep) {
  if (sep === "\t") return l.split("\t").map((c) => c.trim().replace(/^"|"$/g, ""));
  const parts = [];
  let cur = "";
  let inQ = false;
  for (const ch of l) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

async function main() {
  const tex = [
    "\\documentclass{article}",
    "\\usepackage{amsmath}",
    "% TODO: 补充实验数据",
    "\\begin{document}",
    "\\section{引言}\\label{sec:intro}",
    "详见第 \\ref{sec:intro} 节，引用 \\cite{smith2024}。",
    "\\end{document}",
    "",
  ].join("\n");
  const bib = [
    "@article{smith2024,",
    "  title = {A Study},",
    "  author = {Smith, John},",
    "  year = {2024},",
    "}",
    "",
  ].join("\n");
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  await mkdir(PROJ, { recursive: true });
  await writeFile(FILE, tex, "utf8");
  await writeFile(BIB, bib, "utf8");

  // node-side CSV parser checks (mirror of TableModal)
  const row1 = parseCsvRow('姓名,年龄,成绩', ",");
  const row2 = parseCsvRow('"Li, Wei",25,"90,5"', ",");
  const row3 = parseCsvRow('A\tB\tC', "\t");
  const csvOk = row1.length === 3 && row2.length === 3 && row2[0] === "Li, Wei" && row2[2] === "90,5" && row3.length === 3;
  console.log("CSV quoted field:", JSON.stringify(row2), "| TSV:", JSON.stringify(row3));

  const wsUrl = await cdp();
  const c = await connect(wsUrl);
  await c.send("Runtime.enable");
  const exec = async (expr) => {
    const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("JS: " + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  await exec(`(async () => { const { useProjectStore } = await import('/src/store/projectStore.ts'); await useProjectStore.getState().openProject(${JSON.stringify(PROJ)}); return true; })()`);
  await sleep(800);

  const res = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    const todos = await api.scanTodos();
    const idx = await api.refIndex();
    let polished = null;
    try {
      polished = await api.aiPolish("这是一个非常冗长的句子，其主要目的是用于测试学术润色功能中的压缩模式是否能够正常工作并保持原意。", "compress");
    } catch (e) { polished = "ERR:" + e; }
    return JSON.stringify({ todos, labels: idx.labels, bib: idx.bib, polished });
  })()`));
  const todoHit = (res.todos || []).find((h) => h.file === "main.tex" && h.text.includes("TODO"));
  const labelHit = (res.labels || []).find((l) => l.key === "sec:intro");
  const bibHit = (res.bib || []).find((b) => b.key === "smith2024");
  console.log("TODO hit:", todoHit && `${todoHit.file}:${todoHit.line} ${todoHit.text}`);
  console.log("LABEL hit:", labelHit && `${labelHit.file}:${labelHit.line}`);
  console.log("BIB hit w/ location:", bibHit && `${bibHit.file}:${bibHit.line} ${bibHit.title}`);
  console.log("POLISH result:", (res.polished || "").slice(0, 80));

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = csvOk && !!todoHit && !!labelHit && !!bibHit && bibHit.file === "refs.bib" &&
    typeof bibHit.line === "number" && bibHit.line === 1 &&
    typeof res.polished === "string" && res.polished.length > 0 && !res.polished.startsWith("ERR");
  console.log("E2E-DONE", pass ? "PASS" : "FAIL");
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
