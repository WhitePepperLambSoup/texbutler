//! Local file history: before a save overwrites a file, the previous content
//! is kept as a snapshot in `.texbutler/history/<rel path>/<millis>.snap`.
//! Snapshots are throttled (autosave every few seconds must not produce a
//! version each time), deduplicated against the newest one and capped per
//! file, so the history stays small while still covering every editing
//! session. Explicit operations (replace-all, restore) force a snapshot.

use crate::core::project::Project;
use serde::Serialize;
use std::path::PathBuf;

/// Keep at most this many versions per file.
pub const MAX_VERSIONS: usize = 50;
/// Minimum time between two automatic snapshots of the same file.
pub const AUTO_INTERVAL_MS: u64 = 120_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HistoryEntry {
    /// Snapshot id (milliseconds since the epoch).
    pub id: String,
    pub ts: u64,
    pub size: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Directory holding the versions of `rel` (validated project-relative path).
fn file_dir(project: &Project, rel: &str) -> Result<PathBuf, String> {
    let rel = project.relative_path(rel).replace('\\', "/");
    if project.resolve(&rel).is_none() || rel.starts_with(".texbutler") || rel.is_empty() {
        return Err(format!("非法路径: {rel}"));
    }
    let mut dir = project.root.join(".texbutler").join("history");
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("非法路径: {rel}"));
        }
        dir.push(part);
    }
    Ok(dir)
}

/// Versions of `rel`, newest first.
pub fn list(project: &Project, rel: &str) -> Result<Vec<HistoryEntry>, String> {
    let dir = file_dir(project, rel)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<HistoryEntry> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let id = name.strip_suffix(".snap")?.to_string();
            let ts = id.parse::<u64>().ok()?;
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            Some(HistoryEntry { id, ts, size })
        })
        .collect();
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(out)
}

/// Read one version.
pub fn read(project: &Project, rel: &str, id: &str) -> Result<String, String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("非法版本号".into());
    }
    let path = file_dir(project, rel)?.join(format!("{id}.snap"));
    std::fs::read_to_string(&path).map_err(|e| format!("读取历史版本失败: {e}"))
}

/// Record `content` as a version of `rel`. Returns the new id, or `None`
/// when skipped (identical to the newest version, or throttled).
pub fn record(project: &Project, rel: &str, content: &str, force: bool) -> Result<Option<String>, String> {
    let dir = file_dir(project, rel)?;
    let existing = list(project, rel)?;
    let now = now_ms();
    if let Some(newest) = existing.first() {
        if let Ok(prev) = read(project, rel, &newest.id) {
            if prev == content {
                return Ok(None);
            }
        }
        if !force && now.saturating_sub(newest.ts) < AUTO_INTERVAL_MS {
            return Ok(None);
        }
    }
    // keep ids unique when two snapshots land in the same millisecond
    let mut ts = now;
    if let Some(newest) = existing.first() {
        if ts <= newest.ts {
            ts = newest.ts + 1;
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = ts.to_string();
    std::fs::write(dir.join(format!("{id}.snap")), content).map_err(|e| e.to_string())?;
    // prune the oldest versions beyond the cap
    for old in existing.iter().skip(MAX_VERSIONS - 1) {
        let _ = std::fs::remove_file(dir.join(format!("{}.snap", old.id)));
    }
    Ok(Some(id))
}

/// Called before a save: keep the content currently on disk as a version
/// when it differs from what is about to be written.
pub fn record_before_write(project: &Project, rel: &str, new_content: &str) {
    let Ok(old) = project.read_file(rel) else {
        return; // new file, or unreadable: nothing to preserve
    };
    if old != new_content {
        let _ = record(project, rel, &old, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(tag: &str) -> (PathBuf, Project) {
        let root = std::env::temp_dir().join(format!("tb-history-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(root.join("main.tex"), "\\documentclass{article}\n").unwrap();
        let p = Project::open(&root).unwrap();
        (root, p)
    }

    #[test]
    fn records_dedupes_and_throttles() {
        let (root, p) = temp_project("dedupe");
        assert!(record(&p, "chapters/a.tex", "v1", false).unwrap().is_some());
        // identical content is never stored twice
        assert!(record(&p, "chapters/a.tex", "v1", true).unwrap().is_none());
        // a different version right away is throttled unless forced
        assert!(record(&p, "chapters/a.tex", "v2", false).unwrap().is_none());
        let id = record(&p, "chapters/a.tex", "v2", true).unwrap().unwrap();
        let list = list(&p, "chapters/a.tex").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, id, "newest first");
        assert_eq!(read(&p, "chapters/a.tex", &id).unwrap(), "v2");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn caps_versions_per_file() {
        let (root, p) = temp_project("cap");
        for i in 0..(MAX_VERSIONS + 7) {
            record(&p, "main.tex", &format!("v{i}"), true).unwrap();
        }
        let list = list(&p, "main.tex").unwrap();
        assert_eq!(list.len(), MAX_VERSIONS);
        assert_eq!(read(&p, "main.tex", &list[0].id).unwrap(), format!("v{}", MAX_VERSIONS + 6));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_traversal_and_bad_ids() {
        let (root, p) = temp_project("traversal");
        assert!(record(&p, "../outside.tex", "x", true).is_err());
        assert!(read(&p, "main.tex", "../../x").is_err());
        assert!(record(&p, ".texbutler/history/x", "x", true).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn record_before_write_keeps_previous_disk_content() {
        let (root, p) = temp_project("before-write");
        record_before_write(&p, "main.tex", "new content");
        let list = list(&p, "main.tex").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(read(&p, "main.tex", &list[0].id).unwrap(), "\\documentclass{article}\n");
        // a brand-new file has nothing to preserve
        record_before_write(&p, "chapters/new.tex", "x");
        assert!(list_or_empty(&p, "chapters/new.tex").is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    fn list_or_empty(p: &Project, rel: &str) -> Vec<HistoryEntry> {
        list(p, rel).unwrap_or_default()
    }
}
