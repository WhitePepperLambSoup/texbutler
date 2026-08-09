// e2e: v0.8.7 new-file workflow — toolbar/tree parity and template center.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

if (!new Set(["files", "theme", "pdf", "sessions", "all", "cleanup-fault", "backup-self-test"]).has(suite)) {
  throw new Error(`unknown suite: ${suite}`);
}

const exists = async (path) => access(path).then(() => true, () => false);
const BACKUP_OWNERSHIP = Symbol("v087-backup-ownership");

function defaultBackupToken() {
  return `${process.pid}-${Date.now()}-${randomUUID()}`;
}

async function reserveOwnedBackup(target, tokenFactory = defaultBackupToken) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const token = String(tokenFactory()).replace(/[^A-Za-z0-9._-]/g, "-");
    const container = `${target}.e2e-v087-backup-${token}`;
    try {
      await mkdir(container);
      return {
        [BACKUP_OWNERSHIP]: true,
        target,
        container,
        backup: join(container, "payload"),
        moved: false,
      };
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`could not reserve an exclusive backup for ${target}`);
}

async function moveTargetToOwnedBackup(target, tokenFactory = defaultBackupToken) {
  if (!await exists(target)) return null;
  const owned = await reserveOwnedBackup(target, tokenFactory);
  try {
    await rename(target, owned.backup);
    owned.moved = true;
    return owned;
  } catch (error) {
    await rmdir(owned.container).catch(() => {});
    throw error;
  }
}

async function restoreOwnedBackup(owned, removeOwnedTarget = false) {
  if (!owned?.[BACKUP_OWNERSHIP] || !owned.moved) return false;
  if (!await exists(owned.backup)) {
    throw new Error(`owned backup payload is missing for ${owned.target}`);
  }
  if (await exists(owned.target)) {
    if (!removeOwnedTarget) {
      throw new Error(`refusing to replace an unowned target at ${owned.target}`);
    }
    await rm(owned.target, { recursive: true, force: true });
  }
  await rename(owned.backup, owned.target);
  owned.moved = false;
  await rmdir(owned.container);
  return true;
}

async function installTemplateFixtures(snapshot) {
  if (!USER_TEMPLATE_ROOT) {
    throw new Error("APPDATA is required for state-preserving template fixtures");
  }
  const requestedNonce = process.env.V087_FIXTURE_NONCE;
  const tokenFactory = requestedNonce ? () => requestedNonce : defaultBackupToken;
  const userDir = join(USER_TEMPLATE_ROOT, "article");
  const userFile = join(USER_TEMPLATE_ROOT, "article.tex");
  await mkdir(USER_TEMPLATE_ROOT, { recursive: true });
  for (const target of [userDir, userFile]) {
    const owned = await moveTargetToOwnedBackup(target, tokenFactory);
    if (owned) snapshot.entries.push(owned);
  }
  await mkdir(userDir);
  snapshot.createdTargets.push(userDir);
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

async function writePathSnapshot(path, snapshot) {
  if (snapshot === null) return;
  if (snapshot.type === "directory") {
    await mkdir(path, { recursive: true });
    for (const [name, entry] of Object.entries(snapshot.entries)) {
      await writePathSnapshot(join(path, name), entry);
    }
    return;
  }
  if (snapshot.type === "file") {
    await writeFile(path, Buffer.from(snapshot.data, "base64"));
    return;
  }
  throw new Error(`cannot restore unsupported path type at ${path}`);
}

async function runBackupOwnershipSelfTest() {
  const root = `${PROJ}-backup-self-test-${process.pid}-${randomUUID()}`;
  const cases = [
    { label: "project", target: join(root, "project"), directory: true },
    { label: "appdata", target: join(root, "appdata-template-root"), directory: true },
    { label: "template", target: join(root, "article.tex"), directory: false },
  ];
  const result = {};
  try {
    await mkdir(root, { recursive: true });
    for (const item of cases) {
      if (item.directory) {
        await mkdir(item.target, { recursive: true });
        await writeFile(join(item.target, "current.txt"), `${item.label}-current\n`, "utf8");
      } else {
        await writeFile(item.target, `${item.label}-current\n`, "utf8");
      }
      const before = await snapshotPath(item.target);
      const staleToken = `stale-${item.label}`;
      const staleContainer = `${item.target}.e2e-v087-backup-${staleToken}`;
      const stalePayload = join(staleContainer, "payload");
      await mkdir(staleContainer);
      if (item.directory) {
        await mkdir(stalePayload);
        await writeFile(join(stalePayload, "stale.txt"), `${item.label}-stale\n`, "utf8");
      } else {
        await writeFile(stalePayload, `${item.label}-stale\n`, "utf8");
      }
      const staleBefore = await snapshotPath(staleContainer);
      let tokenAttempt = 0;
      const owned = await moveTargetToOwnedBackup(item.target, () => {
        tokenAttempt += 1;
        return tokenAttempt === 1 ? staleToken : `owned-${item.label}-${randomUUID()}`;
      });
      const fakeStale = {
        target: item.target,
        container: staleContainer,
        backup: stalePayload,
        moved: true,
      };
      const unownedIgnored = !await restoreOwnedBackup(fakeStale, true);
      await restoreOwnedBackup(owned, false);
      result[item.label] = {
        stalePreserved: JSON.stringify(await snapshotPath(staleContainer)) === JSON.stringify(staleBefore),
        currentPreserved: JSON.stringify(await snapshotPath(item.target)) === JSON.stringify(before),
        unownedIgnored,
        ownedReservationReleased: !await exists(owned.container),
      };
    }
    const passed = Object.values(result).every((item) => Object.values(item).every(Boolean));
    console.log("BACKUP-SELF-TEST", JSON.stringify(result));
    if (!passed) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function runSyntheticRootProbes() {
  const probeBase = `${PROJ}-root-probe-${process.pid}-${randomUUID()}`;
  const absentRoot = join(probeBase, "absent");
  const existingRoot = join(probeBase, "existing");
  const failingRoot = join(probeBase, "failing");
  let failurePropagated = false;
  try {
    await mkdir(join(absentRoot, "article"), { recursive: true });
    await writeFile(join(absentRoot, "article", "main.tex"), "fixture", "utf8");
    await restoreTemplateFixtures({
      userRootExisted: false,
      entries: [],
      createdTargets: [join(absentRoot, "article")],
    }, absentRoot);

    await mkdir(join(existingRoot, "article"), { recursive: true });
    await writeFile(join(existingRoot, "keep.txt"), "keep", "utf8");
    await restoreTemplateFixtures({
      userRootExisted: true,
      entries: [],
      createdTargets: [join(existingRoot, "article")],
    }, existingRoot);

    await mkdir(join(failingRoot, "article"), { recursive: true });
    try {
      await restoreTemplateFixtures(
        {
          userRootExisted: false,
          entries: [],
          createdTargets: [join(failingRoot, "article")],
        },
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
  const nonce = `cleanup-fault-${process.pid}-${randomUUID()}`;
  const userDir = join(USER_TEMPLATE_ROOT, "article");
  const userFile = join(USER_TEMPLATE_ROOT, "article.tex");
  const userDirBackupContainer = `${userDir}.e2e-v087-backup-${nonce}`;
  const userFileBackupContainer = `${userFile}.e2e-v087-backup-${nonce}`;
  const rootExisted = await exists(USER_TEMPLATE_ROOT);
  const before = {
    userDir: await snapshotPath(userDir),
    userFile: await snapshotPath(userFile),
    project: await snapshotPath(PROJ),
  };
  if (before.project === null) {
    await mkdir(PROJ, { recursive: true });
    await writeFile(join(PROJ, "preexisting-sentinel.txt"), "V087_PREEXISTING_PROJECT\n", "utf8");
  }
  const childProjectBefore = await snapshotPath(PROJ);
  const projectBackupContainer = `${PROJ}.e2e-v087-backup-${nonce}`;
  let child;
  let after;
  let finalProject;
  try {
    child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "files"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        V087_CLEANUP_FAIL_STAGE: "project",
        V087_FIXTURE_NONCE: nonce,
      },
    });
    after = {
      userDir: await snapshotPath(userDir),
      userFile: await snapshotPath(userFile),
      userDirBackup: await snapshotPath(userDirBackupContainer),
      userFileBackup: await snapshotPath(userFileBackupContainer),
      userRootExists: await exists(USER_TEMPLATE_ROOT),
      project: await snapshotPath(PROJ),
      projectBackup: await snapshotPath(projectBackupContainer),
    };
  } finally {
    for (const [target, original] of [
      [userDir, before.userDir],
      [userFile, before.userFile],
      [PROJ, before.project],
    ]) {
      const current = await snapshotPath(target);
      if (JSON.stringify(current) !== JSON.stringify(original)) {
        await rm(target, { recursive: true, force: true }).catch(() => {});
        await writePathSnapshot(target, original);
      }
    }
    if (!rootExisted) await rm(USER_TEMPLATE_ROOT).catch(() => {});
    finalProject = await snapshotPath(PROJ);
  }
  const combinedOutput = `${child?.stdout ?? ""}\n${child?.stderr ?? ""}`;
  const synthetic = await runSyntheticRootProbes();
  const result = {
    childReportedFailure: child?.status !== 0 && combinedOutput.includes("E2E-FAIL")
      && combinedOutput.includes("injected cleanup failure: project"),
    appDataRestored: JSON.stringify(after?.userDir) === JSON.stringify(before.userDir)
      && JSON.stringify(after?.userFile) === JSON.stringify(before.userFile)
      && after?.userDirBackup === null && after?.userFileBackup === null
      && after?.userRootExists === rootExisted,
    projectFixtureRestored: JSON.stringify(after?.project) === JSON.stringify(childProjectBefore)
      && after?.projectBackup === null,
    originalProjectRestored: JSON.stringify(finalProject) === JSON.stringify(before.project),
    synthetic,
    childStatus: child?.status ?? null,
    childSignal: child?.signal ?? null,
    childError: child?.error ? String(child.error) : null,
  };
  if (!result.childReportedFailure) result.childOutput = combinedOutput.slice(-2000);
  console.log("CLEANUP-FAULT", JSON.stringify(result));
  if (!result.childReportedFailure || !result.appDataRestored || !result.projectFixtureRestored
    || !result.originalProjectRestored
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
  for (const target of [...(snapshot.createdTargets ?? [])].reverse()) {
    await remove(target, { recursive: true, force: true });
  }
  for (const owned of [...snapshot.entries].reverse()) {
    await restoreOwnedBackup(owned, false);
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
  let projectBackup = null;
  let projectOwned = false;
  let projectRestored = true;
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
        createdTargets: [],
      };
      await installTemplateFixtures(templateFixtures);
      if (sessionsExecuted) {
        sessionProjectBackup = await moveTargetToOwnedBackup(SESSION_PROJ);
        await mkdir(SESSION_PROJ);
        sessionProjectOwned = true;
        await mkdir(`${SESSION_PROJ}/contents`);
        await writeFile(`${SESSION_PROJ}/main.tex`, "\\documentclass{article}\nSynthetic session fixture.\n", "utf8");
        await writeFile(`${SESSION_PROJ}/contents/abstract.tex`, "Synthetic abstract fixture.\n", "utf8");
      }
      sessionProjectUntouched = !sessionProjectOwned;
      const requestedNonce = process.env.V087_FIXTURE_NONCE;
      projectBackup = await moveTargetToOwnedBackup(
        PROJ,
        requestedNonce ? () => requestedNonce : defaultBackupToken,
      );
      await mkdir(PROJ);
      projectOwned = true;
      await writeFile(FILE, "\\documentclass{article}\n\\begin{document}\nE2E fixture.\n\\end{document}\n", "utf8");
      await mkdir(`${PROJ}/contents`);
      await writeFile(`${PROJ}/contents/abstract.tex`, "Abstract fixture.\n", "utf8");
      await writeFile(`${PROJ}/contents/anchor.tex`, "Anchor fixture.\n", "utf8");
      await mkdir(`${PROJ}/contents/user-zone`);
      await writeFile(`${PROJ}/contents/user-zone/anchor.tex`, "User zone.\n", "utf8");
      await mkdir(`${PROJ}/contents/market-zone`);
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
        overflowMenuSurfaces: {},
        disabledItemsVisuallyDistinct: {},
        aiContentContrast: {},
        aiContentStateRestored: false,
        brightGradientRejected: false,
        brightGradientContrast: 0,
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
      const inspectMenuSurface = async (menuSelector, itemSelector) => {
        const prepared = JSON.parse(await exec(`(() => {
          const menu = document.querySelector(${JSON.stringify(menuSelector)});
          const item = menu?.querySelector(${JSON.stringify(itemSelector)});
          if (!menu || !item) return JSON.stringify({ opened: false });
          const colorAlpha = (value) => {
            const match = value.match(/rgba?\\(([^)]+)\\)/);
            if (!match) return 0;
            const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
            return parts[3] ?? 1;
          };
          const splitLayers = (value) => {
            const layers = [];
            let depth = 0;
            let start = 0;
            for (let index = 0; index < value.length; index += 1) {
              if (value[index] === '(') depth += 1;
              else if (value[index] === ')') depth -= 1;
              else if (value[index] === ',' && depth === 0) {
                layers.push(value.slice(start, index));
                start = index + 1;
              }
            }
            layers.push(value.slice(start));
            return layers;
          };
          const menuStyle = getComputedStyle(menu);
          let surfaceAlpha = colorAlpha(menuStyle.backgroundColor);
          for (const layer of splitLayers(menuStyle.backgroundImage)) {
            if (layer.trim() === 'none') continue;
            const colors = [...layer.matchAll(/rgba?\\([^)]+\\)/g)].map((match) => colorAlpha(match[0]));
            if (colors.length === 0) continue;
            const minimumLayerAlpha = Math.min(...colors);
            surfaceAlpha = minimumLayerAlpha + surfaceAlpha * (1 - minimumLayerAlpha);
          }
          const rect = item.getBoundingClientRect();
          const descendants = [...item.querySelectorAll('*')].map((node) => ({
            value: node.style.getPropertyValue('visibility'),
            priority: node.style.getPropertyPriority('visibility'),
          }));
          const itemColor = {
            value: item.style.getPropertyValue('color'),
            priority: item.style.getPropertyPriority('color'),
          };
          const itemStyle = getComputedStyle(item);
          const foreground = itemStyle.color;
          const cursor = itemStyle.cursor;
          const opacity = Number(itemStyle.opacity);
          item.style.setProperty('color', 'transparent', 'important');
          [...item.querySelectorAll('*')].forEach((node) => {
            node.style.setProperty('visibility', 'hidden', 'important');
          });
          return JSON.stringify({
            opened: true,
            rect: {
              x: rect.left + window.scrollX,
              y: rect.top + window.scrollY,
              width: rect.width,
              height: rect.height,
            },
            foreground,
            cursor,
            opacity,
            surfaceAlpha,
            itemColor,
            descendants,
          });
        })()`));
        if (!prepared.opened) return { opened: false, surfaceAlpha: 0, contrast: 0 };
        try {
          await sleep(50);
          const screenshot = await client.send("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
            clip: { ...prepared.rect, scale: 1 },
          });
          const contrast = Number(await exec(`(async () => {
            const parse = (value) => {
              const match = value.match(/rgba?\\(([^)]+)\\)/);
              if (!match) return { r: 0, g: 0, b: 0, a: 0 };
              const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
              return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
            };
            const over = (front, back) => ({
              r: front.r * front.a + back.r * (1 - front.a),
              g: front.g * front.a + back.g * (1 - front.a),
              b: front.b * front.a + back.b * (1 - front.a),
              a: 1,
            });
            const luminance = ({ r, g, b }) => {
              const linear = [r, g, b].map((channel) => {
                const value = channel / 255;
                return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
              });
              return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
            };
            const image = new Image();
            image.src = ${JSON.stringify(`data:image/png;base64,${screenshot.data}`)};
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context || canvas.width < 5 || canvas.height < 5) return 0;
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            const foreground = parse(${JSON.stringify(prepared.foreground)});
            foreground.a *= ${JSON.stringify(prepared.opacity)};
            let minimumContrast = Infinity;
            for (let y = 2; y < canvas.height - 2; y += 1) {
              for (let x = 2; x < canvas.width - 2; x += 1) {
                const offset = (y * canvas.width + x) * 4;
                const background = {
                  r: pixels[offset],
                  g: pixels[offset + 1],
                  b: pixels[offset + 2],
                  a: pixels[offset + 3] / 255,
                };
                const renderedForeground = over(foreground, background);
                const foregroundLuminance = luminance(renderedForeground);
                const backgroundLuminance = luminance(background);
                const ratio = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
                  / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
                minimumContrast = Math.min(minimumContrast, ratio);
              }
            }
            return Number.isFinite(minimumContrast) ? minimumContrast : 0;
          })()`));
          return {
            opened: true,
            surfaceAlpha: prepared.surfaceAlpha,
            contrast,
            foreground: prepared.foreground,
            cursor: prepared.cursor,
            opacity: prepared.opacity,
          };
        } finally {
          await exec(`(() => {
            const menu = document.querySelector(${JSON.stringify(menuSelector)});
            const item = menu?.querySelector(${JSON.stringify(itemSelector)});
            if (!item) return;
            const prepared = ${JSON.stringify(prepared)};
            if (prepared.itemColor.value) {
              item.style.setProperty('color', prepared.itemColor.value, prepared.itemColor.priority);
            } else {
              item.style.removeProperty('color');
            }
            [...item.querySelectorAll('*')].forEach((node, index) => {
              const original = prepared.descendants[index];
              if (!original) return;
              if (original.value) node.style.setProperty('visibility', original.value, original.priority);
              else node.style.removeProperty('visibility');
            });
          })()`);
        }
      };
      const inspectBrightGradientMutation = async (menuSelector, itemSelector) => {
        const original = JSON.parse(await exec(`(() => {
          const menu = document.querySelector(${JSON.stringify(menuSelector)});
          if (!menu) return JSON.stringify(null);
          const property = 'background-image';
          const snapshot = {
            value: menu.style.getPropertyValue(property),
            priority: menu.style.getPropertyPriority(property),
          };
          menu.style.setProperty(
            property,
            'linear-gradient(rgba(255, 255, 255, 0.98), rgba(255, 255, 255, 0.98))',
            'important',
          );
          return JSON.stringify(snapshot);
        })()`));
        if (!original) return { opened: false, surfaceAlpha: 0, contrast: 0 };
        try {
          await sleep(50);
          return await inspectMenuSurface(menuSelector, itemSelector);
        } finally {
          await exec(`(() => {
            const menu = document.querySelector(${JSON.stringify(menuSelector)});
            if (!menu) return;
            const property = 'background-image';
            const original = ${JSON.stringify(original)};
            if (original.value) menu.style.setProperty(property, original.value, original.priority);
            else menu.style.removeProperty(property);
          })()`);
        }
      };
      const inspectDisabledMutation = async (menuSelector, itemSelector) => {
        const original = JSON.parse(await exec(`(() => {
          const item = document.querySelector(${JSON.stringify(menuSelector)})
            ?.querySelector(${JSON.stringify(itemSelector)});
          if (!(item instanceof HTMLButtonElement)) return JSON.stringify(null);
          const snapshot = {
            disabled: item.disabled,
            probe: item.getAttribute('data-v087-disabled-probe'),
          };
          item.setAttribute('data-v087-disabled-probe', 'true');
          item.disabled = true;
          return JSON.stringify(snapshot);
        })()`));
        if (!original) return { opened: false, surfaceAlpha: 0, contrast: 0 };
        try {
          await sleep(50);
          return await inspectMenuSurface(menuSelector, '[data-v087-disabled-probe="true"]');
        } finally {
          await exec(`(() => {
            const item = document.querySelector(${JSON.stringify(menuSelector)})
              ?.querySelector('[data-v087-disabled-probe="true"]');
            if (!(item instanceof HTMLButtonElement)) return;
            item.disabled = ${JSON.stringify(original.disabled)};
            const probe = ${JSON.stringify(original.probe)};
            if (probe === null) item.removeAttribute('data-v087-disabled-probe');
            else item.setAttribute('data-v087-disabled-probe', probe);
          })()`);
        }
      };
      const colorDistance = (first, second) => {
        const channels = (value) => {
          const match = value?.match(/rgba?\(([^)]+)\)/);
          return match ? match[1].split(/[ ,/]+/).filter(Boolean).slice(0, 3).map(Number) : [];
        };
        const a = channels(first);
        const b = channels(second);
        if (a.length !== 3 || b.length !== 3) return 0;
        return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      };

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
      if (await exec(`!!document.querySelector('.ai-rail-toggle')`)) {
        await clickSelector('.ai-rail-toggle');
      }
      for (const [id, index] of [["liquid", 1], ["dark", 2], ["light", 3]]) {
        if (!await clickSelector('.theme-picker-btn')) continue;
        if (!await clickSelector(`.theme-picker-menu .theme-option:nth-child(${index})`)) continue;
        result.themeSelections[id] = JSON.parse(await exec(`JSON.stringify(
          document.documentElement.dataset.theme === ${JSON.stringify(id)}
            && window.localStorage.getItem('tb-theme') === ${JSON.stringify(id)}
        )`));
        const editorOpened = await clickSelector('.editor-more-action');
        const editorNormal = editorOpened
          ? await inspectMenuSurface('.editor-tools-menu', 'button:not(:disabled)')
          : { opened: false, surfaceAlpha: 0, contrast: 0 };
        const editorDisabled = editorOpened
          ? await inspectDisabledMutation('.editor-tools-menu', 'button:not(:disabled)')
          : { opened: false, surfaceAlpha: 0, contrast: 0 };
        if (id === "liquid" && editorNormal.opened) {
          const brightMutation = await inspectBrightGradientMutation(
            '.editor-tools-menu',
            'button:not(:disabled)',
          );
          result.brightGradientContrast = brightMutation.contrast;
          result.brightGradientRejected = brightMutation.opened && brightMutation.contrast < 4.5;
        }
        if (editorNormal.opened) await pressEscape();
        const aiOpened = await clickSelector('.ai-menu-anchor > button');
        const aiNormal = aiOpened
          ? await inspectMenuSurface('.ai-menu', '.ai-menu-item:not(:disabled):not(.danger)')
          : { opened: false, surfaceAlpha: 0, contrast: 0 };
        const aiDanger = aiOpened
          ? await inspectMenuSurface('.ai-menu', '.ai-menu-item.danger:not(:disabled)')
          : { opened: false, surfaceAlpha: 0, contrast: 0 };
        const aiDisabled = aiOpened
          ? await inspectDisabledMutation('.ai-menu', '.ai-menu-item:not(:disabled):not(.danger)')
          : { opened: false, surfaceAlpha: 0, contrast: 0 };
        if (aiNormal.opened) await pressEscape();
        result.overflowMenuSurfaces[id] = {
          editor: { normal: editorNormal, disabled: editorDisabled },
          ai: { normal: aiNormal, danger: aiDanger, disabled: aiDisabled },
        };
        result.disabledItemsVisuallyDistinct[id] = [
          [editorNormal, editorDisabled],
          [aiNormal, aiDisabled],
        ].every(([normal, disabled]) => (
          disabled.opened
          && disabled.cursor === 'default'
          && disabled.opacity >= 0.99
          && colorDistance(normal.foreground, disabled.foreground) >= 20
        ));
        if (id === "light") {
          const prepared = await exec(`(async () => {
            const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
            const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
              ?? '/src/store/aiStore.ts';
            const { useAiStore } = await import(aiUrl);
            const state = useAiStore.getState();
            window.__v087AiContrastSnapshot = {
              messages: state.messages,
              lastEdits: state.lastEdits,
              diffPending: state.diffPending,
              activeProjectRoot: state.activeProjectRoot,
              activeFile: state.activeFile,
            };
            const root = state.activeProjectRoot || ${JSON.stringify(PROJ)};
            const file = state.activeFile || 'main.tex';
            useAiStore.setState({
              messages: [
                { id: 870001, role: 'assistant', kind: 'plain', text: 'V087_ASSISTANT_NORMAL' },
                { id: 870002, role: 'assistant', kind: 'plain', text: '**V087_ASSISTANT_STRONG**' },
                { id: 870003, role: 'assistant', kind: 'plain', text: '\`V087_ASSISTANT_CODE\`' },
                { id: 870004, role: 'system', kind: 'plain', text: 'V087_SYSTEM_NORMAL' },
                { id: 870005, role: 'system', kind: 'plain', text: '**V087_SYSTEM_STRONG**' },
                { id: 870006, role: 'system', kind: 'plain', text: '\`V087_SYSTEM_CODE\`' },
                { id: 870007, role: 'assistant', kind: 'plain', text: 'V087_DIFF_OWNER', applied: true },
              ],
              lastEdits: [{
                file,
                backup: 'V087_CONTRAST_BACKUP',
                diff: '+V087_ADDED_CONTENT\\n-V087_DELETED_CONTENT',
                sessionId: state.sessionId,
                projectRoot: root,
                requestFile: file,
              }],
              diffPending: null,
              activeProjectRoot: root,
              activeFile: file,
            });
            return true;
          })()`);
          if (prepared) {
            await sleep(100);
            await exec(`(() => {
              const mark = (text, value) => {
                const node = [...document.querySelectorAll('.ai-msg')]
                  .find((candidate) => candidate.textContent?.includes(text));
                if (node) node.setAttribute('data-v087-ai-contrast', value);
              };
              mark('V087_ASSISTANT_NORMAL', 'assistant-normal');
              mark('V087_ASSISTANT_STRONG', 'assistant-strong');
              mark('V087_ASSISTANT_CODE', 'assistant-code');
              mark('V087_SYSTEM_NORMAL', 'system-normal');
              mark('V087_SYSTEM_STRONG', 'system-strong');
              mark('V087_SYSTEM_CODE', 'system-code');
              mark('V087_DIFF_OWNER', 'diff-owner');
              document.querySelector('[data-v087-ai-contrast="diff-owner"] .diff-view')
                ?.setAttribute('data-v087-ai-diff', 'true');
              return true;
            })()`);
            try {
              result.aiContentContrast = {
                assistantNormal: await inspectMenuSurface('[data-v087-ai-contrast="assistant-normal"]', '.ai-text'),
                assistantStrong: await inspectMenuSurface('[data-v087-ai-contrast="assistant-strong"]', '.ai-text b, .ai-text strong'),
                assistantCode: await inspectMenuSurface('[data-v087-ai-contrast="assistant-code"]', '.ai-text code'),
                systemNormal: await inspectMenuSurface('[data-v087-ai-contrast="system-normal"]', '.ai-text'),
                systemStrong: await inspectMenuSurface('[data-v087-ai-contrast="system-strong"]', '.ai-text b, .ai-text strong'),
                systemCode: await inspectMenuSurface('[data-v087-ai-contrast="system-code"]', '.ai-text code'),
                diffAdded: await inspectMenuSurface('[data-v087-ai-diff="true"]', '.diff-line.add'),
                diffDeleted: await inspectMenuSurface('[data-v087-ai-diff="true"]', '.diff-line.del'),
              };
            } finally {
              result.aiContentStateRestored = JSON.parse(await exec(`(async () => {
                const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
                const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
                  ?? '/src/store/aiStore.ts';
                const { useAiStore } = await import(aiUrl);
                const snapshot = window.__v087AiContrastSnapshot;
                if (!snapshot) return JSON.stringify(false);
                useAiStore.setState(snapshot);
                delete window.__v087AiContrastSnapshot;
                const restored = useAiStore.getState();
                return JSON.stringify(
                  restored.messages === snapshot.messages
                    && restored.lastEdits === snapshot.lastEdits
                    && restored.diffPending === snapshot.diffPending
                    && restored.activeProjectRoot === snapshot.activeProjectRoot
                    && restored.activeFile === snapshot.activeFile
                );
              })()`));
            }
          }
        }
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
          dragMovedPane: Math.abs((afterDrag.paneWidth ?? 0) - (empty.paneWidth ?? 0) + 40) <= 3,
          dragSavedWidth: Math.abs((afterDrag.savedWidth ?? 0) - (empty.savedWidth ?? 0) + 40) <= 3,
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
          lastEdits: ai.lastEdits,
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
      const ensureAiRailOpen = async () => {
        const collapsed = await exec(`document.querySelector('.ai-rail')?.classList.contains('collapsed') ?? true`);
        if (collapsed) await clickSelector('.ai-rail-toggle');
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const open = await exec(`document.querySelector('.ai-rail')?.classList.contains('open') ?? false`);
          if (open) return true;
          await sleep(50);
        }
        return false;
      };

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
      result.aiRailOpenedForSessionUi = await ensureAiRailOpen();
      const bindingSemantics = JSON.parse(await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const bindingsUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiSessionBindings.ts') && new URL(name).search)
          ?? '/src/store/aiSessionBindings.ts';
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const { bindingKey } = await import(bindingsUrl);
        const { aiEditBelongsToScope } = await import(aiUrl);
        const edit = {
          file: 'Contents/Abstract.TEX',
          backup: 'case-probe',
          diff: '+case probe',
          sessionId: 'case-session',
          projectRoot: 'C:\\\\Work\\\\Paper',
          requestFile: 'Contents\\\\Abstract.TEX',
        };
        return JSON.stringify({
          windows: bindingKey('C:\\\\Work\\\\Paper', 'Contents\\\\Abstract.TEX')
            === bindingKey('c:/work/paper', 'contents/abstract.tex'),
          posix: bindingKey('/Projects/Paper', 'Contents/Abstract.TEX')
            !== bindingKey('/Projects/Paper', 'contents/abstract.tex'),
          windowsEditScope: aiEditBelongsToScope(
            edit,
            'case-session',
            'c:/work/paper',
            'contents/abstract.tex',
          ),
        });
      })()`));
      result.windowsBindingCaseInsensitive = bindingSemantics.windows;
      result.posixBindingCaseSensitive = bindingSemantics.posix;
      result.windowsEditScopeCaseInsensitive = bindingSemantics.windowsEditScope;
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
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const eventUrl = resources.find((name) => new URL(name).pathname.includes('/node_modules/.vite/deps/@tauri-apps_api_event.js'));
        if (!eventUrl) throw new Error('Tauri event module URL not found');
        const { emit } = await import(eventUrl);
        await emit('tb://ai-edit', {
          file: 'contents/abstract.tex', backup: 'V087_OWNED_BACKUP', diff: '+owned edit',
        });
        return true;
      })()`);
      await sleep(100);
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
      result.aiEditOwnedByRequestContext = afterAsyncSwitch.lastEdits.some((edit) => (
        edit.backup === 'V087_OWNED_BACKUP'
        && edit.sessionId === second.sessionId
        && edit.projectRoot === second.root
        && edit.requestFile === 'contents/abstract.tex'
      )) && !await exec(`Boolean(document.querySelector('.ai-generate-actions .btn-danger'))`);
      const foreignRollbackCalls = await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { useAiStore } = await import(aiUrl);
        const { api } = await import(apiUrl);
        window.__v087OwnedRollbackOriginal = api.aiRollback;
        window.__v087OwnedRollbackCalls = 0;
        api.aiRollback = async () => {
          window.__v087OwnedRollbackCalls += 1;
          return 'contents/abstract.tex';
        };
        await useAiStore.getState().rollbackEdit('contents/abstract.tex');
        return window.__v087OwnedRollbackCalls;
      })()`);
      result.foreignRollbackCannotExecute = foreignRollbackCalls === 0;
      await openFile('contents/abstract.tex');
      result.ownerRollbackVisibleOnReturn = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        result.ownerRollbackVisibleOnReturn = await exec(`Boolean(document.querySelector('.ai-generate-actions .btn-danger'))`);
        if (result.ownerRollbackVisibleOnReturn) break;
        await sleep(50);
      }
      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { api } = await import(apiUrl);
        api.aiRollback = () => new Promise((resolve) => {
          window.__v087OwnedRollbackStarted = true;
          window.__v087ResolveOwnedRollback = resolve;
        });
        return true;
      })()`);
      if (result.ownerRollbackVisibleOnReturn) {
        await clickSelector('.ai-generate-actions .btn-danger');
      }
      let ownedRollbackStarted = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        ownedRollbackStarted = await exec(`Boolean(window.__v087OwnedRollbackStarted)`);
        if (ownedRollbackStarted) break;
        await sleep(50);
      }
      await openFile('main.tex');
      await exec(`(() => {
        window.__v087ResolveOwnedRollback?.('contents/abstract.tex');
        return true;
      })()`);
      await sleep(300);
      const afterOwnedRollback = await aiState();
      const rollbackTarget = afterOwnedRollback.sessions.find((session) => session.id === second.sessionId);
      result.rollbackMessageStaysWithOwner = ownedRollbackStarted
        && rollbackTarget?.messages.some((message) => message.text.includes('contents/abstract.tex'))
        && !afterOwnedRollback.messages.some((message) => message.text.includes('contents/abstract.tex'))
        && !afterOwnedRollback.lastEdits.some((edit) => edit.backup === 'V087_OWNED_BACKUP');
      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { api } = await import(apiUrl);
        if (window.__v087OwnedRollbackOriginal) api.aiRollback = window.__v087OwnedRollbackOriginal;
        delete window.__v087OwnedRollbackOriginal;
        delete window.__v087OwnedRollbackCalls;
        delete window.__v087OwnedRollbackStarted;
        delete window.__v087ResolveOwnedRollback;
        return true;
      })()`);

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

      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const i18nUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/i18n/index.ts') && new URL(name).search)
          ?? '/src/i18n/index.ts';
        const { useAiStore } = await import(aiUrl);
        const { api } = await import(apiUrl);
        const { useI18n } = await import(i18nUrl);
        window.__v087TimelineRollbackOriginal = api.aiRollback;
        api.aiRollback = () => new Promise((resolve) => { window.__v087ResolveTimeline = resolve; });
        const action = useAiStore.getState().restoreTimelineSnapshot;
        window.__v087TimelinePromise = typeof action === 'function'
          ? action('timeline-snapshot')
          : api.aiRollback('timeline-snapshot').then((rel) => {
              useAiStore.getState().pushMessage({
                role: 'system', kind: 'plain', text: useI18n.getState().t('ai.timelineRestored', { file: rel }),
              });
              return rel;
            });
        return true;
      })()`);
      await sleep(100);
      await openFile('main.tex');
      await exec(`(async () => {
        window.__v087ResolveTimeline?.('contents/abstract.tex');
        await window.__v087TimelinePromise;
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { api } = await import(apiUrl);
        if (window.__v087TimelineRollbackOriginal) api.aiRollback = window.__v087TimelineRollbackOriginal;
        delete window.__v087TimelineRollbackOriginal;
        delete window.__v087ResolveTimeline;
        delete window.__v087TimelinePromise;
        return true;
      })()`);
      const afterTimelineSwitch = await aiState();
      const timelineTarget = afterTimelineSwitch.sessions.find((session) => session.id === second.sessionId);
      result.timelineRestoreStaysWithRequestSession = timelineTarget?.messages.some((message) => message.role === 'system' && message.text.includes('contents/abstract.tex'))
        && !afterTimelineSwitch.messages.some((message) => message.text.includes('contents/abstract.tex'));
      await openFile('contents/abstract.tex');

      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const compileUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/compileStore.ts') && new URL(name).search)
          ?? '/src/store/compileStore.ts';
        const { useAiStore } = await import(aiUrl);
        const { api } = await import(apiUrl);
        const { useCompileStore } = await import(compileUrl);
        window.__v087RuleFixOriginal = api.fixRuleIssue;
        window.__v087RunCheckOriginal = useCompileStore.getState().runCheck;
        useCompileStore.setState({ runCheck: async () => {} });
        api.fixRuleIssue = () => new Promise((resolve) => { window.__v087ResolveRuleFix = resolve; });
        const issue = { message: 'ASYNC_RULE_SUCCESS_REQUEST', severity: 'error', file: 'contents/abstract.tex', line: 5 };
        const action = useAiStore.getState().fixRuleIssueForSession;
        window.__v087RuleFixPromise = typeof action === 'function'
          ? action(issue, 3, true)
          : api.fixRuleIssue(issue, 3, true).then(async (report) => {
              await useCompileStore.getState().runCheck();
              useAiStore.getState().pushMessage({ role: 'assistant', kind: 'fix', text: report.summary, report });
              return report;
            });
        return true;
      })()`);
      await sleep(100);
      await openFile('main.tex');
      await exec(`(async () => {
        window.__v087ResolveRuleFix?.({ ok: true, rounds: 1, summary: 'ASYNC_RULE_SUCCESS_DONE', diff: 'rule diff' });
        await window.__v087RuleFixPromise;
        return true;
      })()`);
      const afterRuleSuccess = await aiState();
      const ruleSuccessTarget = afterRuleSuccess.sessions.find((session) => session.id === second.sessionId);
      result.ruleFixSuccessStaysWithRequestSession = ruleSuccessTarget?.messages.some((message) => message.text.includes('ASYNC_RULE_SUCCESS_DONE'))
        && !afterRuleSuccess.messages.some((message) => message.text.includes('ASYNC_RULE_SUCCESS_DONE'));
      await openFile('contents/abstract.tex');
      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { useAiStore } = await import(aiUrl);
        const { api } = await import(apiUrl);
        api.fixRuleIssue = () => new Promise((_, reject) => { window.__v087RejectRuleFix = reject; });
        const issue = { message: 'ASYNC_RULE_ERROR_REQUEST', severity: 'error', file: 'contents/abstract.tex', line: 6 };
        const action = useAiStore.getState().fixRuleIssueForSession;
        window.__v087RuleFixPromise = typeof action === 'function'
          ? action(issue, 3, true)
          : api.fixRuleIssue(issue, 3, true).catch((error) => {
              useAiStore.getState().pushMessage({ role: 'assistant', kind: 'error', text: String(error) });
              return null;
            });
        return true;
      })()`);
      await sleep(100);
      await openFile('main.tex');
      await exec(`(async () => {
        window.__v087RejectRuleFix?.(new Error('ASYNC_RULE_ERROR_DONE'));
        await window.__v087RuleFixPromise;
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const compileUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/compileStore.ts') && new URL(name).search)
          ?? '/src/store/compileStore.ts';
        const { api } = await import(apiUrl);
        const { useCompileStore } = await import(compileUrl);
        if (window.__v087RuleFixOriginal) api.fixRuleIssue = window.__v087RuleFixOriginal;
        if (window.__v087RunCheckOriginal) useCompileStore.setState({ runCheck: window.__v087RunCheckOriginal });
        delete window.__v087RuleFixOriginal;
        delete window.__v087RunCheckOriginal;
        delete window.__v087ResolveRuleFix;
        delete window.__v087RejectRuleFix;
        delete window.__v087RuleFixPromise;
        return true;
      })()`);
      const afterRuleError = await aiState();
      const ruleErrorTarget = afterRuleError.sessions.find((session) => session.id === second.sessionId);
      result.ruleFixErrorStaysWithRequestSession = ruleErrorTarget?.messages.some((message) => message.text.includes('ASYNC_RULE_ERROR_DONE'))
        && !afterRuleError.messages.some((message) => message.text.includes('ASYNC_RULE_ERROR_DONE'));
      await openFile('contents/abstract.tex');

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

      await openSessionProject(PROJ, 'contents/abstract.tex');
      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { useAiStore } = await import(aiUrl);
        const { api } = await import(apiUrl);
        window.__v087SecondaryRollbackOriginal = api.aiRollback;
        window.__v087SecondaryReadOriginal = api.readFile;
        window.__v087SecondaryReadArmed = true;
        api.aiRollback = async () => 'contents/abstract.tex';
        api.readFile = (path) => {
          if (path === 'contents/abstract.tex' && window.__v087SecondaryReadArmed) {
            window.__v087SecondaryReadArmed = false;
            window.__v087SecondaryReadStarted = true;
            return new Promise((resolve) => { window.__v087ResolveSecondaryRead = resolve; });
          }
          return window.__v087SecondaryReadOriginal(path);
        };
        window.__v087SecondaryTimelinePromise = useAiStore.getState().restoreTimelineSnapshot('secondary-await-snapshot');
        return true;
      })()`);
      let secondaryReadStarted = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        secondaryReadStarted = await exec(`Boolean(window.__v087SecondaryReadStarted)`);
        if (secondaryReadStarted) break;
        await sleep(50);
      }
      if (!secondaryReadStarted) throw new Error('secondary timeline read did not start');
      await openSessionProject(SESSION_PROJ, 'contents/abstract.tex');
      const secondProjectContentBeforeStaleRead = await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const projectUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
          ?? '/src/store/projectStore.ts';
        const { useProjectStore } = await import(projectUrl);
        return useProjectStore.getState().tabs.find((tab) => tab.path === 'contents/abstract.tex')?.content ?? null;
      })()`);
      await exec(`(async () => {
        window.__v087ResolveSecondaryRead?.('STALE_A_TIMELINE_CONTENT');
        await window.__v087SecondaryTimelinePromise;
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { api } = await import(apiUrl);
        if (window.__v087SecondaryRollbackOriginal) api.aiRollback = window.__v087SecondaryRollbackOriginal;
        if (window.__v087SecondaryReadOriginal) api.readFile = window.__v087SecondaryReadOriginal;
        delete window.__v087SecondaryRollbackOriginal;
        delete window.__v087SecondaryReadOriginal;
        delete window.__v087SecondaryReadArmed;
        delete window.__v087SecondaryReadStarted;
        delete window.__v087ResolveSecondaryRead;
        delete window.__v087SecondaryTimelinePromise;
        return true;
      })()`);
      const secondProjectContentAfterStaleRead = await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const projectUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
          ?? '/src/store/projectStore.ts';
        const { useProjectStore } = await import(projectUrl);
        return useProjectStore.getState().tabs.find((tab) => tab.path === 'contents/abstract.tex')?.content ?? null;
      })()`);
      result.secondaryTimelineReadCannotOverwriteNewProject = secondProjectContentBeforeStaleRead === 'Synthetic abstract fixture.\n'
        && secondProjectContentAfterStaleRead === secondProjectContentBeforeStaleRead;

      await openSessionProject(PROJ, 'contents/abstract.tex');
      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { useAiStore } = await import(aiUrl);
        const { api } = await import(apiUrl);
        window.__v087SecondaryRuleFixOriginal = api.fixRuleIssue;
        window.__v087SecondaryRunCheckOriginal = api.runCheck;
        window.__v087SecondaryCheckArmed = true;
        api.fixRuleIssue = async () => ({ ok: true, rounds: 1, summary: 'secondary check report', diff: null });
        api.runCheck = () => {
          if (window.__v087SecondaryCheckArmed) {
            window.__v087SecondaryCheckArmed = false;
            window.__v087SecondaryCheckStarted = true;
            return new Promise((resolve) => { window.__v087ResolveSecondaryCheck = resolve; });
          }
          return window.__v087SecondaryRunCheckOriginal();
        };
        window.__v087SecondaryRulePromise = useAiStore.getState().fixRuleIssueForSession({
          message: 'secondary ownership rule', severity: 'error', file: 'contents/abstract.tex', line: 7,
        }, 3, true);
        return true;
      })()`);
      let secondaryCheckStarted = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        secondaryCheckStarted = await exec(`Boolean(window.__v087SecondaryCheckStarted)`);
        if (secondaryCheckStarted) break;
        await sleep(50);
      }
      if (!secondaryCheckStarted) throw new Error('secondary rule check did not start');
      await openSessionProject(SESSION_PROJ, 'contents/abstract.tex');
      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const compileUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/compileStore.ts') && new URL(name).search)
          ?? '/src/store/compileStore.ts';
        const { useCompileStore } = await import(compileUrl);
        useCompileStore.setState({
          ruleIssues: [{ message: 'B_RULE_SENTINEL', severity: 'info', file: 'main.tex', line: 1 }],
        });
        window.__v087ResolveSecondaryCheck?.({
          issues: [{ message: 'STALE_A_RULE_ISSUE', severity: 'error', file: 'contents/abstract.tex', line: 7 }],
        });
        await window.__v087SecondaryRulePromise;
        return true;
      })()`);
      const secondaryRuleState = JSON.parse(await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const compileUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/compileStore.ts') && new URL(name).search)
          ?? '/src/store/compileStore.ts';
        const { api } = await import(apiUrl);
        const { useCompileStore } = await import(compileUrl);
        const state = useCompileStore.getState();
        if (window.__v087SecondaryRuleFixOriginal) api.fixRuleIssue = window.__v087SecondaryRuleFixOriginal;
        if (window.__v087SecondaryRunCheckOriginal) api.runCheck = window.__v087SecondaryRunCheckOriginal;
        return JSON.stringify({ ruleIssues: state.ruleIssues, checkRunning: state.checkRunning });
      })()`));
      result.secondaryRuleCheckCannotOverwriteNewProject = secondaryRuleState.ruleIssues.length === 1
        && secondaryRuleState.ruleIssues[0].message === 'B_RULE_SENTINEL'
        && secondaryRuleState.checkRunning === false;
      await exec(`(() => {
        delete window.__v087SecondaryRuleFixOriginal;
        delete window.__v087SecondaryRunCheckOriginal;
        delete window.__v087SecondaryCheckArmed;
        delete window.__v087SecondaryCheckStarted;
        delete window.__v087ResolveSecondaryCheck;
        delete window.__v087SecondaryRulePromise;
        return true;
      })()`);

      await openSessionProject(PROJ, 'contents/abstract.tex');
      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const projectUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
          ?? '/src/store/projectStore.ts';
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { useProjectStore } = await import(projectUrl);
        const { api } = await import(apiUrl);
        window.__v087ReloadReadOriginal = api.readFile;
        window.__v087ReloadResolvers = [];
        window.__v087ReloadCalls = 0;
        api.readFile = (path) => {
          if (path === 'contents/abstract.tex' && window.__v087ReloadCalls < 2) {
            const call = window.__v087ReloadCalls++;
            return new Promise((resolve) => { window.__v087ReloadResolvers[call] = resolve; });
          }
          return window.__v087ReloadReadOriginal(path);
        };
        window.__v087ReloadPromises = [
          useProjectStore.getState().reloadTab('contents/abstract.tex'),
          useProjectStore.getState().reloadTab('contents/abstract.tex'),
        ];
        return true;
      })()`);
      await sleep(100);
      await exec(`(async () => {
        window.__v087ReloadResolvers[1]?.('V087_NEWER_RELOAD');
        await window.__v087ReloadPromises[1];
        window.__v087ReloadResolvers[0]?.('V087_STALE_RELOAD');
        await window.__v087ReloadPromises[0];
        return true;
      })()`);
      const latestReloadContent = await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const projectUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
          ?? '/src/store/projectStore.ts';
        const { useProjectStore } = await import(projectUrl);
        return useProjectStore.getState().tabs.find((tab) => tab.path === 'contents/abstract.tex')?.content ?? null;
      })()`);
      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const projectUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
          ?? '/src/store/projectStore.ts';
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { useProjectStore } = await import(projectUrl);
        const { api } = await import(apiUrl);
        api.readFile = (path) => path === 'contents/abstract.tex'
          ? new Promise((resolve) => { window.__v087ResolveDirtyReload = resolve; })
          : window.__v087ReloadReadOriginal(path);
        window.__v087DirtyReloadPromise = useProjectStore.getState().reloadTab('contents/abstract.tex');
        useProjectStore.getState().setTabContent('contents/abstract.tex', 'V087_DIRTY_USER_CONTENT');
        window.__v087ResolveDirtyReload?.('V087_DISK_AFTER_DIRTY');
        await window.__v087DirtyReloadPromise;
        const tab = useProjectStore.getState().tabs.find((candidate) => candidate.path === 'contents/abstract.tex');
        if (window.__v087ReloadReadOriginal) api.readFile = window.__v087ReloadReadOriginal;
        return JSON.stringify({ content: tab?.content ?? null, dirty: tab?.dirty ?? false });
      })()`);
      const dirtyReloadState = JSON.parse(await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const projectUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
          ?? '/src/store/projectStore.ts';
        const { useProjectStore } = await import(projectUrl);
        const tab = useProjectStore.getState().tabs.find((candidate) => candidate.path === 'contents/abstract.tex');
        return JSON.stringify({ content: tab?.content ?? null, dirty: tab?.dirty ?? false });
      })()`));
      result.reloadTabLatestRequestWinsAndDirtySurvives = latestReloadContent === 'V087_NEWER_RELOAD'
        && dirtyReloadState.content === 'V087_DIRTY_USER_CONTENT'
        && dirtyReloadState.dirty === true;
      await exec(`(() => {
        delete window.__v087ReloadReadOriginal;
        delete window.__v087ReloadResolvers;
        delete window.__v087ReloadCalls;
        delete window.__v087ReloadPromises;
        delete window.__v087ResolveDirtyReload;
        delete window.__v087DirtyReloadPromise;
        return true;
      })()`);

      await openFile('main.tex');
      await openFile('contents/abstract.tex');
      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const aiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
          ?? '/src/store/aiStore.ts';
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { useAiStore } = await import(aiUrl);
        const { api } = await import(apiUrl);
        window.__v087DeletedChatOriginal = api.aiChatStream;
        api.aiChatStream = () => new Promise((resolve) => { window.__v087ResolveDeletedChat = resolve; });
        window.__v087DeletedAskPromise = useAiStore.getState().askAi('deleted session request');
        return true;
      })()`);
      await sleep(150);
      await openFile('main.tex');
      await callAi(`useAiStore.getState().deleteSession(${JSON.stringify(second.sessionId)});`);
      await exec(`(async () => {
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        const eventUrl = resources.find((name) => new URL(name).pathname.includes('/node_modules/.vite/deps/@tauri-apps_api_event.js'));
        if (!eventUrl) throw new Error('Tauri event module URL not found');
        const { emit } = await import(eventUrl);
        await emit('tb://ai-edit', {
          file: 'contents/abstract.tex', backup: 'V087_DELETED_BACKUP', diff: '+deleted edit',
        });
        window.__v087ResolveDeletedChat?.('deleted session completion');
        await window.__v087DeletedAskPromise;
        const apiUrl = resources.find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
          ?? '/src/api/index.ts';
        const { api } = await import(apiUrl);
        if (window.__v087DeletedChatOriginal) api.aiChatStream = window.__v087DeletedChatOriginal;
        return true;
      })()`);
      const afterDeletedEdit = await aiState();
      result.deletedSessionEditDoesNotResurrect = !afterDeletedEdit.sessions.some((session) => session.id === second.sessionId)
        && !afterDeletedEdit.lastEdits.some((edit) => edit.backup === 'V087_DELETED_BACKUP')
        && !await exec(`Boolean(document.querySelector('.ai-generate-actions .btn-danger'))`);
      await exec(`(() => {
        delete window.__v087DeletedChatOriginal;
        delete window.__v087ResolveDeletedChat;
        delete window.__v087DeletedAskPromise;
        return true;
      })()`);
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
          window.__v087ResolveTimeline?.('contents/abstract.tex');
          if (window.__v087TimelineRollbackOriginal) api.aiRollback = window.__v087TimelineRollbackOriginal;
          window.__v087ResolveRuleFix?.({ ok: false, rounds: 0, summary: 'cleanup', diff: null });
          window.__v087RejectRuleFix?.(new Error('cleanup'));
          if (window.__v087RuleFixOriginal) api.fixRuleIssue = window.__v087RuleFixOriginal;
          window.__v087ResolveSecondaryRead?.('cleanup');
          if (window.__v087SecondaryRollbackOriginal) api.aiRollback = window.__v087SecondaryRollbackOriginal;
          if (window.__v087SecondaryReadOriginal) api.readFile = window.__v087SecondaryReadOriginal;
          window.__v087ResolveSecondaryCheck?.({ issues: [] });
          if (window.__v087SecondaryRuleFixOriginal) api.fixRuleIssue = window.__v087SecondaryRuleFixOriginal;
          if (window.__v087SecondaryRunCheckOriginal) api.runCheck = window.__v087SecondaryRunCheckOriginal;
          window.__v087ResolveOwnedRollback?.('contents/abstract.tex');
          if (window.__v087OwnedRollbackOriginal) api.aiRollback = window.__v087OwnedRollbackOriginal;
          window.__v087ReloadResolvers?.forEach((resolve) => resolve?.('cleanup'));
          window.__v087ResolveDirtyReload?.('cleanup');
          if (window.__v087ReloadReadOriginal) api.readFile = window.__v087ReloadReadOriginal;
          window.__v087ResolveDeletedChat?.('cleanup');
          if (window.__v087DeletedChatOriginal) api.aiChatStream = window.__v087DeletedChatOriginal;
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
          delete window.__v087ResolveTimeline;
          delete window.__v087TimelineRollbackOriginal;
          delete window.__v087TimelinePromise;
          delete window.__v087ResolveRuleFix;
          delete window.__v087RejectRuleFix;
          delete window.__v087RuleFixOriginal;
          delete window.__v087RuleFixPromise;
          delete window.__v087SecondaryRollbackOriginal;
          delete window.__v087SecondaryReadOriginal;
          delete window.__v087SecondaryReadArmed;
          delete window.__v087SecondaryReadStarted;
          delete window.__v087ResolveSecondaryRead;
          delete window.__v087SecondaryTimelinePromise;
          delete window.__v087SecondaryRuleFixOriginal;
          delete window.__v087SecondaryRunCheckOriginal;
          delete window.__v087SecondaryCheckArmed;
          delete window.__v087SecondaryCheckStarted;
          delete window.__v087ResolveSecondaryCheck;
          delete window.__v087SecondaryRulePromise;
          delete window.__v087OwnedRollbackOriginal;
          delete window.__v087OwnedRollbackCalls;
          delete window.__v087OwnedRollbackStarted;
          delete window.__v087ResolveOwnedRollback;
          delete window.__v087ReloadReadOriginal;
          delete window.__v087ReloadResolvers;
          delete window.__v087ReloadCalls;
          delete window.__v087ReloadPromises;
          delete window.__v087ResolveDirtyReload;
          delete window.__v087DirtyReloadPromise;
          delete window.__v087DeletedChatOriginal;
          delete window.__v087ResolveDeletedChat;
          delete window.__v087DeletedAskPromise;
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
        if (projectOwned || projectBackup) {
          if (projectBackup) await restoreOwnedBackup(projectBackup, projectOwned);
          else await rm(PROJ, { recursive: true, force: true });
          projectRestored = projectBackup
            ? await exists(PROJ) && !await exists(projectBackup.container)
            : !await exists(PROJ);
          injectCleanupFailure("project");
        }
      } catch (error) {
        cleanupErrors.push(`project fixture restoration: ${error}`);
      }
      try {
        if (sessionProjectOwned || sessionProjectBackup) {
          if (sessionProjectBackup) await restoreOwnedBackup(sessionProjectBackup, sessionProjectOwned);
          else await rm(SESSION_PROJ, { recursive: true, force: true });
          sessionProjectRestored = sessionProjectBackup
            ? await exists(SESSION_PROJ) && !await exists(sessionProjectBackup.container)
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
    && Object.values(theme.overflowMenuSurfaces).length === 3
    && Object.values(theme.overflowMenuSurfaces).every((menus) => (
      [menus.editor.normal, menus.editor.disabled, menus.ai.normal, menus.ai.danger, menus.ai.disabled].every((menu) => (
        menu.opened && menu.surfaceAlpha >= 0.9 && menu.contrast >= 4.5
      ))
    ))
    && Object.values(theme.disabledItemsVisuallyDistinct).length === 3
    && Object.values(theme.disabledItemsVisuallyDistinct).every(Boolean)
    && Object.values(theme.aiContentContrast).length === 8
    && Object.values(theme.aiContentContrast).every((snapshot) => (
      snapshot.opened && snapshot.contrast >= 4.5
    ))
    && theme.aiContentStateRestored
    && theme.brightGradientRejected
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
  const projectFixtureStateOk = projectRestored;
  const browserRestored = cleanupErrors.length === 0
    && JSON.stringify(browserStateAfter) === JSON.stringify(browserStateBefore);
  const browserStateDiff = browserRestored ? null : {
    storage: [...new Set([
      ...Object.keys(browserStateBefore?.storage ?? {}),
      ...Object.keys(browserStateAfter?.storage ?? {}),
    ])].filter((key) => browserStateBefore?.storage?.[key] !== browserStateAfter?.storage?.[key]),
    theme: [browserStateBefore?.theme, browserStateAfter?.theme],
    locale: [browserStateBefore?.locale, browserStateAfter?.locale],
    projectFields: Object.keys(browserStateBefore?.project ?? {}).filter((key) => (
      JSON.stringify(browserStateBefore?.project?.[key]) !== JSON.stringify(browserStateAfter?.project?.[key])
    )),
  };
  failed = !filesOk || !themeOk || !pdfOk || !sessionsOk || !projectFixtureStateOk || !sessionProjectStateOk || !browserRestored;
  console.log("FILES", JSON.stringify(files));
  console.log("THEME", JSON.stringify(theme));
  console.log("PDF", JSON.stringify(pdf));
  console.log("SESSIONS", JSON.stringify(sessions));
  console.log("STATE", JSON.stringify({ browserRestored, browserStateDiff, projectFixtureStateOk, sessionProjectStateOk, cleanupErrors }));
  console.log("E2E-DONE", failed ? "FAIL" : "PASS", { suite, filesOk, themeOk, pdfOk, sessionsOk, projectFixtureStateOk, sessionProjectStateOk, browserRestored });
  if (failed) process.exitCode = 1;
}

if (suite === "backup-self-test") {
  runBackupOwnershipSelfTest().catch((error) => {
    console.error("BACKUP-SELF-TEST-FAIL", error);
    process.exit(1);
  });
} else if (suite === "cleanup-fault") {
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
