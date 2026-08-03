//! Project model: a folder of `.tex` sources with a main file, a file tree,
//! a private build directory (`.texbutler/build/`) and file watching via
//! the `notify` crate.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// One node of the project file tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    /// Path relative to project root, forward slashes.
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub children: Vec<FileNode>,
}

/// A watched project.
#[derive(Debug, Clone)]
pub struct Project {
    pub root: PathBuf,
    /// Main tex file relative to root (e.g. "main.tex").
    pub main_file: String,
    files: Vec<FileNode>,
}

/// Events emitted by the watcher (paths relative to project root).
#[derive(Debug, Clone)]
pub enum WatchEvent {
    Created(String),
    Modified(String),
    Removed(String),
}

impl Project {
    /// Open a directory as a project. Picks `main.tex` if present, else the
    /// single `.tex` file at top level, else the first `.tex` found.
    /// A persisted main file (`.texbutler/main.txt`) takes precedence.
    pub fn open(root: &Path) -> Result<Project, String> {
        if !root.is_dir() {
            return Err(format!("不是有效目录: {}", root.display()));
        }
        let mut proj = Project {
            root: root.to_path_buf(),
            main_file: "main.tex".to_string(),
            files: Vec::new(),
        };
        proj.scan()?;
        // restore persisted main file if it still exists — validate again so
        // a tampered `.texbutler/main.txt` cannot point outside the project
        let persisted = root.join(".texbutler").join("main.txt");
        if let Ok(name) = std::fs::read_to_string(&persisted) {
            let name = name.trim();
            if !name.is_empty() {
                let rel = Path::new(name);
                let safe = !rel.components().any(|c| {
                    matches!(
                        c,
                        std::path::Component::ParentDir
                            | std::path::Component::RootDir
                            | std::path::Component::Prefix(_)
                    )
                });
                if safe && root.join(rel).is_file() {
                    proj.main_file = name.to_string();
                    return Ok(proj);
                }
            }
        }
        proj.detect_main();
        Ok(proj)
    }

    /// Persist the main file choice for this project.
    pub fn set_main_file(&mut self, rel: &str) -> Result<(), String> {
        if self.resolve(rel).is_none() {
            return Err(format!("非法路径: {rel}"));
        }
        if !self.root.join(rel).exists() {
            return Err(format!("文件不存在: {rel}"));
        }
        self.main_file = rel.to_string();
        let dir = self.root.join(".texbutler");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("main.txt"), rel).map_err(|e| e.to_string())
    }

    /// Create a new project directory with a starter main.tex.
    pub fn create(root: &Path, name: &str) -> Result<Project, String> {
        Self::create_with_template(root, name, "article")
    }

    /// Create a new project with one of the built-in templates.
    pub fn create_with_template(root: &Path, name: &str, template: &str) -> Result<Project, String> {
        // security: reject traversal in the project name (`../x` would create
        // directories outside `root`)
        validate_project_name(name)?;
        let content = template_body(template);
        let dir = root.join(name);
        if dir.exists() {
            return Err(format!("目录已存在: {}", dir.display()));
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("main.tex"), content).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(dir.join(".texbutler")).ok();
        Project::open(&dir)
    }

    /// Pick the main file: explicit main.tex > single .tex > first .tex.
    pub fn detect_main(&mut self) {
        let tex_files = self.tex_files();
        if tex_files.contains(&"main.tex".to_string()) {
            self.main_file = "main.tex".to_string();
        } else if tex_files.len() == 1 {
            self.main_file = tex_files[0].clone();
        } else if let Some(first) = tex_files.first() {
            self.main_file = first.clone();
        }
    }

    /// All `.tex` files relative to the root (recursive).
    pub fn tex_files(&self) -> Vec<String> {
        let mut out = Vec::new();
        collect_tex(&self.root, &mut out);
        out
    }

    /// The absolute path of the main file.
    pub fn main_path(&self) -> PathBuf {
        self.root.join(&self.main_file)
    }

    /// Private build directory for this project.
    pub fn build_dir(&self) -> PathBuf {
        self.root.join(".texbutler").join("build")
    }

    /// The log file the compiler writes into the build dir.
    pub fn log_path(&self) -> PathBuf {
        self.build_dir().join("main.log")
    }

    /// The final PDF path (build dir).
    pub fn pdf_path(&self) -> PathBuf {
        self.build_dir().join("main.pdf")
    }

    /// Backup directory for AI-fix rollback (timestamped snapshots).
    pub fn backup_dir(&self) -> PathBuf {
        self.root.join(".texbutler").join("backup")
    }

    /// Re-scan the file tree.
    pub fn scan(&mut self) -> Result<(), String> {
        self.files = scan_dir(&self.root, &self.root, 0)?;
        Ok(())
    }

    pub fn file_tree(&self) -> &[FileNode] {
        &self.files
    }

    /// Resolve a relative path safely inside the project root.
    pub fn resolve(&self, rel: &str) -> Option<PathBuf> {
        let p = Path::new(rel);
        // Absolute path inside the project root is accepted (the log parser
        // emits `D:/.../main.tex`-style absolute paths on Windows).
        let p = if p.is_absolute() {
            if let Ok(stripped) = p.strip_prefix(&self.root) {
                stripped.to_path_buf()
            } else {
                return None;
            }
        } else {
            p.to_path_buf()
        };
        // Reject parent-dir traversal and absolute paths outright.
        for comp in p.components() {
            match comp {
                std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_) => return None,
                _ => {}
            }
        }
        let joined = self.root.join(&p);
        if joined.starts_with(&self.root) {
            Some(joined)
        } else {
            None
        }
    }

    /// Normalize a possibly-absolute project-internal path to a relative
    /// one (used by the AI fix loop before reading/backing up files).
    pub fn relative_path(&self, p: &str) -> String {
        let path = Path::new(p);
        if path.is_absolute() {
            if let Ok(stripped) = path.strip_prefix(&self.root) {
                return stripped.to_string_lossy().replace('\\', "/");
            }
        }
        p.to_string()
    }

    /// Read a file as UTF-8 (with BOM/encoding tolerance for Windows files).
    pub fn read_file(&self, rel: &str) -> Result<String, String> {
        let p = self.resolve(rel).ok_or_else(|| "路径越界".to_string())?;
        let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
        // Strip UTF-8 BOM if present.
        let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
        String::from_utf8(bytes.to_vec()).map_err(|_| "文件不是 UTF-8 编码（中文 LaTeX 请保存为 UTF-8）".to_string())
    }

    /// Write a file (creating parent dirs as needed).
    pub fn write_file(&self, rel: &str, content: &str) -> Result<(), String> {
        let p = self.resolve(rel).ok_or_else(|| "路径越界".to_string())?;
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&p, content).map_err(|e| e.to_string())
    }

    /// Start a file watcher; `tx` receives relative-path events. Returns a
    /// handle whose drop stops watching (kept alive by the caller).
    pub fn watch(&self, tx: std::sync::mpsc::Sender<WatchEvent>) -> Result<WatchHandle, String> {
        use notify::{RecursiveMode, Watcher};
        let root = self.root.clone();
        let root_for_watch = root.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                for path in ev.paths {
                    if let Ok(rel) = path.strip_prefix(&root_for_watch) {
                        let rel_str = rel.to_string_lossy().replace('\\', "/");
                        // ignore our own build/backup dirs and hidden files
                        if rel_str.starts_with(".texbutler/") || rel_str.starts_with(".git/") {
                            continue;
                        }
                        let event = match ev.kind {
                            notify::EventKind::Create(_) => WatchEvent::Created(rel_str),
                            notify::EventKind::Modify(_) => WatchEvent::Modified(rel_str),
                            notify::EventKind::Remove(_) => WatchEvent::Removed(rel_str),
                            _ => continue,
                        };
                        let _ = tx.send(event);
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
        Ok(WatchHandle { _watcher: watcher })
    }

    /// Find `\input`/`\include` dependencies of a tex file (simple parser).
    pub fn input_deps(&self, rel: &str) -> Vec<String> {
        let Ok(src) = self.read_file(rel) else { return vec![] };
        let mut deps = Vec::new();
        for line in src.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('%') {
                continue;
            }
            for cmd in ["\\input", "\\include"] {
                if trimmed.starts_with(cmd) {
                    let arg = trimmed[cmd.len()..].trim().trim_matches(|c| c == '{' || c == '}' || c == ' ');
                    if !arg.is_empty() {
                        deps.push(format!("{arg}.tex"));
                    }
                }
            }
        }
        deps
    }
}

/// Validate a project folder name: no traversal (ParentDir / RootDir /
/// Prefix components rejected) and no empty / current-dir names.
pub fn validate_project_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("项目名不能为空".into());
    }
    let name_path = Path::new(name);
    for comp in name_path.components() {
        if matches!(
            comp,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
                | std::path::Component::CurDir
        ) {
            return Err(format!("项目名不合法: {name}"));
        }
    }
    Ok(())
}

/// A handle that keeps the notify watcher alive.
pub struct WatchHandle {
    _watcher: notify::RecommendedWatcher,
}

/// Built-in new-project templates: (id, display name, body).
pub fn templates() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("article", "中文文章（ctexart）", TEMPLATE_ARTICLE),
        ("report", "中文报告（ctexrep，含目录）", TEMPLATE_REPORT),
        ("beamer", "中文幻灯片（ctexbeamer）", TEMPLATE_BEAMER),
        ("blank", "空白（article）", TEMPLATE_BLANK),
    ]
}

fn template_body(id: &str) -> &'static str {
    templates()
        .into_iter()
        .find(|(tid, _, _)| *tid == id)
        .map(|(_, _, body)| body)
        .unwrap_or(TEMPLATE_ARTICLE)
}

/// Default starter main.tex for new projects (Chinese ctex template).
pub const DEFAULT_MAIN_TEX: &str = TEMPLATE_ARTICLE;

pub const TEMPLATE_ARTICLE: &str = r#"\documentclass[UTF8]{ctexart}
\usepackage{graphicx}
\usepackage{float}
\usepackage{xcolor}

\title{TeXButler 新项目}
\author{作者}
\date{\today}

\begin{document}
\maketitle

\section{开始}

在这里编写你的中文 LaTeX 文档。点击"编译"即可生成 PDF。

\end{document}
"#;

pub const TEMPLATE_REPORT: &str = r#"\documentclass[UTF8]{ctexrep}
\usepackage{graphicx}
\usepackage{float}
\usepackage{xcolor}

\title{TeXButler 中文报告}
\author{作者}
\date{\today}

\begin{document}
\maketitle
\tableofcontents

\chapter{引言}

在这里编写你的中文报告。

\chapter{正文}

\section{小节}

\chapter{结论}

\end{document}
"#;

pub const TEMPLATE_BEAMER: &str = r#"\documentclass[UTF8]{ctexbeamer}
\usepackage{graphicx}
\usepackage{xcolor}
\usetheme{Madrid}

\title{TeXButler 幻灯片}
\author{作者}
\date{\today}

\begin{document}

\begin{frame}
\titlepage
\end{frame}

\begin{frame}{目录}
\tableofcontents
\end{frame}

\section{第一节}

\begin{frame}{第一页}

这是中文幻灯片的第一页。

\end{frame}

\end{document}
"#;

pub const TEMPLATE_BLANK: &str = r#"\documentclass{article}
\usepackage{graphicx}

\title{TeXButler New Project}
\author{Author}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}

Write your LaTeX document here.

\end{document}
"#;

fn collect_tex(dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            collect_tex(&p, out);
        } else if name.ends_with(".tex") {
            out.push(p.to_string_lossy().replace('\\', "/"));
        }
    }
}

fn scan_dir(root: &Path, dir: &Path, depth: usize) -> Result<Vec<FileNode>, String> {
    if depth > 12 {
        return Ok(vec![]);
    }
    let mut nodes = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // hide dotfiles incl. .texbutler
        }
        let rel = p
            .strip_prefix(root)
            .unwrap_or(&p)
            .to_string_lossy()
            .replace('\\', "/");
        if p.is_dir() {
            let children = scan_dir(root, &p, depth + 1)?;
            nodes.push(FileNode {
                path: rel,
                name,
                is_dir: true,
                children,
            });
        } else if is_tex_related(&name) {
            nodes.push(FileNode {
                path: rel,
                name,
                is_dir: false,
                children: vec![],
            });
        }
    }
    Ok(nodes)
}

/// Files shown in the project tree / AI file inventory: sources plus the
/// images and data files LaTeX commonly references.
fn is_tex_related(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["tex", "bib", "sty", "cls", "png", "jpg", "jpeg", "pdf", "eps", "svg", "csv", "dat", "txt", "cff"]
        .iter()
        .any(|ext| lower.ends_with(&format!(".{ext}")))
}

/// Flatten a file tree into a list of relative paths (for UI convenience).
pub fn flatten_tree(nodes: &[FileNode], out: &mut Vec<String>) {
    for n in nodes {
        out.push(n.path.clone());
        if n.is_dir {
            flatten_tree(&n.children, out);
        }
    }
}

/// Simple model for compile-job state shared with the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CompileStatus {
    pub running: bool,
    pub stage: String,
    pub progress: f32,
    pub message: String,
}

/// Placeholder so `HashMap` import stays meaningful for future use.
pub type FileCache = HashMap<String, String>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_prevents_escape() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("assets").join("sample");
        let proj = Project::open(&root).unwrap();
        assert!(proj.resolve("main.tex").is_some());
        assert!(proj.resolve("../secret.txt").is_none());
        assert!(proj.resolve("..\\secret.txt").is_none());
    }

    #[test]
    fn create_with_template_rejects_traversal_name() {
        let dir = std::env::temp_dir().join(format!("tb-name-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // `../evil` must NOT create anything outside `dir`
        let r = Project::create_with_template(&dir, "../evil", "article");
        assert!(r.is_err(), "路径遍历项目名必须拒绝");
        assert!(!dir.parent().unwrap().join("evil").exists());
        // normal name works
        assert!(Project::create_with_template(&dir, "ok-name", "article").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_template_is_valid_utf8() {
        assert!(DEFAULT_MAIN_TEX.contains("\\documentclass"));
    }

    #[test]
    fn tampered_main_file_is_ignored() {
        // a hostile `.texbutler/main.txt` pointing outside the project must
        // not become the main file
        let dir = std::env::temp_dir().join(format!("tb-test-main-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let proj = Project::create(&dir, "p").unwrap();
        std::fs::write(proj.root.join(".texbutler").join("main.txt"), "../evil.tex").unwrap();
        let reopened = Project::open(&dir.join("p")).unwrap();
        assert_ne!(reopened.main_file, "../evil.tex");
        assert!(reopened.main_file.ends_with(".tex"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_accepts_project_internal_absolute_path() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("assets").join("sample");
        let proj = Project::open(&root).unwrap();
        let abs = proj.resolve("main.tex").unwrap();
        let abs_str = abs.to_string_lossy().replace('\\', "/");
        // absolute project-internal path resolves to the same file
        assert_eq!(proj.resolve(&abs_str), Some(abs));
    }

    #[test]
    #[cfg(windows)]
    fn resolve_rejects_outside_windows_abs_path() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("assets").join("sample");
        let proj = Project::open(&root).unwrap();
        // absolute path outside the project is rejected (Windows drive form)
        assert!(proj.resolve("C:/Windows/win.ini").is_none());
        assert!(proj.resolve("D:/outside/main.tex").is_none());
    }

    #[test]
    fn relative_path_normalizes_absolute() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("assets").join("sample");
        let proj = Project::open(&root).unwrap();
        let abs = proj.resolve("main.tex").unwrap();
        let abs_str = abs.to_string_lossy().replace('\\', "/");
        assert_eq!(proj.relative_path(&abs_str), "main.tex");
        // non-project paths are returned as-is
        assert_eq!(proj.relative_path("C:/Windows/win.ini"), "C:/Windows/win.ini");
    }
}
