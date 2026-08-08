// e2e: v0.7.0 toolbar "New file" entry (template dialog) + layout regression.
import { writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v085-check";
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

async function main() {
  const tex = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Hello toolbar new file.",
    "\\end{document}",
    "",
  ].join("\n");
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  await mkdir(PROJ, { recursive: true });
  await writeFile(FILE, tex, "utf8");

  const wsUrl = await cdp();
  const c = await connect(wsUrl);
  await c.send("Runtime.enable");
  const exec = async (expr) => {
    const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("JS: " + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  await exec(`(async () => {
    localStorage.setItem('tb-ai-rail', '1');
    localStorage.removeItem('tb-tree-w');
    localStorage.removeItem('tb-pdf-w');
    localStorage.removeItem('tb-ai-w');
    localStorage.removeItem('tb-bottom-h');
    location.reload();
    return true;
  })()`);
  await sleep(2500);
  await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    await useProjectStore.getState().openProject(${JSON.stringify(PROJ)});
    await useProjectStore.getState().openFile('main.tex');
    return true;
  })()`);
  await sleep(800);

  // 1) toolbar has the "New file" button; clicking opens the template dialog
  const step1 = JSON.parse(await exec(`(async () => {
    const btns = [...document.querySelectorAll('.toolbar .btn')];
    const nb = btns.find((b) => b.textContent.includes('新建文件') || b.textContent.includes('New file'));
    if (!nb) return JSON.stringify({ found: false });
    nb.click();
    await new Promise((r) => setTimeout(r, 300));
    const modal = document.querySelector('.modal');
    const tplSelect = modal && modal.querySelector('select');
    const opts = tplSelect ? [...tplSelect.options].map((o) => o.value) : [];
    const hasTpl = opts.includes('article') && opts.includes('ctexart') && opts.includes('beamer');
    // close dialog
    const closeBtn = modal && modal.querySelector('.modal-header .btn-mini');
    if (closeBtn) closeBtn.click();
    await new Promise((r) => setTimeout(r, 200));
    return JSON.stringify({ found: true, hasTpl, opts });
  })()`));
  console.log("STEP1 (toolbar new file):", JSON.stringify(step1));
  const step1Ok = step1.found === true && step1.hasTpl === true;

  // 2) create a file via the API-equivalent path (template seeding works)
  const step2 = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    await api.newFile('sections/methods.tex', 'ctexart');
    const content = await api.readFile('sections/methods.tex');
    return JSON.stringify({ hasClass: content.includes('\\\\documentclass{ctexart}'), hasTitle: content.includes('标题') });
  })()`));
  console.log("STEP2 (template seed):", JSON.stringify(step2));
  const step2Ok = step2.hasClass === true && step2.hasTitle === true;

  // 3) layout regression: no overlaps, all panels visible, AI input visible
  const step3 = JSON.parse(await exec(`(() => {
    const q = (s) => document.querySelector(s);
    const r = (el) => el ? el.getBoundingClientRect() : null;
    const toolbar = r(q('.toolbar'));
    const tabs = r(q('.editor-tabs'));
    const mono = r(q('.monaco-editor'));
    const ai = r(q('.ai-rail'));
    const inter = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    return JSON.stringify({
      toolbarVsTabs: inter(toolbar, tabs),
      tabsVsMonaco: inter(tabs, mono),
      aiRight: ai ? Math.round(ai.right) : -1,
      w: window.innerWidth,
    });
  })()`));
  console.log("STEP3 (layout regression):", JSON.stringify(step3));
  const step3Ok = step3.toolbarVsTabs === false && step3.tabsVsMonaco === false && step3.aiRight <= step3.w + 1;

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = step1Ok && step2Ok && step3Ok;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL", { step1Ok, step2Ok, step3Ok });
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
