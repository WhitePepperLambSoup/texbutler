// e2e: AI edits must sync into the open editor tab immediately.
// Opens the project, opens main.tex, asks the AI to change the title,
// then asserts the editor tab content (store) equals the disk content
// after the tb://ai-edit event fires — the exact bug the user reported.
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/sync-check";
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
  const content = [
    "\\documentclass[11pt]{article}",
    "\\usepackage{amsmath}",
    "\\title{Quantum Mechanics Notes}",
    "\\author{}",
    "\\date{}",
    "",
    "\\begin{document}",
    "\\maketitle",
    "\\section{Introduction}",
    "The wave function describes the state of a quantum system.",
    "\\section{Wave Equation}",
    "The Schr\\\"odinger equation governs the time evolution.",
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

  await exec(`(async () => { const { useProjectStore } = await import('/src/store/projectStore.ts'); await useProjectStore.getState().openProject(${JSON.stringify(PROJ)}); await useProjectStore.getState().openFile('main.tex'); return true; })()`);
  await sleep(800);

  const res = JSON.parse(await exec(`(async () => {
    const { useAiStore } = await import('/src/store/aiStore.ts');
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const { onEvent } = await import('/src/api/index.ts');
    const events = [];
    const un = await onEvent('tb://ai-edit', (e) => events.push(e));
    try {
      await useAiStore.getState().askAi('把文档标题改为 "量子力学笔记"（\\\\title{量子力学笔记}），其余内容不要动', 'main.tex', null);
    } catch (e) { events.push("ERR:" + e); }
    un();
    // give reloadTab (inside listenEditP) a beat to land
    await new Promise((r) => setTimeout(r, 1500));
    const msgs = useAiStore.getState().messages;
    const last = msgs[msgs.length - 1];
    const tab = useProjectStore.getState().tabs.find((t) => t.path === 'main.tex');
    return JSON.stringify({ full: last ? last.text : "", events: events.length, tabContent: tab ? tab.content : null, dirty: tab ? tab.dirty : null });
  })()`));
  const disk = await readFile(FILE, "utf8");
  const synced = res.tabContent !== null && res.tabContent === disk && disk.includes("量子力学笔记");
  console.log("ANSWER head:", res.full.slice(0, 200).replace(/\n/g, " "));
  console.log("EDIT EVENTS:", res.events);
  console.log("TAB LEN:", (res.tabContent || "").length, "DISK LEN:", disk.length);
  console.log("TAB has chinese title:", (res.tabContent || "").includes("量子力学笔记"));
  console.log("DISK has chinese title:", disk.includes("量子力学笔记"));
  console.log("TAB head:", JSON.stringify((res.tabContent || "").slice(0, 160)));
  console.log("DISK head:", JSON.stringify(disk.slice(0, 160)));
  console.log("DIRTY after reload:", res.dirty);

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  console.log("E2E-DONE", synced ? "PASS" : "FAIL");
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
