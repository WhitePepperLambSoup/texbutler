// e2e: 发布核心场景——AI 把英文文档翻译成中文：
// 1) 翻译正文（标题/段落）成功且不破坏数学公式/命令/转义
// 2) 文档无中文宏包时 AI 自动加 \usepackage{ctex}
// 3) 修改后自动编译验证（真实编译）
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9333;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/agent-check";
const FILE = PROJ + "/main.tex";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp() {
  for (let i = 0; i < 150; i++) {
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
    "\\title{Compton Scattering Solutions}",
    "\\author{}",
    "\\date{}",
    "",
    "\\begin{document}",
    "\\maketitle",
    "\\section*{Question 1 \\quad $E_p = 1000 \\pm 5$ keV}",
    "",
    "Write $E_s = E_p/(1+kE_p)$ with",
    "\\[",
    "k = \\frac{1-\\cos 30^\\circ}{510.999} = 2.621817\\times 10^{-4}\\ \\mathrm{keV}^{-1}.",
    "\\]",
    "The uncertainty in the angle is the main source of error here.",
    "",
    "\\section*{Question 2}",
    "Both methods recover a primary gamma-ray energy of about 662 keV.",
    "",
    "\\end{document}",
    "",
  ].join("\n");
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

  const before = await readFile(FILE, "utf8");
  const res = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    let full = "";
    try { full = await api.aiChatStream("把整篇文档翻译成中文（标题、正文都翻译，公式保留）", "main.tex", null, []); }
    catch (e) { full = "ERR:" + e; }
    return JSON.stringify({ full });
  })()`));
  const after = await readFile(FILE, "utf8");

  const zhTitle = after.includes("\\title{康普顿散射解答}") || /\\title\{[^}]*康普顿/.test(after);
  const zhBody = after.includes("主要来源") || after.includes("误差的主要来源") || after.includes("角度的不确定度");
  const mathIntact = after.includes("\\frac{1-\\cos 30^\\circ}{510.999} = 2.621817\\times 10^{-4}\\ \\mathrm{keV}^{-1}.");
  const ctexAdded = after.includes("\\usepackage{ctex}");
  const compileNote = res.full.includes("自动编译验证通过") || res.full.includes("自动编译验证未通过") || res.full.includes("自动修复");
  const noFailed = !res.full.includes("未能应用");

  console.log("ZH title:", zhTitle, "| body:", zhBody);
  console.log("math intact:", mathIntact);
  console.log("ctex added:", ctexAdded);
  console.log("compile-verify note:", compileNote);
  console.log("no failed calls:", noFailed);
  console.log("answer tail:", res.full.slice(-350).replace(/\n/g, " "));
  const hasZh = /[\u4e00-\u9fff]/.test(after);
  const pass = zhBody && mathIntact && hasZh && noFailed && compileNote && ctexAdded;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL");
  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
