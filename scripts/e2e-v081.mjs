// e2e: v0.7.0 Windows-style splitter drag (tree/pdf/ai/bottom panels).
import { writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v081-check";
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
    "Hello splitter test.",
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
    localStorage.removeItem('tb-tree-w');
    localStorage.removeItem('tb-pdf-w');
    localStorage.removeItem('tb-ai-w');
    localStorage.removeItem('tb-bottom-h');
    localStorage.removeItem('tb-flow');
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

  // 1) splitters exist; tree width default 220
  const step1 = JSON.parse(await exec(`(() => {
    const tree = document.querySelector('.col-tree');
    const splitters = document.querySelectorAll('.splitter-v').length;
    const splitH = document.querySelectorAll('.splitter-h').length;
    return JSON.stringify({ treeW: tree && tree.getBoundingClientRect().width, splitters, splitH });
  })()`));
  console.log("STEP1 (splitters):", JSON.stringify(step1));
  const step1Ok = step1.splitters >= 3 && step1.splitH === 1 && Math.round(step1.treeW) === 220;

  // 2) drag the tree splitter +120px → width grows; persisted to localStorage
  const step2 = JSON.parse(await exec(`(async () => {
    const splitter = document.querySelector('.layout > .splitter-v');
    const tree = document.querySelector('.col-tree');
    const before = tree.getBoundingClientRect().width;
    const rect = splitter.getBoundingClientRect();
    const sx = rect.left + rect.width / 2;
    const sy = rect.top + 50;
    const down = new MouseEvent('mousedown', { bubbles: true, clientX: sx, clientY: sy, button: 0 });
    splitter.dispatchEvent(down);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: sx + 120, clientY: sy }));
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    await new Promise((r) => setTimeout(r, 150));
    const after = tree.getBoundingClientRect().width;
    const saved = Number(localStorage.getItem('tb-tree-w'));
    return JSON.stringify({ before, after, saved });
  })()`));
  console.log("STEP2 (tree drag):", JSON.stringify(step2));
  const step2Ok = Math.round(step2.after - step2.before) === 120 && Math.round(step2.saved) === 340;

  // 3) bottom splitter drag -60px → height shrinks; persisted
  const step3 = JSON.parse(await exec(`(async () => {
    const splitter = document.querySelector('.splitter-h');
    const bottom = document.querySelector('.bottom');
    const before = bottom.getBoundingClientRect().height;
    const rect = splitter.getBoundingClientRect();
    const sx = rect.left + 100;
    const sy = rect.top + rect.height / 2;
    const down = new MouseEvent('mousedown', { bubbles: true, clientX: sx, clientY: sy, button: 0 });
    splitter.dispatchEvent(down);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: sx, clientY: sy - 60 }));
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    await new Promise((r) => setTimeout(r, 150));
    const after = bottom.getBoundingClientRect().height;
    const saved = Number(localStorage.getItem('tb-bottom-h'));
    return JSON.stringify({ before, after, saved });
  })()`));
  console.log("STEP3 (bottom drag):", JSON.stringify(step3));
  const step3Ok = Math.round(step3.before - step3.after) === 60 && Math.round(step3.saved) === 220;

  // 4) reload → sizes restored from localStorage
  const step4 = JSON.parse(await exec(`(async () => {
    location.reload();
    return true;
  })()`));
  await sleep(2500);
  const step4b = JSON.parse(await exec(`(() => {
    const tree = document.querySelector('.col-tree');
    const bottom = document.querySelector('.bottom');
    return JSON.stringify({ treeW: Math.round(tree.getBoundingClientRect().width), bottomH: Math.round(bottom.getBoundingClientRect().height) });
  })()`));
  console.log("STEP4 (restore):", JSON.stringify(step4b));
  const step4Ok = step4b.treeW === 340 && step4b.bottomH === 220;

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = step1Ok && step2Ok && step3Ok && step4Ok;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL", { step1Ok, step2Ok, step3Ok, step4Ok });
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
