// User-level operations shared by the toolbar, menus, welcome screen and the
// command palette, so every entry point behaves (and reports errors) alike.

import { open } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { useProjectStore } from "./store/projectStore";
import { useCompileStore } from "./store/compileStore";
import { useUiStore } from "./store/uiStore";
import { dialog, toast } from "./store/feedbackStore";
import { removeRecent } from "./store/recent";
import { useI18n } from "./i18n";
import { cursorLine } from "./editorBridge";

const t = (key: string, vars?: Record<string, string | number>) => useI18n.getState().t(key, vars);

/** Open a project by path (recent list) or via the folder dialog. */
export async function openProject(path?: string): Promise<boolean> {
  try {
    await useProjectStore.getState().openProject(path);
    return true;
  } catch (e) {
    const msg = String(e);
    // the folder dialog was dismissed — not an error
    if (!path && /cancel|取消/i.test(msg)) return false;
    if (path) removeRecent(path);
    toast.error(path ? t("app.openFailed", { e: msg }) : msg);
    return false;
  }
}

export async function closeProject(): Promise<void> {
  try {
    await useProjectStore.getState().closeProject();
    useUiStore.getState().setSplitFile(null);
  } catch (e) {
    toast.error(t("app.closeFailed", { e: String(e) }));
  }
}

export async function saveActive(): Promise<void> {
  try {
    await useProjectStore.getState().saveFile();
  } catch (e) {
    toast.error(t("app.saveFailed", { e: String(e) }));
  }
}

export async function saveAll(): Promise<void> {
  try {
    const n = await useProjectStore.getState().saveAll();
    if (n > 0) toast.success(t("app.savedAll", { n }));
  } catch (e) {
    toast.error(t("app.saveFailed", { e: String(e) }));
  }
}

export async function importWord(): Promise<void> {
  if (!useProjectStore.getState().root) return;
  try {
    const file = await open({ multiple: false, filters: [{ name: "Word", extensions: ["docx"] }] });
    if (!file || Array.isArray(file)) return;
    const r = await api.importDocx(file);
    await useProjectStore.getState().refresh();
    await useProjectStore.getState().openFile(r.file);
    toast.success(t("toolbar.imported", { file: r.file, n: r.chars }));
  } catch (e) {
    toast.error(e);
  }
}

export async function exportActive(format: "md" | "docx"): Promise<void> {
  const file = useProjectStore.getState().activeTab;
  if (!file) return;
  try {
    await useProjectStore.getState().saveFile(file);
    const out = await api.exportFile(file, format);
    await useProjectStore.getState().refresh().catch(() => undefined);
    toast.success(t("toolbar.exported", { file: out }));
  } catch (e) {
    toast.error(e);
  }
}

export async function saveAsTemplate(): Promise<void> {
  const root = useProjectStore.getState().root;
  if (!root) return;
  const suggested = root.split(/[\\/]/).filter(Boolean).pop() ?? "my-template";
  const name = await dialog.prompt({
    title: t("tree.saveTemplate"),
    message: t("tree.saveTemplateMsg"),
    initial: suggested,
    confirmLabel: t("common.save"),
  });
  if (!name) return;
  try {
    await api.saveTemplate(name.trim());
    toast.success(t("tree.templateSaved", { name: name.trim() }));
  } catch (e) {
    toast.error(e);
  }
}

export async function showCompileLog(): Promise<void> {
  try {
    const text = await api.readLog();
    await dialog.alert({ title: t("problems.logTitle"), message: text || t("problems.logEmpty"), preformatted: true });
  } catch (e) {
    toast.error(e);
  }
}

/** SyncTeX forward search from the editor cursor. */
export async function locateInPdf(): Promise<void> {
  const file = useProjectStore.getState().activeTab;
  if (!file) return;
  try {
    const pos = await api.synctexForwardPos(file, cursorLine());
    if (pos) useUiStore.getState().showPdfPage(pos.page, pos.y || undefined, pos.h || undefined);
    else toast.info(t("editor.locatePdfNoSync"));
  } catch {
    toast.info(t("editor.locatePdfNoSync"));
  }
}

export async function setMainFile(path: string): Promise<void> {
  try {
    const info = await api.setMainFile(path);
    useProjectStore.setState({ mainFile: info.main_file });
    toast.success(t("tree.mainSet", { file: info.main_file }));
  } catch (e) {
    toast.error(e);
  }
}

// ------------------------------------------------------------ files

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = (path: string) => path.split("/").pop() ?? path;
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export async function newFolder(parentDir = ""): Promise<void> {
  const name = await dialog.prompt({
    title: t("files.newFolder"),
    message: parentDir ? t("files.inFolder", { dir: parentDir }) : t("files.inRoot"),
    initial: "figures",
    confirmLabel: t("common.create"),
  });
  if (!name?.trim()) return;
  try {
    const rel = await api.createDir(join(parentDir, name.trim()));
    await useProjectStore.getState().refresh();
    toast.success(t("files.folderCreated", { path: rel }));
  } catch (e) {
    toast.error(e);
  }
}

async function moveTo(from: string, to: string): Promise<boolean> {
  try {
    // write unsaved edits first so the moved file carries them
    await useProjectStore.getState().saveAll();
    const r = await api.renamePath(from, to);
    useProjectStore.getState().movePaths(r.from, r.to, r.main_file);
    const ui = useUiStore.getState();
    if (ui.splitFile && (ui.splitFile === r.from || ui.splitFile.startsWith(`${r.from}/`))) {
      ui.setSplitFile(`${r.to}${ui.splitFile.slice(r.from.length)}`);
    }
    await useProjectStore.getState().refresh();
    return true;
  } catch (e) {
    toast.error(e);
    return false;
  }
}

export async function renamePath(path: string): Promise<void> {
  const name = await dialog.prompt({
    title: t("files.rename"),
    message: path,
    initial: baseOf(path),
    confirmLabel: t("files.renameGo"),
  });
  if (!name?.trim() || name.trim() === baseOf(path)) return;
  if (/[\\/]/.test(name)) return void toast.error(t("files.nameOnly"));
  if (await moveTo(path, join(dirOf(path), name.trim()))) toast.success(t("files.renamed", { name: name.trim() }));
}

export async function movePath(path: string): Promise<void> {
  const dir = await dialog.prompt({
    title: t("files.move"),
    message: t("files.moveMsg", { path }),
    initial: dirOf(path),
    placeholder: t("files.movePlaceholder"),
    confirmLabel: t("files.moveGo"),
    allowEmpty: true,
  });
  if (dir === null) return;
  const target = join(dir.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""), baseOf(path));
  if (target === path) return;
  if (await moveTo(path, target)) toast.success(t("files.moved", { path: target }));
}

/** Drag & drop in the tree: move `path` into folder `dir` ("" = root). */
export async function movePathInto(path: string, dir: string): Promise<void> {
  const target = join(dir, baseOf(path));
  if (target === path || dir === path || dir.startsWith(`${path}/`)) return;
  if (await moveTo(path, target)) toast.success(t("files.moved", { path: target }));
}

export async function deletePath(path: string, isDir: boolean): Promise<void> {
  const ok = await dialog.confirm({
    title: isDir ? t("files.deleteFolder") : t("files.deleteFile"),
    message: t("files.deleteMsg", { path }),
    confirmLabel: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  try {
    // keep the latest edits in the trashed copy
    const st = useProjectStore.getState();
    for (const tab of st.tabs) {
      if (tab.dirty && (tab.path === path || tab.path.startsWith(`${path}/`))) await st.saveFile(tab.path);
    }
    const r = await api.deletePath(path);
    useProjectStore.getState().dropPaths(r.path);
    const ui = useUiStore.getState();
    if (ui.splitFile && (ui.splitFile === r.path || ui.splitFile.startsWith(`${r.path}/`))) ui.setSplitFile(null);
    const info = await api.projectInfo();
    useProjectStore.setState({ mainFile: info.main_file });
    await useProjectStore.getState().refresh();
    toast.info(t("files.deleted", { path: r.path }), {
      label: t("files.undo"),
      run: () => {
        void api
          .restoreDeleted(r.path, r.trash_id)
          .then(async () => {
            await useProjectStore.getState().refresh();
            toast.success(t("files.restored", { path: r.path }));
          })
          .catch(toast.error);
      },
    });
  } catch (e) {
    toast.error(e);
  }
}

export async function revealInExplorer(path?: string | null): Promise<void> {
  try {
    await api.revealPath(path ?? null, false);
  } catch (e) {
    toast.error(e);
  }
}

export async function openOutputFolder(): Promise<void> {
  try {
    await api.revealPath(null, true);
  } catch (e) {
    toast.error(e);
  }
}

export async function savePdfAs(): Promise<void> {
  const pdf = useProjectStore.getState().pdfPath;
  if (!pdf) return void toast.info(t("pdf.empty"));
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({ defaultPath: baseOf(pdf.replace(/\\/g, "/")), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!dest) return;
    const out = await api.savePdfAs(dest);
    toast.success(t("pdf.savedAs", { path: out }), { label: t("files.reveal"), run: () => void openOutputFolder() });
  } catch (e) {
    toast.error(e);
  }
}

export function showHistory(file?: string | null) {
  const target = file ?? useProjectStore.getState().activeTab;
  if (target) useUiStore.getState().openModal({ kind: "history", file: target });
}

// --------------------------------------------------------- encoding

/** Convert GBK files to UTF-8 (originals backed up by the backend). */
export async function convertToUtf8(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    // unsaved buffers of these files would be written back as UTF-8 anyway;
    // save them first so the conversion sees the latest text
    const st = useProjectStore.getState();
    for (const tab of st.tabs) if (tab.dirty && paths.includes(tab.path)) await st.saveFile(tab.path);
    const r = await api.convertToUtf8(paths);
    for (const f of r.converted) {
      if (useProjectStore.getState().tabs.some((tab) => tab.path === f)) await useProjectStore.getState().reloadTab(f);
    }
    if (r.converted.length) toast.success(t("encoding.converted", { n: r.converted.length }));
    if (r.failed.length) toast.error(t("encoding.failed", { files: r.failed.join(", ") }));
    void useCompileStore.getState().runCheck();
  } catch (e) {
    toast.error(e);
  }
}

const encodingAsked = new Set<string>();

/** Scan now (command palette): report the result even when all is UTF-8. */
export function scanEncodingNow(): Promise<void> {
  return checkProjectEncoding(true);
}

/** After opening a project: offer to convert GBK files (once per session). */
export async function checkProjectEncoding(force = false): Promise<void> {
  const root = useProjectStore.getState().root;
  if (!root || (!force && encodingAsked.has(root))) return;
  encodingAsked.add(root);
  let files: { path: string; encoding: string }[] = [];
  try {
    files = await api.encodingScan();
  } catch (e) {
    if (force) toast.error(e);
    return;
  }
  const gbk = files.filter((f) => f.encoding === "gbk").map((f) => f.path);
  const unknown = files.filter((f) => f.encoding === "unknown").map((f) => f.path);
  if (force && unknown.length) toast.error(t("encoding.unknown", { files: unknown.join(", ") }));
  if (gbk.length === 0) {
    if (force && unknown.length === 0) toast.success(t("encoding.allUtf8"));
    return;
  }
  if (useProjectStore.getState().root !== root) return;
  const list = gbk.slice(0, 8).join("\n") + (gbk.length > 8 ? `\n… (+${gbk.length - 8})` : "");
  const ok = await dialog.confirm({
    title: t("encoding.title"),
    message: t("encoding.message", { n: gbk.length, list }),
    confirmLabel: t("encoding.convertAll"),
  });
  if (ok) await convertToUtf8(gbk);
}

// ---------------------------------------------------------- updater

/** Check for an update; `interactive` reports "up to date" as well. */
export async function checkForUpdates(interactive: boolean): Promise<void> {
  try {
    const info = await api.checkUpdates();
    if (info) useUiStore.getState().openModal({ kind: "update", info });
    else if (interactive) toast.success(t("settings.updatesNone"));
  } catch (e) {
    if (interactive) toast.error(e);
  }
}

export function compile(target?: string) {
  void useCompileStore.getState().compile(target);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(t("common.copied"));
  } catch (e) {
    toast.error(e);
  }
}
