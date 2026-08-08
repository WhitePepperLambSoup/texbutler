// e2e: v0.8.7 new-file workflow — toolbar/tree parity and template center.
import { writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/.worktrees/codex-fix-ui-ai-layout/assets/e2e/v087-check";
const FILE = `${PROJ}/main.tex`;
const suite = process.argv[2] ?? "all";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!new Set(["files", "theme", "pdf", "all"]).has(suite)) {
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
      message.error ? waiter.rej(new Error(JSON.stringify(message.error))) : waiter.res(message.result);
    };
  });
}

async function main() {
  let client;
  let exec;
  let files = true;
  let theme = true;
  let failed = false;
  let inspectLocale;
  let setLocale;
  let localeBefore;
  let localeAfter;
  let testLocaleBaseline;
  try {
    await rm(PROJ, { recursive: true, force: true }).catch(() => {});
    await mkdir(PROJ, { recursive: true });
    await writeFile(FILE, "\\documentclass{article}\n\\begin{document}\nE2E fixture.\n\\end{document}\n", "utf8");

    client = await connect(await cdp());
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.send("Page.reload", { ignoreCache: true });
    await sleep(1200);
    exec = async (expression) => {
      const result = await client.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(`JS: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result.value;
    };
    inspectLocale = async () => JSON.parse(await exec(`(async () => {
      const i18nUrl = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => new URL(name).pathname.endsWith('/src/i18n/index.ts') && new URL(name).search)
        ?? '/src/i18n/index.ts';
      const { useI18n } = await import(i18nUrl);
      const storedLang = window.localStorage.getItem('tb-lang');
      return JSON.stringify({
        lang: useI18n.getState().lang,
        hasStoredLang: storedLang !== null,
        storedLang,
      });
    })()`));
    setLocale = async (lang) => exec(`(async () => {
      const i18nUrl = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => new URL(name).pathname.endsWith('/src/i18n/index.ts') && new URL(name).search)
        ?? '/src/i18n/index.ts';
      const { useI18n } = await import(i18nUrl);
      useI18n.getState().setLang(${JSON.stringify(lang)});
      return true;
    })()`);
    const pressEscape = async () => {
      const event = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    };
    const pointerClick = async (point) => {
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    };
    const clickSelector = async (selector) => {
      const point = JSON.parse(await exec(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
        return JSON.stringify(rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null);
      })()`));
      if (!point) return false;
      await pointerClick(point);
      await sleep(100);
      return true;
    };

    await exec(`(async () => {
      const storeUrl = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
        ?? '/src/store/projectStore.ts';
      const { useProjectStore } = await import(storeUrl);
      await useProjectStore.getState().openProject(${JSON.stringify(PROJ)});
      await useProjectStore.getState().openFile('main.tex');
      return true;
    })()`);
    await sleep(350);
    if (suite !== "theme" && suite !== "pdf") {
      localeBefore = await inspectLocale();
      testLocaleBaseline = localeBefore.lang === "en" ? "zh" : "en";
      await setLocale(testLocaleBaseline);
    }

    const runFiles = async () => {
      const result = {
        toolbarEntryOpensNewFile: false,
        treeEntryOpensNewFile: false,
        sameModalContract: false,
        tabs: [],
        basicHasSixSeeds: false,
        importTargetGuidance: { en: false, zh: false },
        newProjectHasNoTemplateTabs: false,
        newProjectHasParentAndNameOnly: false,
      };
      if (await exec(`document.querySelector('.modal') ? '.modal-header button' : null`)) {
        await clickSelector('.modal-header button');
      }
      const toolbarSelector = await exec(`(async () => {
        const direct = document.querySelector('.toolbar-new-file');
        if (direct) return '.toolbar-new-file';
        const i18nUrl = performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => new URL(name).pathname.endsWith('/src/i18n/index.ts') && new URL(name).search)
          ?? '/src/i18n/index.ts';
        const { useI18n } = await import(i18nUrl);
        const title = useI18n.getState().t('tree.newFile');
        const button = [...document.querySelectorAll('.toolbar button')].find((candidate) => candidate.title === title);
        if (!button) return null;
        button.dataset.e2eNewFileFallback = 'true';
        return '[data-e2e-new-file-fallback="true"]';
      })()`);
      const toolbarClicked = toolbarSelector ? await clickSelector(toolbarSelector) : false;
      result.toolbarEntryOpensNewFile = toolbarClicked && JSON.parse(await exec(`JSON.stringify(!!document.querySelector('.new-file-modal'))`));
      if (result.toolbarEntryOpensNewFile) await clickSelector('[data-new-file-tab="basic"]');
      const toolbarContract = JSON.parse(await exec(`JSON.stringify({
        tabs: [...document.querySelectorAll('[data-new-file-tab]')].map((button) => button.dataset.newFileTab),
        basicSeeds: document.querySelectorAll('.new-file-modal .template-card').length,
      })`));
      result.tabs = toolbarContract.tabs;
      result.basicHasSixSeeds = toolbarContract.basicSeeds === 6;
      await clickSelector('[data-new-file-tab="user"]');
      const importTargetGuidance = async (lang) => {
        await setLocale(lang);
        await sleep(80);
        return JSON.parse(await exec(`JSON.stringify(
          document.querySelector('.new-file-modal .new-file-panel label.target-row')?.textContent?.trim() ?? ''
        )`));
      };
      const englishTargetGuidance = await importTargetGuidance("en");
      const chineseTargetGuidance = await importTargetGuidance("zh");
      result.importTargetGuidance = {
        en: /project-relative/i.test(englishTargetGuidance) && !/absolute/i.test(englishTargetGuidance),
        zh: /项目相对/.test(chineseTargetGuidance) && !/绝对路径/.test(chineseTargetGuidance),
      };
      await clickSelector('[data-new-file-tab="basic"]');
      await pressEscape();
      await sleep(80);
      if (await exec(`document.querySelector('.modal') ? '.modal-header button' : null`)) await clickSelector('.modal-header button');
      const treeClicked = await clickSelector(".tree-new-file");
      result.treeEntryOpensNewFile = treeClicked && JSON.parse(await exec(`JSON.stringify(!!document.querySelector('.new-file-modal'))`));
      const treeContract = JSON.parse(await exec(`JSON.stringify({
        tabs: [...document.querySelectorAll('[data-new-file-tab]')].map((button) => button.dataset.newFileTab),
        basicSeeds: document.querySelectorAll('.new-file-modal .template-card').length,
      })`));
      result.sameModalContract = result.toolbarEntryOpensNewFile
        && result.treeEntryOpensNewFile
        && JSON.stringify(toolbarContract) === JSON.stringify(treeContract);
      await pressEscape();
      await sleep(80);
      if (await exec(`document.querySelector('.modal') ? '.modal-header button' : null`)) await clickSelector('.modal-header button');
      await clickSelector(".project-tree .panel-actions button:nth-child(2)");
      const projectContract = JSON.parse(await exec(`JSON.stringify({
        hasModal: !!document.querySelector('.new-project-modal'),
        hasMarketTabs: !!document.querySelector('.new-project-modal .market-tabs'),
        fields: document.querySelectorAll('.new-project-modal .modal-body input').length,
      })`));
      result.newProjectHasNoTemplateTabs = projectContract.hasModal && !projectContract.hasMarketTabs;
      result.newProjectHasParentAndNameOnly = projectContract.hasModal && projectContract.fields === 2;
      if (await exec(`document.querySelector('.modal') ? '.modal-header button' : null`)) {
        await clickSelector('.modal-header button');
      }
      return result;
    };

    const runTheme = async () => {
      const result = {
        widths: {},
        moreMenuHasSecondaryActions: false,
        themeSelections: { liquid: false, dark: false, light: false },
        outsidePointerPreservesFocus: false,
        escapeRestoresTriggerFocus: false,
        menuHitTest: false,
      };
      const setViewport = async (width, height) => {
        await client.send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await sleep(100);
      };
      const inspectToolbar = async () => JSON.parse(await exec(`(() => {
        const insideViewport = (selector) => {
          const node = document.querySelector(selector);
          if (!node) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0
            && rect.left >= 0 && rect.top >= 0
            && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1;
        };
        const toolbar = document.querySelector('.toolbar');
        return JSON.stringify({
          toolbarFits: !!toolbar && toolbar.scrollWidth <= toolbar.clientWidth + 1,
          compileVisible: insideViewport('.toolbar-compile'),
          newFileVisible: insideViewport('.toolbar-new-file'),
          themeVisible: insideViewport('.theme-picker-btn'),
          moreVisible: insideViewport('.toolbar-more-btn'),
          settingsVisible: insideViewport('.toolbar-settings'),
        });
      })()`));

      for (const [width, height] of [[940, 700], [1280, 800]]) {
        await setViewport(width, height);
        result.widths[`${width}x${height}`] = await inspectToolbar();
      }

      await setViewport(940, 700);
      if (await clickSelector('.toolbar-more-btn')) {
        const menu = JSON.parse(await exec(`JSON.stringify({
          word: !!document.querySelector('.toolbar-more-menu .toolbar-word-import'),
          markdown: !!document.querySelector('.toolbar-more-menu .toolbar-export-md'),
          docx: !!document.querySelector('.toolbar-more-menu .toolbar-export-docx'),
        })`));
        result.moreMenuHasSecondaryActions = menu.word && menu.markdown && menu.docx;
      }

      await setViewport(1280, 800);
      for (const [id, index] of [["liquid", 1], ["dark", 2], ["light", 3]]) {
        if (!await clickSelector('.theme-picker-btn')) continue;
        if (!await clickSelector(`.theme-picker-menu .theme-option:nth-child(${index})`)) continue;
        result.themeSelections[id] = JSON.parse(await exec(`JSON.stringify(
          document.documentElement.dataset.theme === ${JSON.stringify(id)}
            && window.localStorage.getItem('tb-theme') === ${JSON.stringify(id)}
        )`));
      }

      if (await clickSelector('.theme-picker-btn')) {
        const editorPoint = JSON.parse(await exec(`(() => {
          const rect = document.querySelector('.monaco-editor')?.getBoundingClientRect();
          return JSON.stringify(rect ? {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          } : null);
        })()`));
        if (editorPoint) await pointerClick(editorPoint);
        result.outsidePointerPreservesFocus = JSON.parse(await exec(`JSON.stringify(
          !document.querySelector('.theme-picker-menu')
            && !!document.activeElement?.closest('.monaco-editor')
        )`));
      }

      if (await clickSelector('.theme-picker-btn')) {
        await exec(`document.querySelector('.theme-picker-menu .theme-option')?.focus()`);
        await pressEscape();
        result.escapeRestoresTriggerFocus = JSON.parse(await exec(`JSON.stringify(
          !document.querySelector('.theme-picker-menu')
            && document.activeElement === document.querySelector('.theme-picker-btn')
        )`));
      }

      if (await clickSelector('.theme-picker-btn')) {
        result.menuHitTest = JSON.parse(await exec(`(() => {
          const menu = document.querySelector('.theme-picker-menu');
          if (!menu) return JSON.stringify(false);
          const rect = menu.getBoundingClientRect();
          const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return JSON.stringify(!!target && menu.contains(target));
        })()`));
        await pressEscape();
      }
      return result;
    };

    files = suite === "theme" || suite === "pdf" ? true : await runFiles();
    theme = suite === "files" || suite === "pdf" ? true : await runTheme();
    if (files !== true) await setLocale(testLocaleBaseline);
  } finally {
    if (client && localeBefore && inspectLocale && setLocale) {
      await setLocale(localeBefore.lang);
      const storageSnapshot = JSON.stringify({
        hasStoredLang: localeBefore.hasStoredLang,
        storedLang: localeBefore.storedLang,
      });
      await exec(`(() => {
        const snapshot = ${storageSnapshot};
        if (snapshot.hasStoredLang) window.localStorage.setItem('tb-lang', snapshot.storedLang);
        else window.localStorage.removeItem('tb-lang');
        return true;
      })()`);
      localeAfter = await inspectLocale();
    }
    if (client) {
      await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      client.close();
    }
    await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  }
  if (files !== true) {
    files.localeRestored = {
      live: localeAfter?.lang === localeBefore?.lang,
      storage: localeAfter?.hasStoredLang === localeBefore?.hasStoredLang
        && localeAfter?.storedLang === localeBefore?.storedLang,
    };
  }
  const filesOk = files === true || (
    files.toolbarEntryOpensNewFile
    && files.treeEntryOpensNewFile
    && files.sameModalContract
    && JSON.stringify(files.tabs) === JSON.stringify(["basic", "user", "market"])
    && files.basicHasSixSeeds
    && files.importTargetGuidance.en
    && files.importTargetGuidance.zh
    && files.newProjectHasNoTemplateTabs
    && files.newProjectHasParentAndNameOnly
    && files.localeRestored.live
    && files.localeRestored.storage
  );
  const themeOk = theme === true || (
    Object.values(theme.widths).every((snapshot) => (
      snapshot.toolbarFits
      && snapshot.compileVisible
      && snapshot.newFileVisible
      && snapshot.themeVisible
      && snapshot.moreVisible
      && snapshot.settingsVisible
    ))
    && theme.moreMenuHasSecondaryActions
    && Object.values(theme.themeSelections).every(Boolean)
    && theme.outsidePointerPreservesFocus
    && theme.escapeRestoresTriggerFocus
    && theme.menuHitTest
  );
  failed = !filesOk || !themeOk;
  console.log("FILES", JSON.stringify(files));
  console.log("THEME", JSON.stringify(theme));
  console.log("E2E-DONE", failed ? "FAIL" : "PASS", { suite, filesOk, themeOk });
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("E2E-FAIL", error);
  process.exit(1);
});
