// e2e: v0.7.0 project dashboard (compile counter) + full-document
// AI translation (real API) with auto-compile.
import { writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v078-check";
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
    "\\usepackage{amsmath}",
    "\\begin{document}",
    "\\section{Introduction}",
    "This is the introduction of the document, and the main formula is $E = mc^2$.",
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
    localStorage.removeItem(${JSON.stringify("tb-stats:" + PROJ)});
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const st = useProjectStore.getState();
    await st.openProject(${JSON.stringify(PROJ)});
    await st.openFile('main.tex');
    return true;
  })()`);
  await sleep(700);

  // 1) dashboard: compile once (real compile), then check the counter
  const comp = JSON.parse(await exec(`(async () => {
    const { useCompileStore } = await import('/src/store/compileStore.ts');
    await useCompileStore.getState().compile('main');
    // wait for completion (poll running)
    for (let i = 0; i < 120; i++) {
      if (!useCompileStore.getState().running) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const { loadStats } = await import('/src/store/stats.ts');
    const st = loadStats(${JSON.stringify(PROJ)});
    const bar = [...document.querySelectorAll('.status-item')].map((s) => s.textContent);
    return JSON.stringify({ ok: useCompileStore.getState().lastResult?.ok, compiles: st && st.compiles, bar: bar.join(' | '), wordSamples: st && st.words.length });
  })()`));
  console.log("COMPILE:", JSON.stringify(comp));
  const dashOk = comp.ok === true && comp.compiles >= 1 && (comp.bar || "").includes("编译") && comp.wordSamples >= 1;

  // 2) full-document translation (real API): translate to Chinese,
  //    then verify the content changed and still compiles
  const trans = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const st = useProjectStore.getState();
    const tab = st.tabs.find((t) => t.path === 'main.tex');
    const whole = tab.content;
    try {
      const translated = await api.aiTranslate(whole, '中文');
      st.setTabContent('main.tex', translated);
      return JSON.stringify({ ok: true, hasChinese: /[\u4e00-\u9fff]/.test(translated), keepsFormula: translated.includes('E = mc^2') || translated.includes('E=mc^2'), len: translated.length });
    } catch (e) {
      return JSON.stringify({ ok: false, err: String(e) });
    }
  })()`));
  console.log("TRANSLATE:", JSON.stringify(trans));
  const transOk = trans.ok === true && trans.hasChinese === true && trans.keepsFormula === true;

  // auto-compile after translation (button flow is confirm-gated; call the
  // compile the button would trigger)
  const after = JSON.parse(await exec(`(async () => {
    const { useCompileStore } = await import('/src/store/compileStore.ts');
    await useCompileStore.getState().compile('main');
    for (let i = 0; i < 120; i++) {
      if (!useCompileStore.getState().running) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return JSON.stringify({ ok: useCompileStore.getState().lastResult?.ok });
  })()`));
  console.log("POST-TRANSLATE compile:", JSON.stringify(after));
  const compileAfterOk = after.ok === true;

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = dashOk && transOk && compileAfterOk;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL");
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
