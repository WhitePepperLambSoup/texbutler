// e2e: v0.7.0 welcome screen + recent projects (one-click restore).
import { writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v080-check";
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
    "Hello recent projects.",
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

  // 1) clear recent + session flow + reload → welcome screen shows empty
  await exec(`(async () => {
    localStorage.removeItem('tb-recent-projects');
    localStorage.removeItem('tb-flow');
    location.reload();
    return true;
  })()`);
  await sleep(2500);
  const step1b = JSON.parse(await exec(`(async () => {
    const welcome = document.querySelector('.welcome');
    const recentCount = document.querySelectorAll('.welcome-recent li').length;
    const root = document.querySelector('.toolbar-root');
    return JSON.stringify({ welcome: !!welcome, recentCount, hasProject: !!root });
  })()`));
  console.log("STEP1 (welcome after reload):", JSON.stringify(step1b));
  const step1Ok = step1b.welcome === true && step1b.recentCount === 0 && step1b.hasProject === false;

  // 2) open a project → recorded in recent
  const step2 = JSON.parse(await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    await useProjectStore.getState().openProject(${JSON.stringify(PROJ)});
    await useProjectStore.getState().openFile('main.tex');
    await new Promise((r) => setTimeout(r, 400));
    const raw = localStorage.getItem('tb-recent-projects') ?? '[]';
    const arr = JSON.parse(raw);
    return JSON.stringify({ root: useProjectStore.getState().root, recent: arr.map((p) => p.path) });
  })()`));
  console.log("STEP2 (open → recorded):", JSON.stringify(step2));
  const step2Ok = step2.root === PROJ && step2.recent.length === 1 && step2.recent[0] === PROJ;

  // 3) close again → welcome shows the recent entry; click it → reopens
  const step3 = JSON.parse(await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    useProjectStore.setState({ root: '', mainFile: null, activeTab: null, files: [], pdfPath: null });
    await new Promise((r) => setTimeout(r, 400));
    const item = document.querySelector('.welcome-recent-item');
    const shown = !!item && item.textContent.includes('v080-check');
    if (item) {
      item.click();
      for (let i = 0; i < 40; i++) {
        if (useProjectStore.getState().root) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return JSON.stringify({ shown, reopenedRoot: useProjectStore.getState().root });
  })()`));
  console.log("STEP3 (restore):", JSON.stringify(step3));
  const step3Ok = step3.shown === true && step3.reopenedRoot === PROJ;

  // 4) failed open (deleted dir) removes the entry + refreshes the list
  const step4 = JSON.parse(await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const { removeRecent } = await import('/src/store/recent.ts');
    const { api } = await import('/src/api/index.ts');
    // simulate a stale entry: force-record a path that no longer exists
    removeRecent(${JSON.stringify(PROJ)});
    const ghost = ${JSON.stringify(PROJ)} + '/ghost-deleted';
    localStorage.setItem('tb-recent-projects', JSON.stringify([
      { path: ghost, name: 'ghost-deleted', lastOpened: Date.now() },
      ...(JSON.parse(localStorage.getItem('tb-recent-projects') ?? '[]')),
    ]));
    useProjectStore.setState({ root: '', mainFile: null, activeTab: null, files: [], pdfPath: null });
    await new Promise((r) => setTimeout(r, 400));
    // click the ghost entry; openProject will fail and remove it
    const items = [...document.querySelectorAll('.welcome-recent-item')];
    const ghostBtn = items.find((b) => b.textContent.includes('ghost-deleted'));
    if (ghostBtn) {
      ghostBtn.click();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const after = JSON.parse(localStorage.getItem('tb-recent-projects') ?? '[]');
    const stillThere = after.some((p) => p.path === ghost);
    return JSON.stringify({ removed: !stillThere });
  })()`));
  console.log("STEP4 (failed open cleanup):", JSON.stringify(step4));
  const step4Ok = step4.removed === true;

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = step1Ok && step2Ok && step3Ok && step4Ok;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL", { step1Ok, step2Ok, step3Ok, step4Ok });
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
