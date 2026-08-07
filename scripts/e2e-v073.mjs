// e2e: v0.7.0 batch 4 — environment auto-\end{}, image auto-compress,
// DOI -> BibTeX fetch (real Crossref network).
import { readFile, writeFile, rm, mkdir, stat } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v073-check";
const FILE = PROJ + "/main.tex";
const BIG_IMG = PROJ + "/big.png";
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
  await writeFile(FILE, "\\documentclass{article}\n\\begin{document}\n测试。\n\\end{document}\n", "utf8");

  // pre-generated 4.4MB random PNG (PowerShell System.Drawing)
  const bigImg = "D:/reasonix program/idea/tex/assets/e2e/big-test.png";
  await writeFile(BIG_IMG, await readFile(bigImg));
  const bigSize = (await stat(BIG_IMG)).size;
  console.log("BIG image size (must be >1MB):", bigSize);

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

  // 1) environment auto-\end: type \begin{itemize} via real input pipeline
  //    (Input.insertText goes through Monaco's typing → onDidType fires)
  await exec(`(async () => {
    // focus the Monaco textarea
    const ta = document.querySelector('.monaco-editor textarea');
    ta && ta.focus();
    return true;
  })()`);
  await c.send("Input.insertText", { text: "\\begin{itemize}" });
  await sleep(600);
  const envOk = await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const st = useProjectStore.getState();
    const tab = st.tabs.find((t) => t.path === 'main.tex');
    return tab ? tab.content : '';
  })()`);
  console.log("ENV auto-\\end inserted:", envOk.includes("\\end{itemize}"));
  console.log("ENV content:", JSON.stringify(envOk.slice(0, 80)));

  // 2) image auto-compress: import big.png via the api (same backend the
  //    image dialog uses)
  const impRes = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    const name = await api.importImage(${JSON.stringify(BIG_IMG)});
    return JSON.stringify({ name });
  })()`));
  console.log("IMPORT result:", JSON.stringify(impRes));
  let compressOk = false;
  if (impRes && impRes.name) {
    const out = PROJ + "/" + impRes.name;
    const outSize = (await stat(out)).size;
    // verify the long edge was capped at 2048px by reading the PNG IHDR
    const head = await readFile(out).then((b) => b.subarray(16, 24));
    const outW = head.readUInt32BE(0);
    const outH = head.readUInt32BE(4);
    console.log(`IMPORTED ${outW}x${outH} size ${outSize}`);
    compressOk = outW <= 2048 && outH <= 2048;
  }

  // 3) DOI -> BibTeX: real Crossref network call
  const bibRes = await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    try {
      return await api.bibFromId('10.1038/nature12373');
    } catch (e) {
      return 'ERR:' + e;
    }
  })()`);
  console.log("DOI -> BIB:", (bibRes || "").slice(0, 100).replace(/\n/g, " "));

  // 3b) arXiv -> BibTeX: real export.arxiv.org call (1706.03762 is the
  //     classic "Attention Is All You Need" paper)
  const arxRes = await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    try {
      return await api.bibFromId('1706.03762');
    } catch (e) {
      return 'ERR:' + e;
    }
  })()`);
  console.log("ARXIV -> BIB:", (arxRes || "").slice(0, 120).replace(/\n/g, " "));

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = bigSize > 1_048_576 && envOk.includes("\\end{itemize}") && compressOk &&
    typeof bibRes === "string" && bibRes.includes("@article") && !bibRes.startsWith("ERR") &&
    typeof arxRes === "string" && arxRes.includes("@article") && !arxRes.startsWith("ERR") &&
    /Attention Is All You Need/i.test(arxRes);
  console.log("E2E-DONE", pass ? "PASS" : "FAIL");
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
