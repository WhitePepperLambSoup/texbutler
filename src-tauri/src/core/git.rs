//! Read-only Git status for the project (branch, ahead/behind, per-file
//! state) via the `git` CLI. Nothing is ever written to the repository.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitFile {
    /// Path relative to the PROJECT root (forward slashes).
    pub path: String,
    /// "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict"
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct GitStatus {
    /// `git` executable found.
    pub available: bool,
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
}

fn git(root: &Path, args: &[&str]) -> Option<std::process::Output> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(root).args(args);
    crate::core::compiler::hide_console(&mut cmd);
    cmd.output().ok()
}

pub fn status(root: &Path) -> GitStatus {
    let Some(version) = git(root, &["--version"]) else {
        return GitStatus::default();
    };
    if !version.status.success() {
        return GitStatus::default();
    }
    let mut out = GitStatus { available: true, ..Default::default() };
    let Some(prefix) = git(root, &["rev-parse", "--show-prefix"]) else {
        return out;
    };
    if !prefix.status.success() {
        return out; // not a repository
    }
    out.is_repo = true;
    // keep `.texbutler/` out of the user's own `git status` / commits too
    let meta = root.join(".texbutler");
    if meta.is_dir() && !meta.join(".gitignore").exists() {
        let _ = std::fs::write(meta.join(".gitignore"), "# TeXButler build output, backups and history\n*\n");
    }
    let prefix = String::from_utf8_lossy(&prefix.stdout).trim().to_string();
    let Some(st) = git(root, &["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all", "--", "."]) else {
        return out;
    };
    parse_porcelain(&String::from_utf8_lossy(&st.stdout), &prefix, &mut out);
    out
}

/// Parse `git status --porcelain=v1 -b -z` output. `prefix` is the project
/// directory relative to the repository root (`git rev-parse
/// --show-prefix`, with a trailing slash, empty at the repo root).
pub fn parse_porcelain(raw: &str, prefix: &str, out: &mut GitStatus) {
    let mut entries = raw.split('\0').filter(|s| !s.is_empty()).peekable();
    while let Some(entry) = entries.next() {
        if let Some(head) = entry.strip_prefix("## ") {
            parse_branch(head, out);
            continue;
        }
        if entry.len() < 4 {
            continue;
        }
        let (x, y) = (entry.as_bytes()[0] as char, entry.as_bytes()[1] as char);
        let path = &entry[3..];
        // renames/copies carry the ORIGINAL path as the next NUL field
        if x == 'R' || x == 'C' {
            entries.next();
        }
        let status = match (x, y) {
            ('?', '?') => "untracked",
            ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => "conflict",
            ('A', _) => "added",
            ('R', _) | ('C', _) => "renamed",
            ('D', _) | (_, 'D') => "deleted",
            _ => "modified",
        };
        let Some(rel) = path.strip_prefix(prefix) else { continue };
        // TeXButler's own build output, backups and history are not project changes
        if rel == ".texbutler/" || rel.starts_with(".texbutler/") {
            continue;
        }
        out.files.push(GitFile {
            path: rel.trim_end_matches('/').to_string(),
            status: status.to_string(),
            staged: x != ' ' && x != '?',
        });
    }
}

fn parse_branch(head: &str, out: &mut GitStatus) {
    // `main...origin/main [ahead 1, behind 2]`, `No commits yet on main`,
    // `HEAD (no branch)`
    let (names, tracking) = match head.find(" [") {
        Some(i) => (&head[..i], Some(&head[i + 2..head.len().saturating_sub(1)])),
        None => (head, None),
    };
    let names = names.trim_start_matches("No commits yet on ").trim_start_matches("Initial commit on ");
    let mut parts = names.splitn(2, "...");
    out.branch = parts.next().map(|s| s.to_string()).filter(|s| !s.is_empty());
    out.upstream = parts.next().map(|s| s.to_string());
    if let Some(t) = tracking {
        for item in t.split(", ") {
            if let Some(n) = item.strip_prefix("ahead ") {
                out.ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = item.strip_prefix("behind ") {
                out.behind = n.parse().unwrap_or(0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_tracking_and_files() {
        let raw = "## main...origin/main [ahead 2, behind 1]\0 M main.tex\0A  chapters/new.tex\0?? notes.txt\0R  b.tex\0a.tex\0UU conflict.tex\0 D gone.tex\0";
        let mut s = GitStatus { available: true, is_repo: true, ..Default::default() };
        parse_porcelain(raw, "", &mut s);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        let got: Vec<(&str, &str, bool)> = s.files.iter().map(|f| (f.path.as_str(), f.status.as_str(), f.staged)).collect();
        assert_eq!(
            got,
            vec![
                ("main.tex", "modified", false),
                ("chapters/new.tex", "added", true),
                ("notes.txt", "untracked", false),
                ("b.tex", "renamed", true),
                ("conflict.tex", "conflict", true),
                ("gone.tex", "deleted", false),
            ]
        );
    }

    #[test]
    fn rebases_paths_for_a_project_inside_a_larger_repo() {
        let raw = "## dev\0 M thesis/main.tex\0 M other/readme.md\0";
        let mut s = GitStatus::default();
        parse_porcelain(raw, "thesis/", &mut s);
        assert_eq!(s.branch.as_deref(), Some("dev"));
        assert_eq!(s.files.len(), 1);
        assert_eq!(s.files[0].path, "main.tex");
    }

    #[test]
    fn hides_texbutler_internal_files() {
        let raw = "## main\0 M .texbutler/build/main.pdf\0?? .texbutler/\0 M main.tex\0";
        let mut s = GitStatus::default();
        parse_porcelain(raw, "", &mut s);
        let paths: Vec<&str> = s.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["main.tex"]);
    }

    #[test]
    fn handles_fresh_repository() {
        let mut s = GitStatus::default();
        parse_porcelain("## No commits yet on main\0?? main.tex\0", "", &mut s);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.files[0].status, "untracked");
    }
}
