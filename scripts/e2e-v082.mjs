// e2e: v0.7.0 per-file AI conversations (auto-switch) + compile-saves-dirty
// (compile reflects exactly what the editor shows).
import { writeFile, rm, mkdir, readFile } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v082-check";
const FILE_A = PROJ + "/main.tex";
const FILE_B = PROJ + "/chapter2.tex";
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
  const mainTex = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\input{chapter2}",
    "Hello original main.",
    "\\end{document}",
    "",
  ].join("\n");
  const ch2 = [
    "\\section{Chapter Two}",
    "Chapter two content.",
    "",
  ].join("\n");
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  await mkdir(PROJ, { recursive: true });
  await writeFile(FILE_A, mainTex, "utf8");
  await writeFile(FILE_B, ch2, "utf8");

  const wsUrl = await cdp();
  const c = await connect(wsUrl);
  await c.send("Runtime.enable");
  const exec = async (expr) => {
    const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("JS: " + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  await exec(`(async () => {
    localStorage.removeItem('tb-ai-sessions');
    localStorage.removeItem('tb-ai-file-sessions');
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    await useProjectStore.getState().openProject(${JSON.stringify(PROJ)});
    await useProjectStore.getState().openFile('main.tex');
    return true;
  })()`);
  await sleep(700);

  // 1) per-file sessions: send a message on main.tex, switch to chapter2,
  //    send another, switch back → main.tex's conversation is restored
  const step1 = JSON.parse(await exec(`(async () => {
    const { useAiStore } = await import('/src/store/aiStore.ts');
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    // main.tex: new session + a message
    useAiStore.getState().newSession();
    useAiStore.getState().pushMessage({ role: 'user', kind: 'plain', text: 'question about main' });
    const mainSession = useAiStore.getState().sessionId;
    // switch to chapter2.tex → the conversation should detach (scratch)
    await useProjectStore.getState().openFile('chapter2.tex');
    await new Promise((r) => setTimeout(r, 200));
    const afterSwitch = useAiStore.getState().sessionId;
    // chapter2: new session + message
    useAiStore.getState().newSession();
    useAiStore.getState().pushMessage({ role: 'user', kind: 'plain', text: 'question about chapter2' });
    const ch2Session = useAiStore.getState().sessionId;
    // switch back to main.tex → auto-restores the main conversation
    await useProjectStore.getState().openFile('main.tex');
    await new Promise((r) => setTimeout(r, 200));
    const restored = useAiStore.getState().sessionId;
    const restoredMessages = useAiStore.getState().messages.map((m) => m.text);
    return JSON.stringify({ mainSession, afterSwitch, ch2Session, restored, restoredMessages, bindings: useAiStore.getState().fileSessions });
  })()`));
  console.log("STEP1 (per-file sessions):", JSON.stringify(step1));
  const step1Ok =
    step1.mainSession !== null &&
    step1.afterSwitch !== step1.mainSession && // detached when leaving
    step1.ch2Session !== step1.mainSession &&
    step1.restored === step1.mainSession && // auto-restored on return
    step1.restoredMessages.includes("question about main") &&
    step1.bindings["main.tex"] === step1.mainSession &&
    step1.bindings["chapter2.tex"] === step1.ch2Session;

  // 2) compile reflects the editor content: edit main.tex WITHOUT saving,
  //    compile, then read the file from disk — the edit must be there
  const step2pre = JSON.parse(await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const { useCompileStore } = await import('/src/store/compileStore.ts');
    const mf = useProjectStore.getState().mainFile;
    const apiMod = await import('/src/api/index.ts');
    const info = await apiMod.api.projectInfo();
    await useCompileStore.getState().compile('main');
    for (let i = 0; i < 120; i++) {
      if (!useCompileStore.getState().running) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return JSON.stringify({ mainFile: mf, backendMain: info && info.main_file, ok: useCompileStore.getState().lastResult?.ok, err: (useCompileStore.getState().lastResult?.issues ?? []).map((i) => i.message).join(' | ') });
  })()`));
  console.log("STEP2-pre (clean compile):", JSON.stringify(step2pre));
  const step2 = JSON.parse(await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const { useCompileStore } = await import('/src/store/compileStore.ts');
    const ps = useProjectStore.getState();
    await ps.openFile('main.tex');
    ps.setTabContent('main.tex', ps.tabs.find((t) => t.path === 'main.tex').content.replace('Hello original main.', 'Hello EDITED-WITHOUT-SAVE.'));
    await new Promise((r) => setTimeout(r, 150));
    // do NOT call saveFile — compile must save dirty tabs itself
    await useCompileStore.getState().compile('main');
    for (let i = 0; i < 120; i++) {
      if (!useCompileStore.getState().running) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return JSON.stringify({ ok: useCompileStore.getState().lastResult?.ok, err: (useCompileStore.getState().lastResult?.issues ?? []).map((i) => i.message).join(' | ') });
  })()`));
  console.log("STEP2 (compile saves dirty):", JSON.stringify(step2));
  const diskMain = await readFile(FILE_A, "utf8").catch(() => "");
  const diskCh2 = await readFile(FILE_B, "utf8").catch(() => "");
  console.log("DISK main.tex:", JSON.stringify(diskMain));
  console.log("DISK chapter2.tex:", JSON.stringify(diskCh2));
  const disk = await readFile(FILE_A, "utf8").catch(() => "");
  const step2Ok = step2.ok === true && disk.includes("EDITED-WITHOUT-SAVE");

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = step1Ok && step2Ok;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL", { step1Ok, step2Ok });
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
