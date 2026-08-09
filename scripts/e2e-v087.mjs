// e2e: v0.8.7 new-file workflow — toolbar/tree parity and template center.
import { spawnSync } from "node:child_process";
import { access, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/.worktrees/codex-fix-ui-ai-layout/assets/e2e/v087-check";
const SESSION_PROJ = `${PROJ}-sessions`;
const FILE = `${PROJ}/main.tex`;
const APP_DATA = process.env.APPDATA;
const USER_TEMPLATE_ROOT = APP_DATA ? join(APP_DATA, "texbutler", "templates") : null;
const suite = process.argv[2] ?? "all";
const sessionsExecuted = suite === "sessions" || suite === "all";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!new Set(["files", "theme", "pdf", "sessions", "all", "cleanup-fault"]).has(suite)) {
  throw new Error(`unknown suite: ${suite}`);
}

const exists = async (path) => access(path).then(() => true, () => false);

async function installTemplateFixtures(snapshot) {
  if (!USER_TEMPLATE_ROOT) {
    throw new Error("APPDATA is required for state-preserving template fixtures");
  }
  const nonce = process.env.V087_FIXTURE_NONCE ?? `${process.pid}-${Date.now()}`;
  const userDir = join(USER_TEMPLATE_ROOT, "article");
  const userFile = join(USER_TEMPLATE_ROOT, "article.tex");
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
}

async function snapshotPath(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      const entries = {};
      for (const name of (await readdir(path)).sort()) entries[name] = await snapshotPath(join(path, name));
      return { type: "directory", entries };
    }
    if (metadata.isFile()) return { type: "file", data: (await readFile(path)).toString("base64") };
    return { type: "other" };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function runSyntheticRootProbes() {
  const probeBase = `${PROJ}-root-probe-${process.pid}`;
  const absentRoot = join(probeBase, "absent");
  const existingRoot = join(probeBase, "existing");
  const failingRoot = join(probeBase, "failing");
  let failurePropagated = false;
  try {
    await mkdir(join(absentRoot, "article"), { recursive: true });
    await writeFile(join(absentRoot, "article", "main.tex"), "fixture", "utf8");
    await restoreTemplateFixtures({ userRootExisted: false, entries: [] }, absentRoot);

    await mkdir(join(existingRoot, "article"), { recursive: true });
    await writeFile(join(existingRoot, "keep.txt"), "keep", "utf8");
    await restoreTemplateFixtures({ userRootExisted: true, entries: [] }, existingRoot);

    await mkdir(join(failingRoot, "article"), { recursive: true });
    try {
      await restoreTemplateFixtures(
        { userRootExisted: false, entries: [] },
        failingRoot,
        async (target, options) => {
          await rm(target, options);
        },
        async () => { throw new Error("synthetic template root removal failure"); },
      );
    } catch (error) {
      failurePropagated = String(error).includes("synthetic template root removal failure");
    }

    return {
      absentRootRestored: !await exists(absentRoot),
      existingRootRestored: await exists(existingRoot)
        && await readFile(join(existingRoot, "keep.txt"), "utf8") === "keep"
        && !await exists(join(existingRoot, "article")),
      removalFailurePropagated: failurePropagated,
    };
  } finally {
    await rm(probeBase, { recursive: true, force: true }).catch(() => {});
  }
}

async function runCleanupFaultProbe() {
  if (!USER_TEMPLATE_ROOT) throw new Error("APPDATA is required for cleanup fault injection");
  const nonce = `cleanup-fault-${process.pid}`;
  const userDir = join(USER_TEMPLATE_ROOT, "article");
  const userFile = join(USER_TEMPLATE_ROOT, "article.tex");
  const userDirBackup = `${userDir}.e2e-v087-backup-${nonce}`;
  const userFileBackup = `${userFile}.e2e-v087-backup-${nonce}`;
  const rootExisted = await exists(USER_TEMPLATE_ROOT);
  const before = {
    userDir: await snapshotPath(userDir),
    userFile: await snapshotPath(userFile),
  };
  await rm(PROJ, { recursive: true, force: true });
  let child;
  let after;
  try {
    child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "files"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        V087_CLEANUP_FAIL_STAGE: "locale",
        V087_FIXTURE_NONCE: nonce,
      },
    });
    after = {
      userDir: await snapshotPath(userDir),
      userFile: await snapshotPath(userFile),
      userDirBackup: await snapshotPath(userDirBackup),
      userFileBackup: await snapshotPath(userFileBackup),
      userRootExists: await exists(USER_TEMPLATE_ROOT),
      projectExists: await exists(PROJ),
    };
  } finally {
    await rm(PROJ, { recursive: true, force: true }).catch(() => {});
    for (const [target, backup, original] of [
      [userDir, userDirBackup, before.userDir],
      [userFile, userFileBackup, before.userFile],
    ]) {
      if (await exists(backup)) {
        await rm(target, { recursive: true, force: true }).catch(() => {});
        await rename(backup, target);
      } else if (original === null) {
        await rm(target, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (!rootExisted) await rm(USER_TEMPLATE_ROOT).catch(() => {});
  }
  const combinedOutput = `${child?.stdout ?? ""}\n${child?.stderr ?? ""}`;
  const synthetic = await runSyntheticRootProbes();
  const result = {
    childReportedFailure: child?.status !== 0 && combinedOutput.includes("E2E-FAIL")
      && combinedOutput.includes("injected cleanup failure: locale"),
    appDataRestored: JSON.stringify(after?.userDir) === JSON.stringify(before.userDir)
      && JSON.stringify(after?.userFile) === JSON.stringify(before.userFile)
      && after?.userDirBackup === null && after?.userFileBackup === null
      && after?.userRootExists === rootExisted,
    projectFixtureRemoved: after?.projectExists === false,
    synthetic,
    childStatus: child?.status ?? null,
    childSignal: child?.signal ?? null,
    childError: child?.error ? String(child.error) : null,
  };
  if (!result.childReportedFailure) result.childOutput = combinedOutput.slice(-2000);
  console.log("CLEANUP-FAULT", JSON.stringify(result));
  if (!result.childReportedFailure || !result.appDataRestored || !result.projectFixtureRemoved
    || !Object.values(result.synthetic).every(Boolean)) process.exitCode = 1;
}

function injectCleanupFailure(stage) {
  if (process.env.V087_CLEANUP_FAIL_STAGE === stage) {
    throw new Error(`injected cleanup failure: ${stage}`);
  }
}

async function restoreTemplateFixtures(
  snapshot,
  templateRoot = USER_TEMPLATE_ROOT,
  remove = rm,
  removeRoot = rmdir,
) {
  if (!snapshot || !templateRoot) return;
  await remove(join(templateRoot, "article"), { recursive: true, force: true });
  await remove(join(templateRoot, "article.tex"), { force: true });
  for (const { target, backup } of [...snapshot.entries].reverse()) {
    await rename(backup, target);
  }
  if (!snapshot.userRootExisted) await removeRoot(templateRoot);
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
  let sessions = true;
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
  let sessionProjectBackup = null;
  let sessionProjectOwned = false;
  let sessionProjectRestored = true;
  let sessionProjectUntouched = true;
  const cleanupErrors = [];
  try {
    try {
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
      templateFixtures = {
        userRootExisted: await exists(USER_TEMPLATE_ROOT),
        entries: [],
      };
      await installTemplateFixtures(templateFixtures);
      if (sessionsExecuted) {
        if (await exists(SESSION_PROJ)) {
          const backup = `${SESSION_PROJ}.e2e-v087-backup-${process.pid}-${Date.now()}`;
          await rename(SESSION_PROJ, backup);
          sessionProjectBackup = backup;
        }
        sessionProjectOwned = true;
        await mkdir(`${SESSION_PROJ}/contents`, { recursive: true });
        await writeFile(`${SESSION_PROJ}/main.tex`, "\\documentclass{article}\nSynthetic session fixture.\n", "utf8");
        await writeFile(`${SESSION_PROJ}/contents/abstract.tex`, "Synthetic abstract fixture.\n", "utf8");
      }
      sessionProjectUntouched = !sessionProjectOwned;
      await rm(PROJ, { recursive: true, force: true });
      await mkdir(PROJ, { recursive: true });
      await writeFile(FILE, "\\documentclass{article}\n\\begin{document}\nE2E fixture.\n\\end{document}\n", "utf8");
      await mkdir(`${PROJ}/contents`, { recursive: true });
      await writeFile(`${PROJ}/contents/abstract.tex`, "Abstract fixture.\n", "utf8");
      await writeFile(`${PROJ}/contents/anchor.tex`, "Anchor fixture.\n", "utf8");
      await mkdir(`${PROJ}/contents/user-zone`, { recursive: true });
      await writeFile(`${PROJ}/contents/user-zone/anchor.tex`, "User zone.\n", "utf8");
      await mkdir(`${PROJ}/contents/market-zone`, { recursive: true });
      await writeFile(`${PROJ}/contents/market-zone/anchor.tex`, "Market zone.\n", "utf8");
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
    if (suite !== "theme" && suite !== "pdf" && suite !== "sessions") {
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
        destination: { editablePathInputs: -1, shown: "" },
        destinationHasNoEditablePath: false,
        destinationShowsRoot: false,
        nestedBasicDestination: false,
        filenameOnlyValidation: false,
        rootConflictPreserved: false,
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
      const submitNewFileModal = async () => {
        const clicked = await clickSelector('.new-file-modal .modal-footer .btn-primary');
        if (!clicked) return { outcome: 'missing-submit', open: false, error: null };
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const state = JSON.parse(await exec(`JSON.stringify({
            open: !!document.querySelector('.new-file-modal'),
            error: document.querySelector('.new-file-modal .modal-error')?.textContent?.trim() ?? null,
            input: document.querySelector('.new-file-modal .new-file-name-input')?.value ?? null,
          })`));
          if (!state.open) return { outcome: 'closed', ...state };
          if (state.error) return { outcome: 'error', ...state };
          await sleep(50);
        }
        const state = JSON.parse(await exec(`JSON.stringify({
          open: !!document.querySelector('.new-file-modal'),
          error: document.querySelector('.new-file-modal .modal-error')?.textContent?.trim() ?? null,
          input: document.querySelector('.new-file-modal .new-file-name-input')?.value ?? null,
        })`));
        return { outcome: 'timeout', ...state };
      };
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
      const activateProjectFile = async (path) => exec(`(async () => {
        const storeUrl = performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
          ?? '/src/store/projectStore.ts';
        const { useProjectStore } = await import(storeUrl);
        await useProjectStore.getState().openFile(${JSON.stringify(path)});
        return useProjectStore.getState().activeTab;
      })()`);
      const currentActiveTab = async () => exec(`(async () => {
        const storeUrl = performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
          ?? '/src/store/projectStore.ts';
        const { useProjectStore } = await import(storeUrl);
        return useProjectStore.getState().activeTab;
      })()`);
      const replaceInputText = async (selector, value) => {
        const clicked = await clickSelector(selector);
        if (!clicked) return false;
        await client.send("Input.dispatchKeyEvent", {
          type: "keyDown", key: "a", code: "KeyA", modifiers: 2,
          windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
        });
        await client.send("Input.dispatchKeyEvent", {
          type: "keyUp", key: "a", code: "KeyA", modifiers: 2,
          windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
        });
        await client.send("Input.insertText", { text: value });
        await sleep(80);
        return true;
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
      result.destination = JSON.parse(await exec(`JSON.stringify({
        editablePathInputs: document.querySelectorAll('.new-file-modal .target-row input').length,
        shown: document.querySelector('.new-file-destination')?.textContent ?? '',
      })`));
      const editablePathInputsByTab = {};
      for (const destinationTab of ['basic', 'user', 'market']) {
        await clickSelector(`[data-new-file-tab="${destinationTab}"]`);
        editablePathInputsByTab[destinationTab] = await exec(`document.querySelectorAll('.new-file-modal .target-row input').length`);
      }
      result.destination.editablePathInputsByTab = editablePathInputsByTab;
      result.destinationHasNoEditablePath = Object.values(editablePathInputsByTab).every((count) => count === 0);
      result.destinationShowsRoot = /\//.test(result.destination.shown);
      await closeModal();
      await activateProjectFile('contents/anchor.tex');
      await openNewFile();
      await clickSelector('[data-new-file-tab="basic"]');
      const nestedDestinationShown = await exec(`document.querySelector('.new-file-destination')?.textContent?.trim() ?? ''`);
      await replaceInputText('.new-file-name-input', 'nested-new.tex');
      const nestedBasicOutcome = await submitNewFileModal();
      result.nestedBasicDestination = nestedBasicOutcome.outcome === 'closed'
        && (await waitForProjectFile('contents/nested-new.tex')) !== null
        && (await readProjectFile('nested-new.tex')) === null
        && /contents/.test(nestedDestinationShown);
      await openNewFile();
      await clickSelector('[data-new-file-tab="basic"]');
      await replaceInputText('.new-file-name-input', '../invalid.tex');
      const filenameOnlyOutcome = await submitNewFileModal();
      result.filenameOnlyValidation = filenameOnlyOutcome.outcome === 'error'
        && filenameOnlyOutcome.open
        && (await readProjectFile('invalid.tex')) === null;
      await closeModal();
      await openNewFile();
      await clickSelector('[data-new-file-tab="user"]');
      await setLocale("en");
      await sleep(80);
      await setLocale("zh");
      await sleep(80);
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
      const blockedCarryOutcome = await submitNewFileModal();
      result.templateSourceIsolation.blockedCarryImport = blockedCarryOutcome.outcome === 'error';
      await closeModal();

      await activateProjectFile('contents/user-zone/anchor.tex');
      await openNewFile();
      await clickSelector('[data-new-file-tab="user"]');
      await selectTemplate('user', 'article');
      const userImportOutcome = await submitNewFileModal();
      const userMarker = await waitForProjectFile('contents/user-zone/user-only.txt');
      result.templateSourceIsolation.userImportUsesUserSource = userImportOutcome.outcome === 'closed'
        && userMarker?.trim() === 'V087_USER_COLLISION'
        && await currentActiveTab() === 'contents/user-zone/main.tex';
      if (!result.templateSourceIsolation.userImportUsesUserSource) {
        result.userImportDiagnostics = {
          userImportOutcome,
          blockedCarryOutcome,
          modal: JSON.parse(await exec(`JSON.stringify({
            open: !!document.querySelector('.new-file-modal'),
            input: document.querySelector('.new-file-modal .new-file-name-input')?.value ?? null,
            error: document.querySelector('.new-file-modal .modal-error')?.textContent?.trim() ?? null,
          })`)),
          userZone: await snapshotPath(`${PROJ}/contents/user-zone`),
        };
      }

      await activateProjectFile('contents/market-zone/anchor.tex');
      await openNewFile();
      await clickSelector('[data-new-file-tab="market"]');
      await selectTemplate('market', 'article');
      const marketImportOutcome = await submitNewFileModal();
      const marketMain = await waitForProjectFile('contents/market-zone/main.tex');
      const marketOnly = await readProjectFile('contents/market-zone/user-only.txt');
      result.templateSourceIsolation.marketImportUsesMarketSource = marketImportOutcome.outcome === 'closed'
        &&
        typeof marketMain === 'string' && marketMain.includes('\\documentclass') && marketOnly === null
        && await currentActiveTab() === 'contents/market-zone/main.tex';

      await activateProjectFile('main.tex');
      await openNewFile();
      await clickSelector('[data-new-file-tab="user"]');
      await selectTemplate('user', 'article');
      const conflictOutcome = await submitNewFileModal();
      result.rootConflictPreserved = conflictOutcome.outcome === 'error'
        && conflictOutcome.open
        && /main\.tex/.test(conflictOutcome.error ?? '')
        && (await readProjectFile('user-only.txt')) === null;
      await closeModal();

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
      const downloadCarryOutcome = await submitNewFileModal();
      result.templateSourceIsolation.downloadBlockedCarryImport = downloadCarryOutcome.outcome === 'error';
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

    const runSessions = async () => {
      const aiState = async () => JSON.parse(await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const projectUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
          ?? '/src/store/projectStore.ts';
        const { useAiStore } = await import(aiUrl);
        const { useProjectStore } = await import(projectUrl);
        const ai = useAiStore.getState();
        const project = useProjectStore.getState();
        return JSON.stringify({
          root: project.root,
          activeTab: project.activeTab,
          activeProjectRoot: ai.activeProjectRoot,
          activeFile: ai.activeFile,
          sessionId: ai.sessionId,
          sessions: ai.sessions,
          messages: ai.messages,
          fileSessions: ai.fileSessions,
          storedSessions: JSON.parse(localStorage.getItem('tb-ai-sessions') ?? '[]'),
          storedBindings: JSON.parse(localStorage.getItem('tb-ai-file-sessions-v2') ?? '{}'),
          diffPending: ai.diffPending,
        });
      })()`));
      const openSessionProject = async (root, file = 'main.tex') => exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const projectUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
          ?? '/src/store/projectStore.ts';
        const { useProjectStore } = await import(projectUrl);
        await useProjectStore.getState().openProject(${JSON.stringify(root)});
        if (${JSON.stringify(file)} !== 'main.tex') await useProjectStore.getState().openFile(${JSON.stringify(file)});
        return true;
      })()`);
      const openFile = async (file) => exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const projectUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
          ?? '/src/store/projectStore.ts';
        const { useProjectStore } = await import(projectUrl);
        await useProjectStore.getState().openFile(${JSON.stringify(file)});
        return true;
      })()`);
      const closeFile = async (file) => exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const projectUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
          ?? '/src/store/projectStore.ts';
        const { useProjectStore } = await import(projectUrl);
        await useProjectStore.getState().closeTab(${JSON.stringify(file)});
        return true;
      })()`);
      const callAi = async (body) => exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const { useAiStore } = await import(aiUrl);
        ${body}
        return true;
      })()`);

      await exec(`(() => {
        localStorage.removeItem('tb-ai-sessions');
        localStorage.removeItem('tb-ai-file-sessions-v2');
        return true;
      })()`);
      await client.send("Page.reload", { ignoreCache: true });
      await sleep(1200);
      await openSessionProject(PROJ);
      await sleep(250);

      const result = {};
      const first = await aiState();
      result.mainCreated = first.activeFile === 'main.tex'
        && first.activeProjectRoot === first.root
        && first.sessionId !== null
        && first.sessions.length === 1;

      await openFile('contents/abstract.tex');
      const second = await aiState();
      result.secondCreatedWithoutClosingFirst = second.sessionId !== first.sessionId
        && second.sessions.some((session) => session.id === first.sessionId)
        && second.sessions.some((session) => session.id === second.sessionId);

      await callAi(`useAiStore.getState().pushMessage({ role: 'user', kind: 'plain', text: 'abstract conversation survives restart' });`);
      await openFile('main.tex');
      await openFile('contents/abstract.tex');
      const switched = await aiState();
      result.switchRestoresMessage = switched.sessionId === second.sessionId
        && switched.messages.some((message) => message.text === 'abstract conversation survives restart');

      await closeFile('contents/abstract.tex');
      await openFile('contents/abstract.tex');
      const afterClose = await aiState();
      result.closeTabKeepsSession = afterClose.sessionId === second.sessionId
        && afterClose.messages.some((message) => message.text === 'abstract conversation survives restart');

      await callAi(`useAiStore.getState().clearMessages();`);
      const cleared = await aiState();
      const persistedCleared = cleared.storedSessions.find((session) => session.id === second.sessionId);
      result.clearPersists = cleared.messages.length === 0
        && persistedCleared?.messages?.length === 0;
      await callAi(`useAiStore.getState().pushMessage({ role: 'user', kind: 'plain', text: 'abstract conversation survives restart' });`);

      await client.send("Page.reload", { ignoreCache: true });
      await sleep(1200);
      await openSessionProject(PROJ, 'contents/abstract.tex');
      const restarted = await aiState();
      result.reloadRestoresSameSession = restarted.sessionId === second.sessionId
        && restarted.messages.some((message) => message.text === 'abstract conversation survives restart');

      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { useAiStore } = await import(aiUrl);
        const { api } = await import(apiUrl);
        window.__v087ChatOriginal = api.aiChatStream;
        api.aiChatStream = () => new Promise((resolve) => { window.__v087ResolveChat = resolve; });
        window.__v087AskPromise = useAiStore.getState().askAi('async request belongs to abstract');
        return true;
      })()`);
      await sleep(200);
      await openFile('main.tex');
      await exec(`(async () => {
        window.__v087ResolveChat?.('async abstract reply');
        await window.__v087AskPromise;
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { api } = await import(apiUrl);
        if (window.__v087ChatOriginal) api.aiChatStream = window.__v087ChatOriginal;
        delete window.__v087ChatOriginal;
        delete window.__v087ResolveChat;
        delete window.__v087AskPromise;
        return true;
      })()`);
      const afterAsyncSwitch = await aiState();
      const asyncTarget = afterAsyncSwitch.sessions.find((session) => session.id === second.sessionId);
      result.asyncReplyStaysWithRequestSession = asyncTarget?.messages.some((message) => message.text === 'async request belongs to abstract')
        && asyncTarget?.messages.some((message) => message.text === 'async abstract reply')
        && !asyncTarget?.messages.some((message) => message.role === 'assistant' && message.text === '')
        && !afterAsyncSwitch.messages.some((message) => message.text === 'async request belongs to abstract' || message.text === 'async abstract reply');
      await openFile('contents/abstract.tex');

      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { useAiStore } = await import(aiUrl);
        const { api } = await import(apiUrl);
        window.__v087DiagnoseOriginal = api.aiDiagnose;
        api.aiDiagnose = () => new Promise((resolve) => { window.__v087ResolveDiagnose = resolve; });
        window.__v087DiagnosePromise = useAiStore.getState().diagnoseIssue({
          message: 'ASYNC_DIAG_REQUEST', severity: 'error', file: 'contents/abstract.tex', line: 2,
        }, 0);
        return true;
      })()`);
      await sleep(100);
      await openFile('main.tex');
      await exec(`(async () => {
        window.__v087ResolveDiagnose?.({
          ok: true, explanation: 'ASYNC_DIAG_DONE', suggestion: 'diagnose suggestion', confidence: 'high', raw: 'diagnose raw',
        });
        await window.__v087DiagnosePromise;
        return true;
      })()`);
      const afterDiagnoseSwitch = await aiState();
      const diagnoseTarget = afterDiagnoseSwitch.sessions.find((session) => session.id === second.sessionId);
      result.diagnoseCompletionStaysWithRequestSession = diagnoseTarget?.messages.some((message) => message.text.includes('ASYNC_DIAG_REQUEST'))
        && diagnoseTarget?.messages.some((message) => message.text.includes('ASYNC_DIAG_DONE'))
        && !afterDiagnoseSwitch.messages.some((message) => message.text.includes('ASYNC_DIAG_REQUEST') || message.text.includes('ASYNC_DIAG_DONE'));
      await openFile('contents/abstract.tex');
      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { useAiStore } = await import(aiUrl);
        const { api } = await import(apiUrl);
        api.aiDiagnose = () => new Promise((_, reject) => { window.__v087RejectDiagnose = reject; });
        window.__v087DiagnosePromise = useAiStore.getState().diagnoseIssue({
          message: 'ASYNC_DIAG_ERROR_REQUEST', severity: 'error', file: 'contents/abstract.tex', line: 3,
        }, 0);
        return true;
      })()`);
      await sleep(100);
      await openFile('main.tex');
      await exec(`(async () => {
        window.__v087RejectDiagnose?.(new Error('ASYNC_DIAG_ERROR_DONE'));
        await window.__v087DiagnosePromise;
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { api } = await import(apiUrl);
        if (window.__v087DiagnoseOriginal) api.aiDiagnose = window.__v087DiagnoseOriginal;
        delete window.__v087DiagnoseOriginal;
        delete window.__v087ResolveDiagnose;
        delete window.__v087RejectDiagnose;
        delete window.__v087DiagnosePromise;
        return true;
      })()`);
      const afterDiagnoseError = await aiState();
      const diagnoseErrorTarget = afterDiagnoseError.sessions.find((session) => session.id === second.sessionId);
      result.diagnoseErrorStaysWithRequestSession = diagnoseErrorTarget?.messages.some((message) => message.text.includes('ASYNC_DIAG_ERROR_REQUEST'))
        && diagnoseErrorTarget?.messages.some((message) => message.text.includes('ASYNC_DIAG_ERROR_DONE'))
        && !afterDiagnoseError.messages.some((message) => message.text.includes('ASYNC_DIAG_ERROR_REQUEST') || message.text.includes('ASYNC_DIAG_ERROR_DONE'));
      await openFile('contents/abstract.tex');

      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { useAiStore } = await import(aiUrl);
        const { api } = await import(apiUrl);
        window.__v087FixOriginal = api.aiFix;
        api.aiFix = () => new Promise((resolve) => { window.__v087ResolveFix = resolve; });
        window.__v087FixPromise = useAiStore.getState().fixIssue({
          message: 'ASYNC_FIX_REQUEST', severity: 'error', file: 'contents/abstract.tex', line: 4,
        }, 0);
        return true;
      })()`);
      await sleep(100);
      await openFile('main.tex');
      await exec(`(async () => {
        window.__v087ResolveFix?.({
          ok: true, rounds: 1, summary: 'ASYNC_FIX_DONE', diff: 'ASYNC_FIX_DIFF', suggested: true, hunks: [], backup: null,
        });
        await window.__v087FixPromise;
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { api } = await import(apiUrl);
        if (window.__v087FixOriginal) api.aiFix = window.__v087FixOriginal;
        delete window.__v087FixOriginal;
        delete window.__v087ResolveFix;
        delete window.__v087FixPromise;
        return true;
      })()`);
      const afterFixSwitch = await aiState();
      const fixTarget = afterFixSwitch.sessions.find((session) => session.id === second.sessionId);
      const fixStayedOutOfMain = fixTarget?.messages.some((message) => message.text.includes('ASYNC_FIX_REQUEST'))
        && fixTarget?.messages.some((message) => message.diff === 'ASYNC_FIX_DIFF')
        && !afterFixSwitch.messages.some((message) => message.text.includes('ASYNC_FIX_REQUEST') || message.diff === 'ASYNC_FIX_DIFF')
        && afterFixSwitch.diffPending === null;
      await openFile('contents/abstract.tex');
      const afterFixReturn = await aiState();
      result.fixCompletionStaysWithRequestSession = fixStayedOutOfMain
        && afterFixReturn.messages.some((message) => message.diff === 'ASYNC_FIX_DIFF')
        && afterFixReturn.diffPending === null;

      const sessionCountBeforeProjectSwitch = (await aiState()).sessions.length;
      await openSessionProject(SESSION_PROJ);
      const isolatedMain = await aiState();
      const normalizedSecondRoot = SESSION_PROJ.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const secondAbstractKey = `${normalizedSecondRoot}\u0000contents/abstract.tex`;
      result.projectSwitchIsAtomic = isolatedMain.activeFile === 'main.tex'
        && isolatedMain.sessions.length === sessionCountBeforeProjectSwitch + 1
        && !Object.hasOwn(isolatedMain.fileSessions, secondAbstractKey);
      await openFile('contents/abstract.tex');
      const isolated = await aiState();
      result.sameRelativePathIsolatedByProject = isolated.sessionId !== second.sessionId
        && isolated.activeProjectRoot === isolated.root;

      await callAi(`useAiStore.getState().newSession();`);
      const manual = await aiState();
      await callAi(`useAiStore.getState().switchSession(${JSON.stringify(isolated.sessionId)});`);
      const reboundManual = await aiState();
      result.switchSessionRebindsCurrentFile = manual.sessionId !== isolated.sessionId
        && reboundManual.sessionId === isolated.sessionId
        && reboundManual.storedBindings[secondAbstractKey] === isolated.sessionId;
      const isolatedSessionCount = reboundManual.sessions.length;
      await callAi(`useAiStore.getState().attachFile(${JSON.stringify(SESSION_PROJ)}, 'notes.md');`);
      const scratch = await aiState();
      result.nonTexUsesScratchWithoutDeletingHistory = scratch.sessionId === null
        && scratch.messages.length === 0
        && scratch.sessions.length === isolatedSessionCount;
      await callAi(`useAiStore.getState().attachFile(${JSON.stringify(SESSION_PROJ)}, 'contents/abstract.tex');`);
      const rebound = await aiState();
      await callAi(`useAiStore.getState().deleteSession(${JSON.stringify(isolated.sessionId)});`);
      const deleted = await aiState();
      result.deleteClearsAllBindings = rebound.sessionId === isolated.sessionId
        && !Object.values(deleted.fileSessions).includes(isolated.sessionId)
        && !Object.values(deleted.storedBindings).includes(isolated.sessionId);
      return result;
    };

    files = ["theme", "pdf", "sessions"].includes(suite) ? true : await runFiles();
    theme = ["files", "pdf", "sessions"].includes(suite) ? true : await runTheme();
    pdf = ["files", "theme", "sessions"].includes(suite) ? true : await runPdf();
    sessions = ["files", "theme", "pdf"].includes(suite) ? true : await runSessions();
    if (files !== true) await setLocale(testLocaleBaseline);
    } finally {
      try {
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
      } catch (error) {
        cleanupErrors.push(`PDF restoration: ${error}`);
      }
      try {
        if (client && localeBefore && inspectLocale && setLocale) {
          injectCleanupFailure("locale");
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
      } catch (error) {
        cleanupErrors.push(`locale restoration: ${error}`);
      }
      try {
        if (client && exec && browserStateBefore) {
        await exec(`(async () => {
          const apiUrl = performance.getEntriesByType('resource')
            .map((entry) => entry.name)
            .find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
            ?? '/src/api/index.ts';
          const { api } = await import(apiUrl);
          window.__v087ResolveDownload?.('fixture');
          if (window.__v087DownloadOriginal) api.downloadTemplate = window.__v087DownloadOriginal;
          window.__v087ResolveChat?.('fixture');
          if (window.__v087ChatOriginal) api.aiChatStream = window.__v087ChatOriginal;
          window.__v087ResolveDiagnose?.({ ok: false, error: 'cleanup' });
          window.__v087RejectDiagnose?.(new Error('cleanup'));
          if (window.__v087DiagnoseOriginal) api.aiDiagnose = window.__v087DiagnoseOriginal;
          window.__v087ResolveFix?.({ ok: false, rounds: 0, summary: 'cleanup', diff: null });
          if (window.__v087FixOriginal) api.aiFix = window.__v087FixOriginal;
          delete window.__v087ResolveDownload;
          delete window.__v087DownloadOriginal;
          delete window.__v087ResolveChat;
          delete window.__v087ChatOriginal;
          delete window.__v087AskPromise;
          delete window.__v087ResolveDiagnose;
          delete window.__v087RejectDiagnose;
          delete window.__v087DiagnoseOriginal;
          delete window.__v087DiagnosePromise;
          delete window.__v087ResolveFix;
          delete window.__v087FixOriginal;
          delete window.__v087FixPromise;
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
        }
      } catch (error) {
        cleanupErrors.push(`project restoration: ${error}`);
      }
      try {
        if (client) await client.send("Emulation.clearDeviceMetricsOverride");
      } catch (error) {
        cleanupErrors.push(`viewport restoration: ${error}`);
      }
      try {
        client?.close();
      } catch (error) {
        cleanupErrors.push(`CDP close: ${error}`);
      }
      try {
        await rm(PROJ, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(`project fixture removal: ${error}`);
      }
      try {
        if (sessionProjectOwned) {
          await rm(SESSION_PROJ, { recursive: true, force: true });
          if (sessionProjectBackup) await rename(sessionProjectBackup, SESSION_PROJ);
          sessionProjectRestored = sessionProjectBackup
            ? await exists(SESSION_PROJ) && !await exists(sessionProjectBackup)
            : !await exists(SESSION_PROJ);
          if (process.env.V087_SESSION_RESTORE_FALSE === "1") sessionProjectRestored = false;
        }
      } catch (error) {
        cleanupErrors.push(`session project restoration: ${error}`);
      }
    }
  } finally {
    try {
      await restoreTemplateFixtures(templateFixtures);
    } catch (error) {
      cleanupErrors.push(`AppData restoration: ${error}`);
    }
  }
  if (cleanupErrors.length > 0) throw new Error(`cleanup failed: ${cleanupErrors.join(" | ")}`);
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
    && files.destinationHasNoEditablePath
    && files.destinationShowsRoot
    && files.nestedBasicDestination
    && files.filenameOnlyValidation
    && files.rootConflictPreserved
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
  const sessionsOk = sessions === true || Object.values(sessions).every(Boolean);
  const sessionProjectStateOk = sessionsExecuted ? sessionProjectRestored : sessionProjectUntouched;
  const browserRestored = cleanupErrors.length === 0
    && JSON.stringify(browserStateAfter) === JSON.stringify(browserStateBefore);
  failed = !filesOk || !themeOk || !pdfOk || !sessionsOk || !sessionProjectStateOk || !browserRestored;
  console.log("FILES", JSON.stringify(files));
  console.log("THEME", JSON.stringify(theme));
  console.log("PDF", JSON.stringify(pdf));
  console.log("SESSIONS", JSON.stringify(sessions));
  console.log("STATE", JSON.stringify({ browserRestored, sessionProjectStateOk, cleanupErrors }));
  console.log("E2E-DONE", failed ? "FAIL" : "PASS", { suite, filesOk, themeOk, pdfOk, sessionsOk, sessionProjectStateOk, browserRestored });
  if (failed) process.exitCode = 1;
}

if (suite === "cleanup-fault") {
  runCleanupFaultProbe().catch((error) => {
    console.error("CLEANUP-FAULT-FAIL", error);
    process.exit(1);
  });
} else {
  main().catch((error) => {
    console.error("E2E-FAIL", error);
    process.exit(1);
  });
}
