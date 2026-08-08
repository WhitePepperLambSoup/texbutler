// e2e: responsive workspace internals — AI header/composer/suggestions and
// editor toolbar must stay usable inside their owning panels.
import { writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/.worktrees/codex-fix-ui-ai-layout/assets/e2e/v086-check";
const FILE = `${PROJ}/main.tex`;
const PDF_DIR = `${PROJ}/.texbutler/build`;
const PDF = `${PDF_DIR}/main.pdf`;
const suite = process.argv[2] ?? "all";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!new Set(["ai", "editor", "all"]).has(suite)) {
  throw new Error(`unknown suite: ${suite}`);
}

async function cdp() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // The Tauri window may still be starting.
    }
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
          const messageId = ++id;
          pending.set(messageId, { res, rej });
          ws.send(JSON.stringify({ id: messageId, method, params }));
        });
      },
      close: () => ws.close(),
    });
    ws.onerror = reject;
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        waiter.rej(new Error(JSON.stringify(message.error)));
      } else {
        waiter.res(message.result);
      }
    };
  });
}

async function main() {
  const tex = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Responsive layout test.",
    "\\end{document}",
    "",
  ].join("\n");
  let client;
  let failed = false;

  try {
    await rm(PROJ, { recursive: true, force: true }).catch(() => {});
    await mkdir(PROJ, { recursive: true });
    await writeFile(FILE, tex, "utf8");

    client = await connect(await cdp());
    await client.send("Runtime.enable");

    const exec = async (expression) => {
      const result = await client.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(`JS: ${JSON.stringify(result.exceptionDetails)}`);
      }
      return result.result.value;
    };

    const loadCase = async (width, height, aiWidth, withPdf, withSuggestion, layout = {}) => {
      if (withPdf) {
        await mkdir(PDF_DIR, { recursive: true });
        await writeFile(PDF, "%PDF-1.4\n%%EOF\n", "utf8");
      } else {
        await rm(PDF, { force: true });
      }
      const treeWidth = layout.treeWidth ?? 220;
      const pdfStorage = withPdf
        ? `localStorage.setItem('tb-pdf-w', ${layout.pdfWidth ?? 520});`
        : "localStorage.removeItem('tb-pdf-w');";
      const bottomStorage = layout.bottomHeight != null
        ? `localStorage.setItem('tb-bottom-h', ${layout.bottomHeight});`
        : "localStorage.removeItem('tb-bottom-h');";
      await client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await exec(`(() => {
        localStorage.setItem('tb-ai-rail', '1');
        localStorage.setItem('tb-ai-w', ${aiWidth});
        localStorage.setItem('tb-ai-sessions', '[]');
        localStorage.setItem('tb-ai-file-sessions', '{}');
        localStorage.setItem('tb-tree-w', ${treeWidth});
        ${pdfStorage}
        ${bottomStorage}
        return true;
      })()`);
      await client.send("Page.reload", { ignoreCache: true });
      await sleep(2200);
      await exec(`(async () => {
        const { useProjectStore } = await import('/src/store/projectStore.ts');
        const { useAiStore } = await import('/src/store/aiStore.ts');
        await useProjectStore.getState().openProject(${JSON.stringify(PROJ)});
        await useProjectStore.getState().openFile('main.tex');
        const messages = [
          { id: 8601, role: 'user', kind: 'plain', text: '请检查当前论证结构并给出修改建议。' },
          { id: 8602, role: 'assistant', kind: 'plain', text: '先明确研究问题，再说明方法与证据，最后收束结论。\\n术语需要保持一致。' },
          { id: 8603, role: 'user', kind: 'plain', text: '请给出更具体的修改顺序。' },
          { id: 8604, role: 'assistant', kind: 'plain', text: '建议按背景、问题、方法、结果、贡献的顺序重组段落。' },
        ];
        useAiStore.setState({
          messages,
          sessions: [],
          sessionId: null,
          activeFile: 'chapters/very-long-methodology-section.tex',
          busy: false,
          diffPending: ${withSuggestion ? `{
            ok: true,
            rounds: 2,
            summary: '建议修改',
            issues_after: [],
            rolled_back: false,
            suggested: true,
            hunks: [
              { file: 'main.tex', line: 12, old: '旧段落', new: '新段落', why: '收紧论证' },
              { file: 'main.tex', line: 28, old: '旧术语', new: '统一术语', why: '保持一致' },
            ],
          }` : "null"},
        });
        return true;
      })()`);
      await sleep(600);
    };

    const measureAi = async () => JSON.parse(await exec(`(() => {
      const q = (selector) => document.querySelector(selector);
      const header = q('.ai-header') ?? q('.ai-panel > .panel-header');
      const panel = q('.ai-panel');
      const body = q('.ai-body');
      const row = q('.ai-chat-row');
      const input = q('.ai-generate-input');
      const send = q('.ai-send-action') ?? row?.querySelector('button');
      const diff = q('.ai-diff-bar');
      const hunks = q('.ai-hunks');
      const rail = q('.ai-rail');
      const panelRect = panel?.getBoundingClientRect();
      const inputRect = input?.getBoundingClientRect();
      const rowRect = row?.getBoundingClientRect();
      const sendRect = send?.getBoundingClientRect();
      return JSON.stringify({
        headerFits: !!header && header.scrollWidth <= header.clientWidth + 1,
        panelFits: !!panel && panel.scrollWidth <= panel.clientWidth + 1,
        bodyUsable: !!body && body.getBoundingClientRect().height >= 160,
        inputFillsRow: !!inputRect && !!rowRect && !!sendRect && inputRect.width >= rowRect.width - sendRect.width - 18,
        composerInside: !!panelRect && !!inputRect && !!sendRect && inputRect.left >= panelRect.left && sendRect.right <= panelRect.right,
        supplementalInBody: !diff || (!!body && body.contains(diff) && !!hunks && body.contains(hunks)),
        bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : -1,
        inputWidth: inputRect ? Math.round(inputRect.width) : -1,
        rowWidth: rowRect ? Math.round(rowRect.width) : -1,
        headerClientWidth: header?.clientWidth ?? -1,
        headerScrollWidth: header?.scrollWidth ?? -1,
        viewportWidth: window.innerWidth,
        railClass: rail?.className ?? null,
        errorText: q('.error-boundary')?.textContent ?? null,
      });
    })()`));

    const runAi = async () => {
      const cases = [
        { width: 960, height: 700, aiWidth: 240, withSuggestion: true },
        { width: 1280, height: 800, aiWidth: 300, withSuggestion: false },
        { width: 1600, height: 900, aiWidth: 520, withSuggestion: false },
      ];
      let ok = true;
      for (const testCase of cases) {
        await loadCase(testCase.width, testCase.height, testCase.aiWidth, false, testCase.withSuggestion);
        const result = await measureAi();
        const caseOk = Object.entries(result)
          .filter(([, value]) => typeof value === "boolean")
          .every(([, value]) => value === true);
        console.log(`AI ${testCase.width}x${testCase.height} rail=${testCase.aiWidth}:`, JSON.stringify(result));
        ok = ok && caseOk;
      }
      return ok;
    };

    const runEditor = async () => {
      await loadCase(1280, 800, 300, true, false, { treeWidth: 220, pdfWidth: 520, bottomHeight: 400 });
      const primary = JSON.parse(await exec(`(() => {
        const editor = document.querySelector('.col-editor');
        const header = document.querySelector('.editor-header') ?? editor?.querySelector('.panel-header');
        const pdf = document.querySelector('.col-pdf');
        const editorRect = editor?.getBoundingClientRect();
        const pdfRect = pdf?.getBoundingClientRect();
        const actions = ['.editor-save-action', '.editor-ask-ai-action', '.editor-more-action']
          .map((selector) => document.querySelector(selector));
        return JSON.stringify({
          headerFits: !!header && header.scrollWidth <= header.clientWidth + 1,
          primaryVisible: !!editorRect && actions.every((element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            return rect.left >= editorRect.left && rect.right <= editorRect.right;
          }),
          pdfVisible: !!pdfRect && pdfRect.width >= 500,
          narrowEditor: !!editorRect && editorRect.width <= 220,
          editorWidth: editorRect ? Math.round(editorRect.width) : -1,
          pdfWidth: pdfRect ? Math.round(pdfRect.width) : -1,
          headerClientWidth: header?.clientWidth ?? -1,
          headerScrollWidth: header?.scrollWidth ?? -1,
        });
      })()`));

      const menu = JSON.parse(await exec(`(async () => {
        const button = document.querySelector('.editor-more-action');
        if (!button) return JSON.stringify({ exists: false });
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 120));
        const editor = document.querySelector('.col-editor');
        const menu = document.querySelector('.editor-tools-menu');
        if (!editor || !menu) return JSON.stringify({ exists: false });
        const editorRect = editor.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const menuClientHeight = menu.clientHeight;
        const menuScrollHeight = menu.scrollHeight;
        const symbolTrigger = menu.querySelector('.format-buttons > .btn-mini:last-child');
        symbolTrigger?.click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        const symbolOpened = !!document.querySelector('.symbol-panel');
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        return JSON.stringify({
          exists: true,
          insideEditor: menuRect.left >= editorRect.left && menuRect.right <= editorRect.right && menuRect.bottom <= editorRect.bottom,
          scrollCapacity: menuScrollHeight >= menuClientHeight,
          scrollOverflow: menuScrollHeight > menuClientHeight,
          menuClientHeight,
          menuScrollHeight,
          symbolOpened,
          symbolClearedOnClose: !document.querySelector('.editor-tools-menu') && !document.querySelector('.symbol-panel'),
          controlCount: menu.querySelectorAll('button, select').length,
        });
      })()`));

      console.log("EDITOR primary:", JSON.stringify(primary));
      console.log("EDITOR menu:", JSON.stringify(menu));
      return primary.headerFits
        && primary.primaryVisible
        && primary.pdfVisible
        && primary.narrowEditor
        && menu.exists
        && menu.insideEditor
        && menu.scrollCapacity
        && menu.scrollOverflow
        && menu.symbolOpened
        && menu.symbolClearedOnClose
        && menu.controlCount >= 12;
    };

    const aiOk = suite === "editor" ? true : await runAi();
    const editorOk = suite === "ai" ? true : await runEditor();
    failed = !(aiOk && editorOk);
    console.log("E2E-DONE", failed ? "FAIL" : "PASS", { suite, aiOk, editorOk });
  } finally {
    if (client) {
      await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      client.close();
    }
    await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  }

  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("E2E-FAIL", error);
  process.exit(1);
});
