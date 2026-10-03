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
    const page = await api.synctexForward(file, cursorLine());
    if (page != null) useUiStore.getState().showPdfPage(page);
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
