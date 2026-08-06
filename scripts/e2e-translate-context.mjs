// e2e: 用户场景复现——"把 Question 1 翻译成中文"（多行 replace 工具调用）+ 上下文记忆。
// 期望：AI 输出多行 old 的 replace 工具调用 → 行级序列匹配成功全部应用；
// 第二轮对话（带 history）AI 记得上一轮已改过（不再报错/不重复翻译）。
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9333;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/translate-check";
const FILE = PROJ + "/solutions.tex";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp() {
  for (let i = 0; i < 120; i++) {
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

async function main() {
  const content = [
    "\\documentclass[11pt]{article}",
    "\\usepackage[margin=2.5cm]{geometry}",
    "\\usepackage{amsmath,amssymb}",
    "\\usepackage{graphicx}",
    "",
    "\\begin{document}",
    "\\section*{Question 1 \\quad $E_p = 1000 \\pm 5$ keV, $\\theta = 30^\\circ$}",
    "",
    "\\subsection*{(a) Partial derivative method}",
    "",
    "Write $E_s = E_p/(1+kE_p)$ with",
    "\\[",
    "k = \\frac{1-\\cos 30^\\circ}{510.999}",
    "\\]",
    "\\subsection*{(b) Stepwise method}",
    "",
    "Top line: $\\mathrm{top} = E_p = 1000 \\pm 5$ keV, so",
    "$\\sigma_{\\mathrm{top}}/\\mathrm{top} = 5/1000 = 0.005$.",
    "",
    "Combine (treating the two lines as independent):",
    "\\[",
    "\\frac{\\sigma_{E_s}}{E_s} = \\sqrt{(0.005)^2 + (1.0386\\times10^{-3})^2}",
    "\\]",
    "\\end{document}",
  ].join("\n") + "\n";
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  await mkdir(PROJ, { recursive: true });
  await writeFile(FILE, content, "utf8");

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

  // round 1: translate Question 1 to Chinese (multi-line replace expected)
  const r1raw = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    const events = [];
    let full = "";
    try { full = await api.aiChatStream("把 Question 1 翻译成中文（标题、小节标题和 (b) 的说明文字），公式保留", "solutions.tex", null, []); }
    catch (e) { full = "ERR:" + e; }
    return JSON.stringify({ full, events });
  })()`));
  const r1 = r1raw;
  const appliedNote = r1.full.includes("已自动应用");
  const failedNote = r1.full.includes("未能应用");
  const after1 = await readFile(FILE, "utf8");
  const q1cn = after1.includes("问题 1");
  const a1cn = after1.includes("偏导数法");
  const b1cn = after1.includes("分步法");
  const combineCn = after1.includes("合并（将两行视为独立）") || after1.includes("合并（将分子分母视为相互独立）");
  const combineEnGone = !after1.includes("Combine (treating the two lines as independent)");
  // print the lines around the Combine/Top-line region for debugging
  const lines = after1.split("\n");
  const dbg = lines.map((l, i) => `${i + 1}: ${l}`).filter((s) => /Top line|Combine|第一行|合并|sigma_\\{top/.test(s)).join(" | ");
  console.log("DBG:", dbg);
  console.log("R1 title 问题1:", q1cn, "| (a) 偏导数法:", a1cn, "| (b) 分步法:", b1cn, "| Combine->合并:", combineCn && combineEnGone);
  console.log("R1 applied-note:", appliedNote, "| failed-note:", failedNote);
  console.log("R1 answer tail:", r1.full.slice(-700).replace(/\n/g, " "));

  // round 2: memory check — ask something that depends on round 1
  const r2 = JSON.parse(await exec(`(async () => {
    const { useAiStore } = await import('/src/store/aiStore.ts');
    await useAiStore.getState().askAi("我刚才让你翻译的是第几个问题？用一句话回答", "solutions.tex", null);
    const msgs = useAiStore.getState().messages;
    const last = msgs[msgs.length - 1];
    return JSON.stringify({ text: (last && last.text || "").slice(0, 300) });
  })()`));
  console.log("R2 answer:", r2.text.replace(/\n/g, " ").slice(0, 220));
  const remembered = /1|第一|问题 1|Question 1/.test(r2.text) && !/不知道|没有|无法|记不/.test(r2.text);

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = q1cn && a1cn && b1cn && combineCn && combineEnGone && remembered;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL");
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
