// e2e: v0.7.0 UX fixes — Enter-to-send, paragraph-gluing consolidation,
// formula-hover regex, liquid-glass left blob removal.
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v070-check";
const FILE = PROJ + "/main.tex";
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

// --- formula-hover regex verification (mirrors findMathAt in Editor.tsx) ---
function findMathAt(line, col) {
  const patterns = [
    { re: /\$\$([^$]+)\$\$/g, display: true },
    { re: /\$([^$]+)\$/g, display: false },
    { re: /\\\[([\s\S]+?)\\\]/g, display: true },
    { re: /\\\(([\s\S]+?)\\\)/g, display: false },
  ];
  for (const { re, display } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (col >= start && col <= end) return { src: m[1], start, end, display };
    }
  }
  return null;
}

async function main() {
  // 12 glued prose lines + one formula line (positioned so the hover
  // regex sees $E_p = mc^2$ inside a longer line)
  const lines = [];
  for (let i = 1; i <= 12; i++) lines.push(`第 ${i} 句正文内容需要足够长以触发粘连检测。`);
  const content = [
    "\\documentclass{article}",
    "\\usepackage{amsmath}",
    "\\begin{document}",
    ...lines,
    "能量公式 $E_p = mc^2$ 与动量公式 $$p = mv$$ 在同一行。",
    "\\end{document}",
    "",
  ].join("\n");
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  await mkdir(PROJ, { recursive: true });
  await writeFile(FILE, content, "utf8");

  // node-side formula regex checks
  const f1 = findMathAt("能量公式 $E_p = mc^2$ 与动量公式 $$p = mv$$ 在同一行。", 8);
  const f2 = findMathAt("能量公式 $E_p = mc^2$ 与动量公式 $$p = mv$$ 在同一行。", 30);
  const f3 = findMathAt("\\[\\frac{a}{b}\\] 展示公式", 6);
  const f4 = findMathAt("\\[\\frac{a}{b}\\] 展示公式", 20);
  const f5 = findMathAt("能量公式 $E_p = mc^2$ 与动量公式 $$p = mv$$ 在同一行。", 60);
  const regexOk = f1 && f1.src === "E_p = mc^2" && f1.display === false &&
    f2 && f2.src === "p = mv" && f2.display === true &&
    f3 && f3.src === "\\frac{a}{b}" && f3.display === true &&
    f4 === null &&
    f5 === null;
  console.log("REGEX inline $...$:", f1 && f1.src);
  console.log("REGEX display $$...$$:", f2 && f2.src);
  console.log("REGEX display \\[...\\]:", f3 && f3.src);
  console.log("REGEX outside math:", f4 === null && f5 === null ? "null (ok)" : "HIT (bad)");

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

  // 1) Enter-to-send: fill the AI textarea via the native setter, dispatch
  // a keydown Enter (React listens via onKeyDown), assert askAi ran (busy
  // flips or a user message appears)
  const enterRes = JSON.parse(await exec(`(async () => {
    const ta = document.querySelector('textarea.ai-generate-input');
    if (!ta) return JSON.stringify({ error: 'textarea not found' });
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '你好，这是 Enter 发送测试');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    const prevented = !ta.dispatchEvent(evt);
    await new Promise((r) => setTimeout(r, 300));
    return JSON.stringify({ prevented, valueAfter: ta.value });
  })()`));
  console.log("ENTER prevented (send):", enterRes.prevented);
  console.log("ENTER input cleared:", enterRes.valueAfter === "");

  // 2) paragraph gluing consolidation: run the rule check and count issues
  const ruleRes = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    const { useCompileStore } = await import('/src/store/compileStore.ts');
    await useCompileStore.getState().refreshDiagnostics();
    const cs = useCompileStore.getState();
    return JSON.stringify({ rules: cs.ruleIssues });
  })()`));
  const glued = (ruleRes.rules || []).filter((d) => (d.message || "").includes("段落粘连") || (d.message || "").includes("没有空行"));
  console.log("GLUED issues (must be 1 chain, not 11):", glued.length);
  console.log("GLUED message:", glued[0] && glued[0].message.slice(0, 60));

  // 3) liquid-glass left blob: CSS check that blob-1 is hidden
  const blobRes = JSON.parse(await exec(`(async () => {
    const r = {};
    for (const name of ['blob-1', 'blob-2', 'blob-3']) {
      const el = document.querySelector('.glass-blobs .' + name);
      if (!el) { r[name] = 'missing'; continue; }
      const cs = getComputedStyle(el);
      r[name] = { opacity: cs.opacity, animation: cs.animationName };
    }
    return JSON.stringify(r);
  })()`));
  console.log("BLOB-1 (left, must be hidden):", JSON.stringify(blobRes["blob-1"]));
  console.log("BLOB-2 (right, kept):", JSON.stringify(blobRes["blob-2"]));

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = regexOk && enterRes.prevented && enterRes.valueAfter === "" &&
    glued.length === 1 && (blobRes["blob-1"]?.opacity === "0" || blobRes["blob-1"] === "missing") &&
    blobRes["blob-2"]?.opacity !== "0";
  console.log("E2E-DONE", pass ? "PASS" : "FAIL");
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
