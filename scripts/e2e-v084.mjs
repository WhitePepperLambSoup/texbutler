// e2e: v0.7.0 layout integrity — no panel overlap at common window sizes,
// splitters draggable, AI rail auto-collapses on narrow windows.
import { writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v084-check";
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
    "Layout integrity test.",
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
  let projectStoreUrl = '/src/store/projectStore.ts';
  const resolveProjectStoreUrl = async () => {
    projectStoreUrl = await exec(`(() => performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
      ?? '/src/store/projectStore.ts')()`);
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
  await resolveProjectStoreUrl();
  await exec(`(async () => {
    const { useProjectStore } = await import(${JSON.stringify(projectStoreUrl)});
    await useProjectStore.getState().openProject(${JSON.stringify(PROJ)});
    await useProjectStore.getState().openFile('main.tex');
    return true;
  })()`);
  await sleep(800);

  // 1) no PDF: the persistent PDF pane shows its empty state; editor + AI rail fit.
  const step1 = JSON.parse(await exec(`(() => {
    const q = (s) => document.querySelector(s);
    const r = (el) => el ? el.getBoundingClientRect() : null;
    const pdf = r(q('.col-pdf'));
    const empty = r(q('.col-pdf .pdf-empty'));
    const divider = r(q('.col-editor + .splitter-v'));
    const editor = r(q('.col-editor'));
    const ai = r(q('.ai-rail'));
    const w = window.innerWidth;
    return JSON.stringify({
      pdfW: pdf && Math.round(pdf.width),
      emptyVisible: !!empty && empty.width > 0 && empty.height > 0,
      dividerVisible: !!divider && divider.width >= 6 && getComputedStyle(q('.col-editor + .splitter-v')).visibility !== 'hidden',
      editorVisible: editor && editor.width >= 150 && editor.right <= w + 1,
      aiRight: ai ? Math.round(ai.right) : -1,
      w,
    });
  })()`));
  console.log("STEP1 (no-pdf layout):", JSON.stringify(step1));
  const step1Ok = step1.pdfW >= 240 && step1.emptyVisible === true && step1.dividerVisible === true
    && step1.editorVisible === true && step1.aiRight <= step1.w + 1 && step1.aiRight > 0;

  // 2) overlap assertion: toolbar vs editor-tabs vs monaco must not
  //    intersect; AI input visible
  const step2 = JSON.parse(await exec(`(() => {
    const q = (s) => document.querySelector(s);
    const r = (el) => el ? el.getBoundingClientRect() : null;
    const toolbar = r(q('.toolbar'));
    const tabs = r(q('.editor-tabs'));
    const mono = r(q('.monaco-editor'));
    const aiInput = r(q('.ai-generate-input')) || r(q('.ai-input-box textarea'));
    const inter = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    return JSON.stringify({
      toolbarVsTabs: inter(toolbar, tabs),
      tabsVsMonaco: inter(tabs, mono),
      aiInputVisible: !!aiInput && aiInput.width > 50 && aiInput.height > 20,
    });
  })()`));
  console.log("STEP2 (overlaps):", JSON.stringify(step2));
  const step2Ok = step2.toolbarVsTabs === false && step2.tabsVsMonaco === false && step2.aiInputVisible === true;

  // 3) tree splitter drag still works (width change), sizes persist
  const step3 = JSON.parse(await exec(`(async () => {
    const splitter = document.querySelector('.layout > .splitter-v');
    const tree = document.querySelector('.col-tree');
    const before = tree.getBoundingClientRect().width;
    const rect = splitter.getBoundingClientRect();
    const sx = rect.left + rect.width / 2;
    const sy = rect.top + 60;
    const pointerId = 8401;
    splitter.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: sx,
      clientY: sy,
      button: 0,
      buttons: 1,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: sx + 80,
      clientY: sy,
      button: -1,
      buttons: 1,
    }));
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: sx + 80,
      clientY: sy,
      button: -1,
      buttons: 0,
    }));
    await new Promise((r) => setTimeout(r, 150));
    const after = tree.getBoundingClientRect().width;
    return JSON.stringify({ before, after, saved: Number(localStorage.getItem('tb-tree-w')) });
  })()`));
  console.log("STEP3 (splitter drag):", JSON.stringify(step3));
  const step3Ok = Math.round(step3.after - step3.before) === 80 && Math.round(step3.saved) === Math.round(step3.after);

  // 4) narrow window (900px): AI rail auto-collapses, editor still visible
  //    (CDP viewport emulation — window.resizeTo is inert in WebView2)
  await c.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  const step4 = JSON.parse(await exec(`(() => {
    const ai = document.querySelector('.ai-rail');
    const editor = document.querySelector('.col-editor');
    const aiR = ai.getBoundingClientRect();
    const edR = editor.getBoundingClientRect();
    return JSON.stringify({ collapsed: ai.classList.contains('collapsed'), aiW: Math.round(aiR.width), edW: Math.round(edR.width) });
  })()`));
  console.log("STEP4 (narrow auto-collapse):", JSON.stringify(step4));
  const step4Ok = step4.collapsed === true && step4.edW >= 150;
  await c.send("Emulation.clearDeviceMetricsOverride").catch(() => {});

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = step1Ok && step2Ok && step3Ok && step4Ok;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL", { step1Ok, step2Ok, step3Ok, step4Ok });
  if (!pass) process.exitCode = 1;
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
