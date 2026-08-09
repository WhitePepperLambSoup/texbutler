export function currentDirectory(activeTab: string | null): string {
  if (!activeTab) return "";
  const normalized = activeTab.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash);
}

export function validateFileName(raw: string): string {
  const name = raw.trim();
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new Error("filename-only");
  }
  return name;
}

export function joinProjectRelative(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
