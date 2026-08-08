// e2e: v0.7.0 new-file-in-project (template seeding) + template verification markers.
import { writeFile, rm, mkdir, readFile } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v083-check";
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
    "Hello new file.",
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
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    await useProjectStore.getState().openProject(${JSON.stringify(PROJ)});
    return true;
  })()`);
  await sleep(600);

  // 1) new .tex with article template → seeded content with \documentclass
  const step1 = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    await api.newFile('chapters/intro.tex', 'article');
    const content = await api.readFile('chapters/intro.tex');
    return JSON.stringify({ hasClass: content.includes('\\\\documentclass{article}'), hasSection: content.includes('\\\\section') });
  })()`));
  console.log("STEP1 (new file w/ template):", JSON.stringify(step1));
  const step1Ok = step1.hasClass === true && step1.hasSection === true;

  // 2) new empty .bib → created, empty
  const step2 = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    await api.newFile('refs.bib');
    const content = await api.readFile('refs.bib');
    return JSON.stringify({ empty: content.trim() === '' });
  })()`));
  console.log("STEP2 (new empty .bib):", JSON.stringify(step2));
  const step2Ok = step2.empty === true;

  // 3) creating an existing file is refused
  const step3 = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    try {
      await api.newFile('main.tex', 'article');
      return JSON.stringify({ refused: false });
    } catch (e) {
      return JSON.stringify({ refused: true, msg: String(e) });
    }
  })()`));
  console.log("STEP3 (refuse existing):", JSON.stringify(step3));
  const step3Ok = step3.refused === true;

  // 4) marketplace: built-in templates carry verified=ok
  const step4 = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    const list = await api.listMarketTemplates();
    const builtins = list.filter((t) => t.builtin);
    const allVerified = builtins.every((t) => t.verified === 'ok');
    const total = list.length;
    const byCat = {};
    for (const t of list) byCat[t.category] = (byCat[t.category] ?? 0) + 1;
    return JSON.stringify({ total, builtins: builtins.length, allVerified, byCat });
  })()`));
  console.log("STEP4 (catalog):", JSON.stringify(step4));
  const step4Ok = step4.total >= 160 && step4.builtins >= 8 && step4.allVerified === true;

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = step1Ok && step2Ok && step3Ok && step4Ok;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL", { step1Ok, step2Ok, step3Ok, step4Ok });
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
