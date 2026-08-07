// e2e: v0.7.0 batch 3 — auto-save (dirty tab -> disk on interval) and AI
// conversation persistence (sessions in localStorage, switch/restore).
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v072-check";
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
    "自动保存测试文档。",
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
    localStorage.setItem('tb-autosave-secs', '5'); // tick every 5s, save on 2nd tick
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const st = useProjectStore.getState();
    await st.openProject(${JSON.stringify(PROJ)});
    await st.openFile('main.tex');
    await new Promise((r) => setTimeout(r, 500));
    return true;
  })()`);
  await sleep(800);

  // 1) auto-save: edit the tab content (dirty), wait 12s, read disk
  const editRes = JSON.parse(await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const st = useProjectStore.getState();
    st.setTabContent('main.tex', '\\documentclass{article}\\n\\begin{document}\\n自动保存已生效——磁盘内容已更新。\\n\\end{document}\\n');
    return JSON.stringify({ dirty: useProjectStore.getState().tabs.find(t => t.path === 'main.tex')?.dirty });
  })()`));
  console.log("EDIT dirty before autosave:", editRes.dirty);
  await sleep(12000); // > 2 ticks
  const disk = await readFile(FILE, "utf8");
  const autosaveOk = disk.includes("磁盘内容已更新");
  console.log("AUTOSAVE disk updated:", autosaveOk);

  // 2) conversation persistence: new session, ask AI (real API), verify
  // localStorage sessions + switch back
  const sessRes = JSON.parse(await exec(`(async () => {
    const { useAiStore } = await import('/src/store/aiStore.ts');
    const ai = useAiStore.getState();
    ai.newSession();
    await new Promise((r) => setTimeout(r, 100));
    const sid = useAiStore.getState().sessionId;
    await useAiStore.getState().askAi('请回复两个字：收到');
    await new Promise((r) => setTimeout(r, 15000));
    const st = useAiStore.getState();
    const saved = JSON.parse(localStorage.getItem('tb-ai-sessions') || '[]');
    const sess = saved.find((s) => s.id === sid);
    const lastMsg = sess && sess.messages[sess.messages.length - 1];
    return JSON.stringify({ sid, savedCount: saved.length, lastRole: lastMsg && lastMsg.role, lastText: lastMsg && lastMsg.text });
  })()`));
  console.log("SESSION saved count:", sessRes.savedCount, "| last role:", sessRes.lastRole);
  console.log("SESSION last text:", (sessRes.lastText || "").slice(0, 60));

  // restore the scratch chat so state is clean-ish for further runs
  await exec(`(async () => { const { useAiStore } = await import('/src/store/aiStore.ts'); useAiStore.getState().switchSession(null); return true; })()`);

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = autosaveOk && sessRes.savedCount >= 1 && sessRes.lastRole === "assistant" &&
    typeof sessRes.lastText === "string" && sessRes.lastText.length > 0 && !sessRes.lastText.startsWith("ERR");
  console.log("E2E-DONE", pass ? "PASS" : "FAIL");
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
