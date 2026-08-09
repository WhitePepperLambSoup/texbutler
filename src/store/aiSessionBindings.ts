export const SCOPED_BINDINGS_KEY = "tb-ai-file-sessions-v2";

function isWindowsProjectRoot(root: string): boolean {
  return /^[A-Za-z]:(?:\/|$)/.test(root) || root.startsWith("//");
}

export function normalizeProjectRoot(root: string): string {
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return isWindowsProjectRoot(normalized) ? normalized.toLowerCase() : normalized;
}

export function normalizeRelativeFile(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function bindingKey(projectRoot: string, file: string): string {
  const normalizedRoot = normalizeProjectRoot(projectRoot);
  const normalizedFile = normalizeRelativeFile(file);
  const scopedFile = isWindowsProjectRoot(normalizedRoot) ? normalizedFile.toLowerCase() : normalizedFile;
  return `${normalizedRoot}\u0000${scopedFile}`;
}

export function loadScopedBindings(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCOPED_BINDINGS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

export function persistScopedBindings(bindings: Record<string, string>): void {
  try {
    localStorage.setItem(SCOPED_BINDINGS_KEY, JSON.stringify(bindings));
  } catch {
    // Best-effort persistence; in-process state remains correct.
  }
}

export function defaultSessionName(file: string): string {
  return normalizeRelativeFile(file).split("/").pop() ?? file;
}
