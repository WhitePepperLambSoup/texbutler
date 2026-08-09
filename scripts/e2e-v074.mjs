// e2e: v0.7.0 template marketplace — catalog listing, builtin readiness,
// create-from-marketplace (real copy), download-on-demand (real GitHub),
// UI tabs/search.
import { readFile, writeFile, rm, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v074-check";
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

  const wsUrl = await cdp();
  const c = await connect(wsUrl);
  await c.send("Runtime.enable");
  const exec = async (expr) => {
    const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("JS: " + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  // 1) catalog: list + builtin readiness
  const cat = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    const list = await api.listMarketTemplates();
    return JSON.stringify({
      count: list.length,
      sdu: list.find((t) => t.id === 'sdu-thesis'),
      anu: list.find((t) => t.id === 'anu-thesis'),
      thu: list.find((t) => t.id === 'thuthesis'),
      article: list.find((t) => t.id === 'article'),
    });
  })()`));
  console.log("CATALOG count:", cat.count);
  console.log("SDU ready:", cat.sdu && `${cat.sdu.ready}/${cat.sdu.mode}`);
  console.log("ANU ready:", cat.anu && `${cat.anu.ready}/${cat.anu.mode}`);
  console.log("THU ready:", cat.thu && `${cat.thu.ready}/${cat.thu.mode}`);
  console.log("ARTICLE ready:", cat.article && `${cat.article.ready}/${cat.article.mode}`);
  const catalogOk = cat.count >= 40 && cat.sdu.ready === true && cat.anu.ready === true &&
    typeof cat.thu.ready === "boolean" && cat.article.ready === true;

  // 2) create-from-marketplace: pkuthss (builtin) -> real copy + open
  const created = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    try {
      const dir = await api.createFromMarketTemplate(${JSON.stringify(PROJ)}, 'pku-test', 'pkuthss');
      return JSON.stringify({ dir });
    } catch (e) {
      return JSON.stringify({ err: String(e) });
    }
  })()`));
  console.log("CREATE result:", JSON.stringify(created));
  let createOk = false;
  if (created.dir) {
    await exec(`(async () => {
      const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
      const projectUrl = [...resources].reverse().find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
        ?? '/src/store/projectStore.ts';
      const { useProjectStore } = await import(projectUrl);
      await useProjectStore.getState().openProject(${JSON.stringify(created.dir)});
      await new Promise((r) => setTimeout(r, 600));
      const st = useProjectStore.getState();
      return JSON.stringify({ mainFile: st.mainFile });
    })()`);
    const hasPkuTex = existsSync(PROJ + "/pku-test/doc/example/thesis.tex");
    console.log("CREATE thesis.tex on disk:", hasPkuTex);
    createOk = !!created.dir && hasPkuTex;
  }

  // 3) download-on-demand: thuthesis (8.4MB, real GitHub codeload)
  const dl = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    try {
      const dir = await api.downloadTemplate('thuthesis');
      return JSON.stringify({ ok: true, dir });
    } catch (e) {
      return JSON.stringify({ ok: false, err: String(e) });
    }
  })()`));
  console.log("DOWNLOAD ok:", dl.ok, dl.dir || dl.err);
  let dlOk = false;
  if (dl.ok && dl.dir) {
    const root = dl.dir.replace(/\\\\/g, "/");
    const hasMain = existsSync(root + "/thuthesis-example.tex") || existsSync(root + "/main.tex");
    console.log("DOWNLOAD has main:", hasMain);
    dlOk = hasMain;
  }

  // 4) UI: open the new-project modal and check the marketplace tab renders
  const ui = JSON.parse(await exec(`(async () => {
    const toolbarButton = document.querySelector('.toolbar-new-file');
    if (!toolbarButton) return JSON.stringify({ modal: false });
    toolbarButton.click();
    for (let attempt = 0; attempt < 50 && !document.querySelector('.new-file-modal'); attempt += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!document.querySelector('.new-file-modal')) return JSON.stringify({ modal: false });
    const tabs = [...document.querySelectorAll('[data-new-file-tab]')].map((b) => b.dataset.newFileTab);
    const marketBtn = document.querySelector('[data-new-file-tab="market"]');
    if (marketBtn) marketBtn.click();
    for (let attempt = 0; attempt < 100 && document.querySelectorAll('.market-card').length === 0; attempt += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // clear any residual search filter (the modal keeps state between
    // open/close cycles) so we count the full unfiltered list
    const searchReset = document.querySelector('.market-search');
    if (searchReset) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(searchReset, '');
      searchReset.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
    }
    const cards = document.querySelectorAll('.market-card').length;
    // debug: what does the backend return vs what rendered?
    const { api } = await import('/src/api/index.ts');
    const fullList = await api.listMarketTemplates();
    const search = document.querySelector('.market-search');
    let searchHits = 0;
    if (search) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(search, '山东');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      searchHits = document.querySelectorAll('.market-card').length;
    }
    const closeBtn = document.querySelector('.new-file-modal .modal-header button');
    closeBtn && closeBtn.click();
    await new Promise((r) => setTimeout(r, 100));
    document.querySelector('.project-tree .panel-actions button:nth-child(2)')?.click();
    await new Promise((r) => setTimeout(r, 100));
    const newProjectHasMarketTabs = !!document.querySelector('.new-project-modal .market-tabs');
    document.querySelector('.new-project-modal .modal-header button')?.click();
    return JSON.stringify({ modal: true, tabs, cards, searchHits, fullListCount: fullList.length, newProjectHasMarketTabs });
  })()`));
  console.log("UI tabs:", JSON.stringify(ui.tabs), "| cards:", ui.cards, "| search hits:", ui.searchHits, "| fullList:", ui.fullListCount, "| names:", JSON.stringify(ui.cardNames), "| modals:", ui.otherModals);
  const uiOk = ui.modal === true
    && JSON.stringify(ui.tabs) === JSON.stringify(['basic', 'user', 'market'])
    && ui.cards > 0
    && ui.searchHits >= 1
    && ui.newProjectHasMarketTabs === false;
  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = catalogOk && createOk && dlOk && uiOk;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL");
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
