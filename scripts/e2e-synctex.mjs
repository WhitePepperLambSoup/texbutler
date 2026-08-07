// e2e: PDF 定位（SyncTeX forward search）——编译后从编辑器行号定位 PDF 页码
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/synctex-check";
const FILE = PROJ + "/main.tex";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp() {
  for (let i = 0; i < 150; i++) {
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
    "\\begin{document}",
    "\\section*{First}",
    "Hello world.",
    "\\newpage",
    "\\section*{Second}",
    "Second page content.",
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

  await exec(`(async () => { const { useProjectStore } = await import('/src/store/projectStore.ts'); await useProjectStore.getState().openProject(${JSON.stringify(PROJ)}); return true; })()`);
  await sleep(800);

  // compile the project first (produces .synctex.gz); poll until the PDF
  // exists (first run downloads the tectonic bundle — can take minutes)
  await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    await api.compile(null);
    return true;
  })()`);
  let pdfReady = false;
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    try {
      const { readFile } = await import('node:fs/promises');
      const r = await readFile(PROJ + "/.texbutler/build/main.synctex.gz");
      pdfReady = r.length > 0;
      if (pdfReady) break;
    } catch {}
  }
  if (!pdfReady) {
    console.log("SYNCTEX: build output not ready after 180s");
  }

  // forward search from a line on page 2 — full frontend chain: button
  // logic (synctexForward + CustomEvent) + PdfPreview iframe src
  const res = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    const page = await api.synctexForward("main.tex", 7); // \\section*{Second} is on line 7
    if (page != null) {
      window.dispatchEvent(new CustomEvent("tb:synctex-page", { detail: page }));
    }
    return JSON.stringify({ page });
  })()`));
  await sleep(1500); // let React re-render the iframe with the new key/src
  const src = await exec(`document.querySelector('iframe.pdf-frame') ? document.querySelector('iframe.pdf-frame').src : ''`);
  console.log("SYNCTEX page for line 7 (section Second):", res.page);
  console.log("IFRAME src:", src);
  const ok = res.page != null && res.page >= 2 && src.includes("#page=" + res.page);
  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  console.log("E2E-DONE", ok ? "PASS" : "FAIL");
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
