// e2e: v0.7.0 split view — toolbar button opens QuickOpen in split mode,
// the second Monaco pane edits its own tab independently.
import { writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v076-check";
const FILE = PROJ + "/main.tex";
const CHAP = PROJ + "/chap2.tex";
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
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  await mkdir(PROJ, { recursive: true });
  await writeFile(FILE, "\\documentclass{article}\n\\begin{document}\n主文件。\n\\end{document}\n", "utf8");
  await writeFile(CHAP, "\\documentclass{article}\n\\begin{document}\n第二章。\n\\end{document}\n", "utf8");

  const wsUrl = await cdp();
  const c = await connect(wsUrl);
  await c.send("Runtime.enable");
  const exec = async (expr) => {
    const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("JS: " + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const st = useProjectStore.getState();
    await st.openProject(${JSON.stringify(PROJ)});
    await st.openFile('main.tex');
    return true;
  })()`);
  await sleep(800);

  // 1) click the split toolbar button -> QuickOpen opens in split mode
  const splitOpen = JSON.parse(await exec(`(async () => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.title || '').includes('分屏') || (b.textContent || '').includes('分屏'));
    if (!btn) return JSON.stringify({ clicked: false });
    btn.click();
    await new Promise((r) => setTimeout(r, 500));
    const input = document.querySelector('.quickopen input, .quickopen-input, input[placeholder*="文件"]');
    return JSON.stringify({ clicked: true, hasInput: !!input });
  })()`));
  console.log("SPLIT button opens QuickOpen:", splitOpen.clicked, "| input:", splitOpen.hasInput);

  // 2) pick chap2.tex from QuickOpen -> split pane renders
  const picked = JSON.parse(await exec(`(async () => {
    const input = document.querySelector('.quick-open-input');
    if (!input) return JSON.stringify({ picked: false });
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'chap2');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const rows = [...document.querySelectorAll('.quick-open-list button, .quick-open-list > *')];
    const row = rows.find((r) => (r.textContent || '').includes('chap2'));
    if (!row) return JSON.stringify({ picked: false, rows: rows.length });
    row.click();
    await new Promise((r) => setTimeout(r, 600));
    const split = document.querySelector('.split-pane');
    const title = split && split.querySelector('.split-title');
    return JSON.stringify({ picked: true, hasSplit: !!split, title: title && title.textContent });
  })()`));
  console.log("SPLIT pane:", JSON.stringify(picked));

  // 3) type into the split editor -> its tab updates independently
  const edited = JSON.parse(await exec(`(async () => {
    const split = document.querySelector('.split-pane');
    if (!split) return JSON.stringify({ edited: false });
    const ta = split.querySelector('.monaco-editor textarea');
    ta && ta.focus();
    await new Promise((r) => setTimeout(r, 200));
    return JSON.stringify({ focus: !!ta });
  })()`));
  await c.send("Input.insertText", { text: "分屏编辑内容" });
  await sleep(500);
  const storeCheck = JSON.parse(await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const st = useProjectStore.getState();
    const tab = st.tabs.find((t) => t.path === 'chap2.tex');
    return JSON.stringify({ content: tab ? tab.content : null, dirty: tab && tab.dirty });
  })()`));
  console.log("SPLIT edit in store:", JSON.stringify(storeCheck.content));
  const editOk = edited.focus === true && (storeCheck.content || "").includes("分屏编辑内容");

  // 4) close the split pane
  const closed = JSON.parse(await exec(`(async () => {
    const btn = document.querySelector('.split-header .btn-mini');
    if (!btn) return JSON.stringify({ closed: false });
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    return JSON.stringify({ closed: !document.querySelector('.split-pane') });
  })()`));
  console.log("SPLIT close:", closed.closed);

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = splitOpen.clicked === true && picked.picked === true && picked.hasSplit === true &&
    picked.title === "chap2.tex" && editOk === true && closed.closed === true;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL");
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
