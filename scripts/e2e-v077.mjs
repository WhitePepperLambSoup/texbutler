// e2e: v0.7.0 crash recovery (draft persists unsaved edits across
// reopen) + customizable shortcuts (rebind + keydown dispatch).
import { writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v077-check";
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
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  await mkdir(PROJ, { recursive: true });
  await writeFile(FILE, "\\documentclass{article}\n\\begin{document}\n原始内容。\n\\end{document}\n", "utf8");

  const wsUrl = await cdp();
  const c = await connect(wsUrl);
  await c.send("Runtime.enable");
  const exec = async (expr) => {
    const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("JS: " + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  await exec(`(async () => {
    localStorage.clear();
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const st = useProjectStore.getState();
    await st.openProject(${JSON.stringify(PROJ)});
    await st.openFile('main.tex');
    return true;
  })()`);
  await sleep(700);

  // 1) crash recovery: edit (unsaved), debounced draft lands, then simulate
  //    a restart by reopening the project from disk
  const draftRes = JSON.parse(await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const { saveDraft, loadDraft } = await import('/src/store/drafts.ts');
    const st = useProjectStore.getState();
    st.setTabContent('main.tex', '\\documentclass{article}\\n\\begin{document}\\n崩溃前未保存的编辑。\\n\\end{document}\\n');
    const root = useProjectStore.getState().root;
    saveDraft(root, 'main.tex', useProjectStore.getState().tabs.find((t) => t.path === 'main.tex').content, 50);
    await new Promise((r) => setTimeout(r, 200));
    const draft = loadDraft(root, 'main.tex');
    // simulate a restart: reopen from disk (draft should be restored)
    await st.closeProject();
    await st.openProject(${JSON.stringify(PROJ)});
    await st.openFile('main.tex');
    await new Promise((r) => setTimeout(r, 300));
    const tab = useProjectStore.getState().tabs.find((t) => t.path === 'main.tex');
    return JSON.stringify({ draftSaved: !!draft, restored: tab && tab.content.includes('崩溃前未保存的编辑'), dirty: tab && tab.dirty });
  })()`));
  console.log("DRAFT:", JSON.stringify(draftRes));
  const draftOk = draftRes.draftSaved === true && draftRes.restored === true && draftRes.dirty === true;

  // 2) shortcut rebind: change compileMain to ctrl+shift+m, dispatch the
  //    keydown, and confirm compile starts (status flips to running)
  const keyRes = JSON.parse(await exec(`(async () => {
    const { saveKeymap, loadKeymap } = await import('/src/store/keymap.ts');
    saveKeymap({ compileMain: 'ctrl+shift+m', compileCurrent: 'ctrl+shift+k' });
    const loaded = loadKeymap();
    return JSON.stringify({ loaded: loaded.compileMain });
  })()`));
  console.log("KEYMAP loaded:", keyRes.loaded);
  const keymapOk = keyRes.loaded === "ctrl+shift+m";

  const compileRes = JSON.parse(await exec(`(async () => {
    const { useCompileStore } = await import('/src/store/compileStore.ts');
    const before = useCompileStore.getState().running;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const afterDefault = useCompileStore.getState().running;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const afterRebind = useCompileStore.getState().running;
    return JSON.stringify({ before, afterDefault, afterRebind });
  })()`));
  console.log("COMPILE dispatch:", JSON.stringify(compileRes));
  // afterRebind true (or compile finished) proves the rebind fired;
  // afterDefault must remain false (old ctrl+b no longer triggers)
  const compileOk = compileRes.afterDefault === false && compileRes.afterRebind === true;

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = draftOk && keymapOk && compileOk;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL");
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
