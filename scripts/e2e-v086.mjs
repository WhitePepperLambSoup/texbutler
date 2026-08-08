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

    const pressEscape = async () => {
      const event = {
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      };
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
    };

    const pointerClick = async (point) => {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      });
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
      const theme = layout.theme ?? "dark";
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
        localStorage.setItem('tb-theme', ${JSON.stringify(theme)});
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
        result.naturalPopoverSemantics = JSON.parse(await exec(`(async () => {
          document.querySelector('.ai-menu-anchor > button')?.click();
          await new Promise((resolve) => setTimeout(resolve, 30));
          const menu = document.querySelector('.ai-menu');
          return JSON.stringify(!!menu
            && !menu.hasAttribute('role')
            && menu.querySelectorAll('[role="menuitem"]').length === 0);
        })()`));
        const escapePrepared = JSON.parse(await exec(`(() => {
          const control = document.querySelector('.ai-menu button:not(:disabled)');
          control?.focus();
          return JSON.stringify({
            menuOpen: !!document.querySelector('.ai-menu'),
            controlFocused: document.activeElement === control,
          });
        })()`));
        await pressEscape();
        await sleep(40);
        const escapeResult = JSON.parse(await exec(`JSON.stringify({
          menuClosed: !document.querySelector('.ai-menu'),
          triggerFocused: document.activeElement === document.querySelector('.ai-menu-anchor > button'),
        })`));
        result.escapeRestoresTriggerFocus = escapePrepared.menuOpen
          && escapePrepared.controlFocused
          && escapeResult.menuClosed
          && escapeResult.triggerFocused;

        await exec(`document.querySelector('.ai-menu-anchor > button')?.click()`);
        await sleep(40);
        const outsidePoint = JSON.parse(await exec(`(() => {
          const target = document.querySelector('.ai-generate-input');
          const rect = target?.getBoundingClientRect();
          return JSON.stringify(rect ? {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          } : null);
        })()`));
        if (outsidePoint) {
          await pointerClick(outsidePoint);
          await sleep(40);
        }
        result.outsidePointerPreservesFocus = !!outsidePoint && JSON.parse(await exec(`JSON.stringify(
          !document.querySelector('.ai-menu')
          && document.activeElement === document.querySelector('.ai-generate-input')
        )`));
        const caseOk = Object.entries(result)
          .filter(([, value]) => typeof value === "boolean")
          .every(([, value]) => value === true);
        console.log(`AI ${testCase.width}x${testCase.height} rail=${testCase.aiWidth}:`, JSON.stringify(result));
        ok = ok && caseOk;
      }
      return ok;
    };

    const runEditor = async () => {
      await loadCase(1280, 800, 300, true, false, { treeWidth: 284, pdfWidth: 520, bottomHeight: 400 });
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
          targetEditorWidth: !!editorRect && editorRect.width >= 150 && editorRect.width <= 160,
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
        const menuClientWidth = menu.clientWidth;
        const menuScrollWidth = menu.scrollWidth;
        const menuClientHeight = menu.clientHeight;
        const menuScrollHeight = menu.scrollHeight;
        const symbolTrigger = menu.querySelector('.format-buttons > .btn-mini:last-child');
        symbolTrigger?.scrollIntoView({ block: 'nearest' });
        const symbolTriggerRect = symbolTrigger?.getBoundingClientRect();
        return JSON.stringify({
          exists: true,
          insideEditor: menuRect.left >= editorRect.left && menuRect.right <= editorRect.right && menuRect.bottom <= editorRect.bottom,
          horizontalFits: menuScrollWidth <= menuClientWidth + 1,
          scrollCapacity: menuScrollHeight >= menuClientHeight,
          scrollOverflow: menuScrollHeight > menuClientHeight,
          menuClientWidth,
          menuScrollWidth,
          menuClientHeight,
          menuScrollHeight,
          naturalPopoverSemantics: !menu.hasAttribute('role') && menu.querySelectorAll('[role="menuitem"]').length === 0,
          symbolTriggerPoint: symbolTriggerRect ? {
            x: symbolTriggerRect.left + symbolTriggerRect.width / 2,
            y: symbolTriggerRect.top + symbolTriggerRect.height / 2,
          } : null,
          controlCount: menu.querySelectorAll('button, select').length,
        });
      })()`));

      let picker = {
        opened: false,
        containedByMenu: false,
        insideMenuHorizontally: false,
        insideEditorHorizontally: false,
        horizontalFits: false,
        stayedOpenOnPointerDown: false,
        insertedThroughPointer: false,
        clearedOnMenuClose: false,
      };
      if (menu.symbolTriggerPoint) {
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: menu.symbolTriggerPoint.x,
          y: menu.symbolTriggerPoint.y,
        });
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: menu.symbolTriggerPoint.x,
          y: menu.symbolTriggerPoint.y,
          button: 'left',
          clickCount: 1,
        });
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: menu.symbolTriggerPoint.x,
          y: menu.symbolTriggerPoint.y,
          button: 'left',
          clickCount: 1,
        });
        await sleep(50);

        picker = JSON.parse(await exec(`(async () => {
          const menu = document.querySelector('.editor-tools-menu');
          const panel = document.querySelector('.symbol-panel');
          const editor = document.querySelector('.col-editor');
          const firstSymbol = panel?.querySelector('.symbol-btn');
          firstSymbol?.scrollIntoView({ block: 'nearest' });
          const menuRect = menu?.getBoundingClientRect();
          const panelRect = panel?.getBoundingClientRect();
          const editorRect = editor?.getBoundingClientRect();
          const symbolRect = firstSymbol?.getBoundingClientRect();
          const { useProjectStore } = await import('/src/store/projectStore.ts');
          const state = useProjectStore.getState();
          const beforeContent = state.tabs.find((tab) => tab.path === state.activeTab)?.content ?? null;
          return JSON.stringify({
            opened: !!panel,
            containedByMenu: !!menu && !!panel && menu.contains(panel),
            insideMenuHorizontally: !!menuRect && !!panelRect && panelRect.left >= menuRect.left && panelRect.right <= menuRect.right,
            insideEditorHorizontally: !!editorRect && !!panelRect && panelRect.left >= editorRect.left && panelRect.right <= editorRect.right,
            horizontalFits: !!panel && panel.scrollWidth <= panel.clientWidth + 1,
            symbolPoint: symbolRect ? {
              x: symbolRect.left + symbolRect.width / 2,
              y: symbolRect.top + symbolRect.height / 2,
            } : null,
            symbolText: firstSymbol?.textContent ?? null,
            beforeContent,
          });
        })()`));

        if (picker.symbolPoint) {
          await client.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: picker.symbolPoint.x,
            y: picker.symbolPoint.y,
          });
          await client.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: picker.symbolPoint.x,
            y: picker.symbolPoint.y,
            button: 'left',
            clickCount: 1,
          });
          await sleep(30);
          picker.stayedOpenOnPointerDown = JSON.parse(await exec(`JSON.stringify({
            menu: !!document.querySelector('.editor-tools-menu'),
            picker: !!document.querySelector('.symbol-panel'),
          })`));
          picker.stayedOpenOnPointerDown = picker.stayedOpenOnPointerDown.menu && picker.stayedOpenOnPointerDown.picker;
          await client.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: picker.symbolPoint.x,
            y: picker.symbolPoint.y,
            button: 'left',
            clickCount: 1,
          });
          await sleep(80);
          const afterPointer = JSON.parse(await exec(`(async () => {
            const { useProjectStore } = await import('/src/store/projectStore.ts');
            const state = useProjectStore.getState();
            const content = state.tabs.find((tab) => tab.path === state.activeTab)?.content ?? null;
            return JSON.stringify({
              content,
              menuOpen: !!document.querySelector('.editor-tools-menu'),
              pickerOpen: !!document.querySelector('.symbol-panel'),
            });
          })()`));
          picker.insertedThroughPointer = typeof picker.beforeContent === 'string'
            && typeof afterPointer.content === 'string'
            && typeof picker.symbolText === 'string'
            && afterPointer.content.length === picker.beforeContent.length + picker.symbolText.length
            && afterPointer.content.includes(picker.symbolText);

          if (afterPointer.menuOpen && afterPointer.pickerOpen) {
            await exec(`document.querySelector('.editor-more-action')?.click()`);
            await sleep(40);
            picker.clearedOnMenuClose = JSON.parse(await exec(`JSON.stringify({
              menuClosed: !document.querySelector('.editor-tools-menu'),
              pickerClosed: !document.querySelector('.symbol-panel'),
            })`));
            picker.clearedOnMenuClose = picker.clearedOnMenuClose.menuClosed && picker.clearedOnMenuClose.pickerClosed;
          }
        }
      }

      const focus = {
        escapeRestoresTriggerFocus: false,
        escapeClosesSymbolPicker: false,
        outsidePointerPreservesFocus: false,
      };
      await exec(`document.querySelector('.editor-more-action')?.click()`);
      await sleep(40);
      await exec(`document.querySelector('.editor-tools-menu .format-buttons > .btn-mini:last-child')?.click()`);
      await sleep(40);
      const escapePrepared = JSON.parse(await exec(`(() => {
        const control = document.querySelector('.symbol-panel .symbol-btn');
        control?.scrollIntoView({ block: 'nearest' });
        control?.focus();
        return JSON.stringify({
          menuOpen: !!document.querySelector('.editor-tools-menu'),
          pickerOpen: !!document.querySelector('.symbol-panel'),
          controlFocused: document.activeElement === control,
        });
      })()`));
      await pressEscape();
      await sleep(40);
      const escapeResult = JSON.parse(await exec(`JSON.stringify({
        menuClosed: !document.querySelector('.editor-tools-menu'),
        pickerClosed: !document.querySelector('.symbol-panel'),
        triggerFocused: document.activeElement === document.querySelector('.editor-more-action'),
      })`));
      focus.escapeRestoresTriggerFocus = escapePrepared.menuOpen
        && escapePrepared.controlFocused
        && escapeResult.menuClosed
        && escapeResult.triggerFocused;
      focus.escapeClosesSymbolPicker = escapePrepared.pickerOpen && escapeResult.pickerClosed;

      await exec(`document.querySelector('.editor-more-action')?.click()`);
      await sleep(40);
      const outsidePoint = JSON.parse(await exec(`(() => {
        document.querySelector('.editor-tools-menu .btn-mini:not(:disabled)')?.focus();
        const editor = document.querySelector('.monaco-editor');
        const rect = editor?.getBoundingClientRect();
        return JSON.stringify(rect ? {
          x: rect.left + rect.width / 2,
          y: rect.bottom - 8,
        } : null);
      })()`));
      if (outsidePoint) {
        await pointerClick(outsidePoint);
        await sleep(40);
      }
      focus.outsidePointerPreservesFocus = !!outsidePoint && JSON.parse(await exec(`JSON.stringify(
        !document.querySelector('.editor-tools-menu')
        && !document.querySelector('.symbol-panel')
        && !!document.activeElement?.closest('.monaco-editor')
        && document.activeElement !== document.querySelector('.editor-more-action')
      )`));

      console.log("EDITOR primary:", JSON.stringify(primary));
      console.log("EDITOR menu:", JSON.stringify(menu));
      console.log("EDITOR picker:", JSON.stringify(picker));
      console.log("EDITOR focus:", JSON.stringify(focus));
      return primary.headerFits
        && primary.primaryVisible
        && primary.pdfVisible
        && primary.narrowEditor
        && primary.targetEditorWidth
        && menu.exists
        && menu.insideEditor
        && menu.horizontalFits
        && menu.scrollCapacity
        && menu.scrollOverflow
        && menu.naturalPopoverSemantics
        && menu.controlCount >= 12
        && picker.opened
        && picker.containedByMenu
        && picker.insideMenuHorizontally
        && picker.insideEditorHorizontally
        && picker.horizontalFits
        && picker.stayedOpenOnPointerDown
        && picker.insertedThroughPointer
        && picker.clearedOnMenuClose
        && focus.escapeRestoresTriggerFocus
        && focus.escapeClosesSymbolPicker
        && focus.outsidePointerPreservesFocus;
    };

    const runLightContrast = async () => {
      await loadCase(1280, 800, 300, false, false, { theme: "light" });
      await exec(`document.querySelector('.editor-more-action')?.click()`);
      await sleep(40);
      const hoverTarget = JSON.parse(await exec(`(() => {
        const button = document.querySelector('.editor-tools-menu .btn-mini:not(:disabled)');
        button?.scrollIntoView({ block: 'nearest' });
        const rect = button?.getBoundingClientRect();
        return JSON.stringify(rect ? {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        } : null);
      })()`));
      if (hoverTarget) {
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: hoverTarget.x,
          y: hoverTarget.y,
        });
        await sleep(80);
      }
      const result = JSON.parse(await exec(`(() => {
        const parseColor = (value) => {
          const parts = value.match(/[\\d.]+/g)?.map(Number);
          if (!parts || parts.length < 3) return null;
          return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
        };
        const luminance = (color) => {
          const channel = (value) => {
            const normalized = value / 255;
            return normalized <= 0.04045
              ? normalized / 12.92
              : ((normalized + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
        };
        const opaqueBackground = (element) => {
          for (let current = element; current; current = current.parentElement) {
            const background = parseColor(getComputedStyle(current).backgroundColor);
            if (background?.a === 1) return background;
          }
          return null;
        };
        const contrast = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return { exists: false, ratio: 0 };
          const foreground = parseColor(getComputedStyle(element).color);
          const background = opaqueBackground(element);
          if (!foreground || !background) return { exists: false, ratio: 0 };
          const fg = luminance(foreground);
          const bg = luminance(background);
          return { exists: true, ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) };
        };
        const checks = {
          brand: contrast('.brand'),
          activeTab: contrast('.tab-active'),
          treeTabDim: contrast('.tree-tab:not(.active)'),
          panelTitleDim: contrast('.panel-title'),
          toolbarRootDim: contrast('.toolbar-root'),
          activeMainTag: contrast('.tree-active .tree-main-tag'),
          hoveredEditorMenuButton: {
            ...contrast('.editor-tools-menu .btn-mini:not(:disabled)'),
            hovered: !!document.querySelector('.editor-tools-menu .btn-mini:not(:disabled)')?.matches(':hover'),
          },
        };
        return JSON.stringify(checks);
      })()`));
      const ok = Object.values(result).every((check) => check.exists && check.ratio >= 4.5 && check.hovered !== false);
      console.log("LIGHT contrast:", JSON.stringify(result));
      return ok;
    };

    const aiOk = suite === "editor" ? true : await runAi();
    const editorLayoutOk = suite === "ai" ? true : await runEditor();
    const lightContrastOk = suite === "ai" ? true : await runLightContrast();
    const editorOk = editorLayoutOk && lightContrastOk;
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
