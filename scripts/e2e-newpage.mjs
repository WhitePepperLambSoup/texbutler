// e2e: "每个 Question 前加 \newpage" — the user's failing case.
// Expects the AI to emit declarative tool calls (insert_before) instead of
// a fragile free-form diff; verify all 7 sections get a \newpage.
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9333;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/newpage-check";
const FILE = PROJ + "/solutions.tex";
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

async function main() {
  const parts = ["\\documentclass[11pt]{article}\n\\usepackage[margin=2.5cm]{geometry}\n\\usepackage{amsmath,amssymb}\n\\usepackage{graphicx}\n\n\\title{\\textbf{PHYS3104 Solutions}}\n\\author{}\n\\date{}\n\n\\begin{document}\n\\maketitle\n\\section*{Physics model}\n模型说明文字。\n"];
  for (let q = 1; q <= 7; q++) {
    parts.push(`\n\\section*{Question ${q} \\quad $E_p = 1000 \\pm 5$ keV}\n题目内容与推导过程若干行。\n\\subsection*{(a) 方法}\n内容。\n`);
  }
  parts.push("\\end{document}\n");
  const content = parts.join("");
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
  const beforeNewpage = (before.match(/\\newpage/g) || []).length;

  const res = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    const { onEvent } = await import('/src/api/index.ts');
    const events = [];
    const un = await onEvent('tb://ai-edit', (e) => events.push(e));
    let full = "";
    try { full = await api.aiChatStream("让每个 Question 都从新的一页开始：在每个 \\\\section*{Question 前插入一行 \\\\newpage，总共 7 处", "solutions.tex", null); }
    catch (e) { full = "ERR:" + e; }
    un();
    return JSON.stringify({ full, events });
  })()`));
  const after = await readFile(FILE, "utf8");
  const afterNewpage = (after.match(/\\newpage/g) || []).length;
  const beforeQ = (before.match(/\\section\*\{Question/g) || []).length;
  const afterQ = (after.match(/\\section\*\{Question/g) || []).length;
  console.log("ANSWER head:", res.full.slice(0, 300).replace(/\n/g, " "));
  console.log("NEWPAGE:", beforeNewpage, "->", afterNewpage);
  console.log("QUESTIONS preserved:", beforeQ, "->", afterQ);
  console.log("EDIT EVENTS:", res.events.length);
  console.log("ANSWER mentions applied:", res.full.includes("已自动应用"));

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  console.log("E2E-DONE", afterNewpage >= 7 && afterQ === beforeQ ? "PASS" : "FAIL");
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
