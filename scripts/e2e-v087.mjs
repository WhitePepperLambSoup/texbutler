// e2e: v0.8.7 new-file workflow — toolbar/tree parity and template center.
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/.worktrees/codex-fix-ui-ai-layout/assets/e2e/v087-check";
const FILE = `${PROJ}/main.tex`;
const APP_DATA = process.env.APPDATA;
const USER_TEMPLATE_ROOT = APP_DATA ? join(APP_DATA, "texbutler", "templates") : null;
const suite = process.argv[2] ?? "all";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!new Set(["files", "theme", "pdf", "all"]).has(suite)) {
  throw new Error(`unknown suite: ${suite}`);
}

const exists = async (path) => access(path).then(() => true, () => false);

async function installTemplateFixtures() {
  if (!USER_TEMPLATE_ROOT) {
    throw new Error("APPDATA is required for state-preserving template fixtures");
  }
  const nonce = `${process.pid}-${Date.now()}`;
  const userDir = join(USER_TEMPLATE_ROOT, "article");
  const userFile = join(USER_TEMPLATE_ROOT, "article.tex");
  const snapshot = {
    userRootExisted: await exists(USER_TEMPLATE_ROOT),
    entries: [],
  };
  try {
    await mkdir(USER_TEMPLATE_ROOT, { recursive: true });
    for (const target of [userDir, userFile]) {
      if (!await exists(target)) continue;
      const backup = `${target}.e2e-v087-backup-${nonce}`;
      await rename(target, backup);
      snapshot.entries.push({ target, backup });
    }
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "main.tex"), "\\documentclass{article}\n% V087_USER_COLLISION\n", "utf8");
    await writeFile(join(userDir, "user-only.txt"), "V087_USER_COLLISION\n", "utf8");
    return snapshot;
  } catch (error) {
    await restoreTemplateFixtures(snapshot);
    throw error;
  }
}

async function restoreTemplateFixtures(snapshot) {
  if (!snapshot || !USER_TEMPLATE_ROOT) return;
  await rm(join(USER_TEMPLATE_ROOT, "article"), { recursive: true, force: true });
  await rm(join(USER_TEMPLATE_ROOT, "article.tex"), { force: true });
  for (const { target, backup } of [...snapshot.entries].reverse()) {
    await rename(backup, target);
  }
  if (!snapshot.userRootExisted) await rm(USER_TEMPLATE_ROOT).catch(() => {});
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
  let pdf = true;
  let failed = false;
  let inspectLocale;
  let setLocale;
  let localeBefore;
  let localeAfter;
  let testLocaleBaseline;
  let pdfWidthBefore;
  let pdfWidthAfter;
  let templateFixtures;
  let browserStateBefore;
  let browserStateAfter;
  const cleanupErrors = [];
  try {
    templateFixtures = await installTemplateFixtures();
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
    browserStateBefore = JSON.parse(await exec(`(async () => {
      const storeUrl = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
        ?? '/src/store/projectStore.ts';
      const i18nUrl = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => new URL(name).pathname.endsWith('/src/i18n/index.ts') && new URL(name).search)
        ?? '/src/i18n/index.ts';
      const { useProjectStore } = await import(storeUrl);
      const { useI18n } = await import(i18nUrl);
      const project = useProjectStore.getState();
      return JSON.stringify({
        storage: Object.fromEntries(Object.entries(localStorage)),
        theme: document.documentElement.dataset.theme ?? null,
        locale: useI18n.getState().lang,
        project: {
          root: project.root,
          mainFile: project.mainFile,
          files: project.files,
          tabs: project.tabs,
          activeTab: project.activeTab,
          pdfPath: project.pdfPath,
          refIndex: project.refIndex,
          toast: project.toast,
        },
      });
    })()`));
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
    const openFixtureProject = async () => exec(`(async () => {
      const storeUrl = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
        ?? '/src/store/projectStore.ts';
      const { useProjectStore } = await import(storeUrl);
      await useProjectStore.getState().openProject(${JSON.stringify(PROJ)});
      await useProjectStore.getState().openFile('main.tex');
      return true;
    })()`);

    await openFixtureProject();
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
        templateSourceIsolation: {
          collidingIdPresent: false,
          userToMarketCleared: false,
          marketToUserCleared: false,
          blockedCarryImport: false,
          downloadClearedSelection: false,
          downloadBlockedCarryImport: false,
          userImportUsesUserSource: false,
          marketImportUsesMarketSource: false,
        },
        treeActions: {},
        selectedCardContrast: { basic: 0, saved: 0 },
      };
      const openNewFile = async () => {
        if (await exec(`!!document.querySelector('.new-file-modal')`)) return true;
        const clicked = await clickSelector('.toolbar-new-file');
        return clicked && await exec(`!!document.querySelector('.new-file-modal')`);
      };
      const closeModal = async () => {
        if (await exec(`!!document.querySelector('.modal-header button')`)) {
          await clickSelector('.modal-header button');
        }
      };
      const waitFor = async (expression, attempts = 40) => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (await exec(expression)) return true;
          await sleep(50);
        }
        return false;
      };
      const markMarketTemplates = async () => exec(`(async () => {
        const apiUrl = performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { api } = await import(apiUrl);
        const templates = await api.listMarketTemplates();
        [...document.querySelectorAll('.market-card')].forEach((card, index) => {
          card.dataset.templateId = templates[index]?.id ?? '';
        });
        return templates.length;
      })()`);
      const markUserTemplates = async () => exec(`(async () => {
        const apiUrl = performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { api } = await import(apiUrl);
        const templates = await api.listTemplates();
        [...document.querySelectorAll('.template-wrap .template-card')].forEach((card, index) => {
          card.dataset.templateId = templates[index]?.id ?? '';
        });
        return templates.length;
      })()`);
      const selectTemplate = async (source, id) => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const selector = await exec(`(async () => {
            const source = ${JSON.stringify(source)};
            const id = ${JSON.stringify(id)};
            const apiUrl = performance.getEntriesByType('resource')
              .map((entry) => entry.name)
              .find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
              ?? '/src/api/index.ts';
            const { api } = await import(apiUrl);
            const templates = source === 'market' ? await api.listMarketTemplates() : await api.listTemplates();
            const rendered = source === 'market'
              ? [...document.querySelectorAll('.market-card')]
              : [...document.querySelectorAll('.template-wrap .template-card')];
            rendered.forEach((card, index) => { card.dataset.templateId = templates[index]?.id ?? ''; });
            const button = rendered.find((candidate) => candidate.dataset.templateId === id);
            if (!button) return null;
            button.dataset.e2eTemplate = source + '-' + id;
            button.scrollIntoView({ block: 'center', inline: 'nearest' });
            return '[data-e2e-template="' + source + '-' + id + '"]';
          })()`);
          if (selector) return clickSelector(selector);
          await sleep(50);
        }
        return false;
      };
      const setTarget = async (value) => exec(`(() => {
        const input = document.querySelector('.new-file-modal label.target-row input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      const readProjectFile = async (path) => exec(`(async () => {
        const apiUrl = performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { api } = await import(apiUrl);
        try { return await api.readFile(${JSON.stringify(path)}); }
        catch { return null; }
      })()`);
      const waitForProjectFile = async (path) => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const content = await readProjectFile(path);
          if (content !== null) return content;
          await sleep(50);
        }
        return null;
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
      await closeModal();

      const originalTreeWidth = await exec(`document.querySelector('.col-tree')?.style.width ?? ''`);
      for (const width of [160, 220]) {
        for (const lang of ['en', 'zh']) {
          await setLocale(lang);
          await exec(`(() => {
            const rail = document.querySelector('.col-tree');
            if (rail) rail.style.width = ${JSON.stringify(`${width}px`)};
          })()`);
          await sleep(80);
          result.treeActions[`${width}-${lang}`] = JSON.parse(await exec(`(() => {
            const rail = document.querySelector('.col-tree');
            const actions = [...document.querySelectorAll('.project-tree > .panel-header .panel-actions > button')];
            if (!rail) return JSON.stringify({ rendered: false, visible: false, contained: false, count: actions.length });
            const railRect = rail.getBoundingClientRect();
            const geometry = actions.map((button) => {
              const rect = button.getBoundingClientRect();
              const style = getComputedStyle(button);
              return {
                text: button.textContent?.trim() ?? '',
                rendered: rect.width > 0 && rect.height > 0 && style.display !== 'none',
                visible: style.visibility !== 'hidden' && rect.top >= railRect.top && rect.bottom <= railRect.bottom,
                contained: rect.left >= railRect.left - 0.5 && rect.right <= railRect.right + 0.5,
              };
            });
            return JSON.stringify({
              railWidth: railRect.width,
              count: actions.length,
              rendered: actions.length === 4 && geometry.every((item) => item.rendered),
              visible: geometry.every((item) => item.visible),
              contained: geometry.every((item) => item.contained),
              geometry,
            });
          })()`));
        }
      }
      await exec(`(() => {
        const rail = document.querySelector('.col-tree');
        if (rail) rail.style.width = ${JSON.stringify(originalTreeWidth)};
      })()`);

      await openNewFile();
      await clickSelector('[data-new-file-tab="user"]');
      await waitFor(`document.querySelectorAll('.template-wrap .template-card').length > 0`);
      await markUserTemplates();
      const userCollision = await exec(`!!document.querySelector('.template-wrap .template-card[data-template-id="article"]')`);
      await clickSelector('[data-new-file-tab="market"]');
      await markMarketTemplates();
      const marketCollision = await exec(`!!document.querySelector('.market-card[data-template-id="article"]')`);
      result.templateSourceIsolation.collidingIdPresent = userCollision && marketCollision;
      await closeModal();

      await openNewFile();
      await clickSelector('[data-new-file-tab="market"]');
      await selectTemplate('market', 'article');
      await clickSelector('[data-new-file-tab="user"]');
      result.templateSourceIsolation.marketToUserCleared = await exec(`!document.querySelector('.template-wrap .template-active')`);
      await selectTemplate('user', 'article');
      await clickSelector('[data-new-file-tab="market"]');
      result.templateSourceIsolation.userToMarketCleared = await exec(`!document.querySelector('.market-card.template-active')`);
      await setTarget('carry-blocked');
      await clickSelector('.new-file-modal .modal-footer .btn-primary');
      await sleep(350);
      result.templateSourceIsolation.blockedCarryImport = await exec(`!!document.querySelector('.new-file-modal .modal-error')`);
      await closeModal();
      await rm(`${PROJ}/carry-blocked`, { recursive: true, force: true });

      await openNewFile();
      await clickSelector('[data-new-file-tab="user"]');
      await selectTemplate('user', 'article');
      await setTarget('from-user');
      await clickSelector('.new-file-modal .modal-footer .btn-primary');
      result.templateSourceIsolation.userImportUsesUserSource =
        (await waitForProjectFile('from-user/user-only.txt'))?.trim() === 'V087_USER_COLLISION';

      await openNewFile();
      await clickSelector('[data-new-file-tab="market"]');
      await selectTemplate('market', 'article');
      await setTarget('from-market');
      await clickSelector('.new-file-modal .modal-footer .btn-primary');
      const marketMain = await waitForProjectFile('from-market/main.tex');
      const marketOnly = await readProjectFile('from-market/user-only.txt');
      result.templateSourceIsolation.marketImportUsesMarketSource =
        typeof marketMain === 'string' && marketMain.includes('\\documentclass') && marketOnly === null;

      await openNewFile();
      await clickSelector('[data-new-file-tab="market"]');
      await selectTemplate('market', 'article');
      await exec(`(async () => {
        const apiUrl = performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { api } = await import(apiUrl);
        window.__v087DownloadOriginal = api.downloadTemplate;
        api.downloadTemplate = () => new Promise((resolve) => { window.__v087ResolveDownload = resolve; });
        return true;
      })()`);
      await selectTemplate('market', 'zjuthesis');
      await sleep(80);
      result.templateSourceIsolation.downloadClearedSelection = await exec(`!document.querySelector('.market-card.template-active')`);
      await setTarget('download-carry-blocked');
      await clickSelector('.new-file-modal .modal-footer .btn-primary');
      await sleep(150);
      result.templateSourceIsolation.downloadBlockedCarryImport = await exec(`!!document.querySelector('.new-file-modal .modal-error')`);
      await exec(`(async () => {
        const apiUrl = performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { api } = await import(apiUrl);
        window.__v087ResolveDownload?.('fixture');
        if (window.__v087DownloadOriginal) api.downloadTemplate = window.__v087DownloadOriginal;
        delete window.__v087ResolveDownload;
        delete window.__v087DownloadOriginal;
        return true;
      })()`);
      await sleep(120);
      await closeModal();
      await rm(`${PROJ}/download-carry-blocked`, { recursive: true, force: true });

      const themeBeforeContrast = await exec(`document.documentElement.dataset.theme ?? ''`);
      await exec(`document.documentElement.dataset.theme = 'light'`);
      await openNewFile();
      await clickSelector('[data-new-file-tab="basic"]');
      const renderedContrast = async (selector) => Number(await exec(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return 0;
        const parse = (value) => {
          const match = value.match(/rgba?\\(([^)]+)\\)/);
          if (!match) return { r: 0, g: 0, b: 0, a: 0 };
          const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
          return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
        };
        const over = (front, back) => {
          const a = front.a + back.a * (1 - front.a);
          return a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : {
            r: (front.r * front.a + back.r * back.a * (1 - front.a)) / a,
            g: (front.g * front.a + back.g * back.a * (1 - front.a)) / a,
            b: (front.b * front.a + back.b * back.a * (1 - front.a)) / a,
            a,
          };
        };
        const chain = [];
        for (let current = node; current; current = current.parentElement) chain.push(current);
        let background = { r: 255, g: 255, b: 255, a: 1 };
        for (const current of chain.reverse()) background = over(parse(getComputedStyle(current).backgroundColor), background);
        const foreground = over(parse(getComputedStyle(node).color), background);
        const luminance = ({ r, g, b }) => {
          const linear = [r, g, b].map((channel) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
        };
        const a = luminance(foreground);
        const b = luminance(background);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      })()`));
      result.selectedCardContrast.basic = await renderedContrast('.template-grid .template-card.template-active');
      await clickSelector('[data-new-file-tab="user"]');
      await selectTemplate('user', 'article');
      result.selectedCardContrast.saved = await renderedContrast('.template-wrap .template-card.template-active');
      await closeModal();
      await exec(`document.documentElement.dataset.theme = ${JSON.stringify(themeBeforeContrast)}`);
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

    const runPdf = async () => {
      const result = { viewports: {} };
      pdfWidthBefore = JSON.parse(await exec(`(() => {
        const value = localStorage.getItem('tb-pdf-w');
        return JSON.stringify({ hasValue: value !== null, value });
      })()`));
      const setViewport = async (width, height) => {
        await client.send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await sleep(100);
      };
      const inspectPdf = async () => JSON.parse(await exec(`(() => {
        const pane = document.querySelector('.col-pdf');
        const divider = document.querySelector('.col-editor + .splitter-v');
        const rect = pane?.getBoundingClientRect();
        const dividerRect = divider?.getBoundingClientRect();
        const visible = (selector) => {
          const node = document.querySelector(selector);
          if (!node) return false;
          const nodeRect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return nodeRect.width > 0 && nodeRect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        return JSON.stringify({
          paneWidth: rect?.width ?? 0,
          paneVisible: (rect?.width ?? 0) >= 240,
          titleVisible: visible('.col-pdf .panel-title')
            && (document.querySelector('.col-pdf .panel-title')?.textContent?.trim().length ?? 0) > 0,
          emptyVisible: visible('.col-pdf .pdf-empty'),
          dividerWidth: dividerRect?.width ?? 0,
          dividerVisible: (dividerRect?.width ?? 0) >= 6 && getComputedStyle(divider).visibility !== 'hidden',
          iframeAbsent: !document.querySelector('.col-pdf iframe'),
          frameVisible: visible('.col-pdf .pdf-frame'),
          savedWidth: Number(localStorage.getItem('tb-pdf-w')),
        });
      })()`));
      const dragPdfDivider = async (distance) => {
        const point = JSON.parse(await exec(`(() => {
          const rect = document.querySelector('.col-editor + .splitter-v')?.getBoundingClientRect();
          return JSON.stringify(rect ? { x: rect.left + rect.width / 2, y: rect.top + Math.min(60, rect.height / 2) } : null);
        })()`));
        if (!point) return false;
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
        await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + distance, y: point.y, button: "left", buttons: 1 });
        await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x + distance, y: point.y, button: "left", clickCount: 1 });
        await sleep(180);
        return true;
      };

      for (const [width, height] of [[940, 700], [1280, 800]]) {
        await rm(`${PROJ}/.texbutler`, { recursive: true, force: true });
        await setViewport(width, height);
        await exec(`(() => { localStorage.removeItem('tb-pdf-w'); return true; })()`);
        await client.send("Page.reload", { ignoreCache: true });
        await sleep(1200);
        await openFixtureProject();
        await sleep(350);

        const empty = await inspectPdf();
        const dragged = await dragPdfDivider(40);
        const afterDrag = await inspectPdf();
        await mkdir(`${PROJ}/.texbutler/build`, { recursive: true });
        await writeFile(
          `${PROJ}/.texbutler/build/main.pdf`,
          "%PDF-1.4\\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\\ntrailer<</Root 1 0 R>>\\n%%EOF\\n",
          "utf8",
        );
        await exec(`(async () => {
          const storeUrl = performance.getEntriesByType('resource')
            .map((entry) => entry.name)
            .find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
            ?? '/src/store/projectStore.ts';
          const { useProjectStore } = await import(storeUrl);
          await useProjectStore.getState().refresh();
          return true;
        })()`);
        await sleep(350);
        const populated = await inspectPdf();
        result.viewports[`${width}x${height}`] = {
          empty,
          dragged,
          afterDrag,
          populated,
          dragMovedPane: Math.abs((afterDrag.paneWidth ?? 0) - (empty.paneWidth ?? 0) - 40) <= 3,
          dragSavedWidth: Math.abs((afterDrag.savedWidth ?? 0) - (empty.savedWidth ?? 0) - 40) <= 3,
          widthPreserved: Math.abs((populated.paneWidth ?? 0) - (afterDrag.paneWidth ?? 0)) <= 1,
        };
      }
      return result;
    };

    files = suite === "theme" || suite === "pdf" ? true : await runFiles();
    theme = suite === "files" || suite === "pdf" ? true : await runTheme();
    pdf = suite === "files" || suite === "theme" ? true : await runPdf();
    if (files !== true) await setLocale(testLocaleBaseline);
  } finally {
    if (client && exec && pdfWidthBefore) {
      const storageSnapshot = JSON.stringify(pdfWidthBefore);
      await exec(`(() => {
        const snapshot = ${storageSnapshot};
        if (snapshot.hasValue) window.localStorage.setItem('tb-pdf-w', snapshot.value);
        else window.localStorage.removeItem('tb-pdf-w');
        return true;
      })()`);
      pdfWidthAfter = JSON.parse(await exec(`(() => {
        const value = localStorage.getItem('tb-pdf-w');
        return JSON.stringify({ hasValue: value !== null, value });
      })()`));
    }
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
    if (client && exec && browserStateBefore) {
      try {
        await exec(`(async () => {
          const apiUrl = performance.getEntriesByType('resource')
            .map((entry) => entry.name)
            .find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
            ?? '/src/api/index.ts';
          const { api } = await import(apiUrl);
          window.__v087ResolveDownload?.('fixture');
          if (window.__v087DownloadOriginal) api.downloadTemplate = window.__v087DownloadOriginal;
          delete window.__v087ResolveDownload;
          delete window.__v087DownloadOriginal;
          const snapshot = ${JSON.stringify(browserStateBefore)};
          localStorage.clear();
          for (const [key, value] of Object.entries(snapshot.storage)) localStorage.setItem(key, value);
          return true;
        })()`);
        await client.send("Page.reload", { ignoreCache: true });
        await sleep(1200);
        browserStateAfter = JSON.parse(await exec(`(async () => {
          const snapshot = ${JSON.stringify(browserStateBefore)};
          const storeUrl = performance.getEntriesByType('resource')
            .map((entry) => entry.name)
            .find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
            ?? '/src/store/projectStore.ts';
          const i18nUrl = performance.getEntriesByType('resource')
            .map((entry) => entry.name)
            .find((name) => new URL(name).pathname.endsWith('/src/i18n/index.ts') && new URL(name).search)
            ?? '/src/i18n/index.ts';
          const { useProjectStore } = await import(storeUrl);
          const { useI18n } = await import(i18nUrl);
          if (snapshot.project.root) await useProjectStore.getState().openProject(snapshot.project.root);
          else useProjectStore.getState().closeProject();
          useProjectStore.setState(snapshot.project);
          useI18n.getState().setLang(snapshot.locale);
          if (snapshot.theme === null) delete document.documentElement.dataset.theme;
          else document.documentElement.dataset.theme = snapshot.theme;
          localStorage.clear();
          for (const [key, value] of Object.entries(snapshot.storage)) localStorage.setItem(key, value);
          const project = useProjectStore.getState();
          return JSON.stringify({
            storage: Object.fromEntries(Object.entries(localStorage)),
            theme: document.documentElement.dataset.theme ?? null,
            locale: useI18n.getState().lang,
            project: {
              root: project.root,
              mainFile: project.mainFile,
              files: project.files,
              tabs: project.tabs,
              activeTab: project.activeTab,
              pdfPath: project.pdfPath,
              refIndex: project.refIndex,
              toast: project.toast,
            },
          });
        })()`));
      } catch (error) {
        cleanupErrors.push(`browser restoration: ${error}`);
      }
    }
    if (client) {
      await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      client.close();
    }
    await rm(PROJ, { recursive: true, force: true }).catch(() => {});
    try {
      await restoreTemplateFixtures(templateFixtures);
    } catch (error) {
      cleanupErrors.push(`template restoration: ${error}`);
    }
  }
  if (files !== true) {
    files.localeRestored = {
      live: localeAfter?.lang === localeBefore?.lang,
      storage: localeAfter?.hasStoredLang === localeBefore?.hasStoredLang
        && localeAfter?.storedLang === localeBefore?.storedLang,
    };
  }
  if (pdf !== true) {
    pdf.restoration = {
      before: pdfWidthBefore,
      after: pdfWidthAfter,
      restored: pdfWidthAfter?.hasValue === pdfWidthBefore?.hasValue
        && pdfWidthAfter?.value === pdfWidthBefore?.value,
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
    && Object.values(files.templateSourceIsolation).every(Boolean)
    && Object.values(files.treeActions).length === 4
    && Object.values(files.treeActions).every((snapshot) => (
      snapshot.rendered && snapshot.visible && snapshot.contained
    ))
    && files.selectedCardContrast.basic >= 4.5
    && files.selectedCardContrast.saved >= 4.5
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
  const pdfOk = pdf === true || (pdf.restoration?.restored && Object.values(pdf.viewports).every((snapshot) => (
    snapshot.empty.paneVisible
    && snapshot.empty.titleVisible
    && snapshot.empty.emptyVisible
    && snapshot.empty.dividerVisible
    && snapshot.empty.iframeAbsent
    && snapshot.dragged
    && snapshot.dragMovedPane
    && snapshot.dragSavedWidth
    && snapshot.populated.frameVisible
    && snapshot.widthPreserved
  )));
  const browserRestored = cleanupErrors.length === 0
    && JSON.stringify(browserStateAfter) === JSON.stringify(browserStateBefore);
  failed = !filesOk || !themeOk || !pdfOk || !browserRestored;
  console.log("FILES", JSON.stringify(files));
  console.log("THEME", JSON.stringify(theme));
  console.log("PDF", JSON.stringify(pdf));
  console.log("STATE", JSON.stringify({ browserRestored, cleanupErrors }));
  console.log("E2E-DONE", failed ? "FAIL" : "PASS", { suite, filesOk, themeOk, pdfOk, browserRestored });
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("E2E-FAIL", error);
  process.exit(1);
});
