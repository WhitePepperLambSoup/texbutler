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
        collect_tex(&self.root, &self.root, &mut out);
        out
    }

    /// Candidate "document roots": every `.tex` file containing a
    /// `\documentclass` (multi-document projects: each chapter can be its
    /// own compilable document). Comments are stripped line-by-line so a
    /// magic comment on the first line (`% !TeX program=...`) does not
    /// hide the root. Sorted for a stable dropdown.
    pub fn document_roots(&self) -> Vec<String> {
        let mut roots: Vec<String> = Vec::new();
        for rel in self.tex_files() {
            let Ok(content) = self.read_file(&rel) else { continue };
            let mut is_root = false;
            for line in content.lines() {
                let l = match crate::core::rules::comment_start(line) {
                    Some(at) => &line[..at],
                    None => line,
                };
                if l.contains("\\documentclass") {
                    is_root = true;
                    break;
                }
            }
            if is_root {
                roots.push(rel);
            }
        }
        roots.sort();
        roots
    }

    /// All `.bib` files relative to the root (recursive).
    pub fn bib_files(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("bib")) == Some(true) {
                    if let Ok(rel) = path.strip_prefix(&self.root) {
                        out.push(rel.to_string_lossy().to_string());
                    }
                }
            }
        }
        out.sort();
        out
    }

    /// Best-effort path correction for AI tool calls: when a strict resolve
    /// fails (the model hallucinated a path), match the basename against
    /// every file in the project. Returns the unique match only — an
    /// ambiguous basename (or none) yields None. Build dirs (`target/`,
    /// `.git/`, hidden dirs) are skipped so compiled artifacts never win.
    pub fn find_by_basename(&self, path: &str) -> Option<String> {
        let base = path.rsplit(['/', '\\']).next().unwrap_or(path);
        if base.is_empty() || base == "." || base == ".." {
            return None;
        }
        let mut found: Option<String> = None;
        let mut stack = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let name = entry.file_name();
                    let n = name.to_string_lossy();
                    if n.starts_with('.') || n == "target" || n == "node_modules" {
                        continue;
                    }
                    stack.push(p);
                } else {
                    let fname = entry.file_name();
                    let f = fname.to_string_lossy();
                    if f.eq_ignore_ascii_case(&base) {
                        let Ok(rel) = p.strip_prefix(&self.root) else { continue };
                        let rel = rel.to_string_lossy().replace('\\', "/");
                        if found.is_some() {
                            return None; // ambiguous: two files share the name
                        }
                        found = Some(rel);
                    }
                }
            }
        }
        found
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
    /// The canonical path must stay inside the canonical project root —
    /// a symlink inside the project cannot redirect the read outside it.
    pub fn read_file(&self, rel: &str) -> Result<String, String> {
        let p = self.resolve(rel).ok_or_else(|| "路径越界".to_string())?;
        let cp = self.canonical_inside(&p)?;
        let bytes = std::fs::read(&cp).map_err(|e| e.to_string())?;
        // Strip UTF-8 BOM if present.
        let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
        String::from_utf8(bytes.to_vec()).map_err(|_| "文件不是 UTF-8 编码（中文 LaTeX 请保存为 UTF-8）".to_string())
    }

    /// Canonicalize an absolute project-internal path and verify the result
    /// stays inside the canonical project root. Works for files that do not
    /// exist yet (canonicalizes the deepest existing ancestor, then
    /// re-appends the missing tail), so it can guard writes to new files.
    /// A symlink anywhere in the path — including one that dangles — that
    /// would land outside the project is rejected.
    pub fn canonical_inside(&self, abs: &Path) -> Result<PathBuf, String> {
        let root_canon = std::fs::canonicalize(&self.root).unwrap_or_else(|_| self.root.clone());
        let abs = if abs.is_absolute() { abs.to_path_buf() } else { self.root.join(abs) };
        let mut probe = abs.as_path();
        let mut missing_tail: Vec<std::ffi::OsString> = Vec::new();
        let canon = loop {
            match std::fs::canonicalize(probe) {
                Ok(c) => break c,
                Err(_) => {
                    let Some(name) = probe.file_name() else {
                        return Err("路径无效".to_string());
                    };
                    missing_tail.push(name.to_os_string());
                    match probe.parent() {
                        Some(p) if !p.as_os_str().is_empty() => probe = p,
                        _ => return Err("路径无效".to_string()),
                    }
                }
            }
        };
        let mut final_path = canon;
        for name in missing_tail.iter().rev() {
            // symlink_metadata does NOT follow the link: a dangling
            // symlink (target does not exist yet) is rejected here,
            // otherwise the later write would CREATE the target file
            // outside the project through the link.
            let probe = final_path.join(name);
            if std::fs::symlink_metadata(&probe)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                return Err("路径越界（符号链接指向项目外）".to_string());
            }
            final_path.push(name);
        }
        if final_path.starts_with(&root_canon) {
            Ok(final_path)
        } else {
            Err("路径越界（符号链接指向项目外）".to_string())
        }
    }

    /// BFS over the `\input`/`\include` dependency graph starting at
    /// `start` (relative path). Returns the reachable files (start first,
    /// then its transitive dependencies) with their contents. Used to give
    /// the AI the real dependency chain instead of a flat file listing.
    /// Depth and total size are capped so a huge project cannot blow up
    /// the prompt.
    pub fn dependency_chain(&self, start: &str) -> Vec<(String, String)> {
        const MAX_DEPTH: usize = 4;
        const MAX_TOTAL_CHARS: usize = 200_000;
        let mut out: Vec<(String, String)> = Vec::new();
        let mut visited: Vec<String> = Vec::new();
        let mut queue: Vec<(String, usize)> = vec![(start.to_string(), 0)];
        let mut total = 0usize;
        while let Some((rel, depth)) = queue.pop() {
            if visited.contains(&rel) || depth > MAX_DEPTH {
                continue;
            }
            let Ok(content) = self.read_file(&rel) else { continue };
            visited.push(rel.clone());
            total += content.len();
            out.push((rel.clone(), content.clone()));
            if total > MAX_TOTAL_CHARS {
                break;
            }
            // discover dependencies of this file
            for line in content.lines() {
                for cmd in ["\\input", "\\include", "\\subfile"] {
                    let mut idx = 0;
                    while let Some(pos) = line[idx..].find(cmd) {
                        let after = &line[idx + pos + cmd.len()..];
                        let after = after.trim_start();
                        if let Some(open) = after.find('{') {
                            if let Some(close) = after[open + 1..].find('}') {
                                let name = after[open + 1..open + 1 + close].trim();
                                let dep = if name.ends_with(".tex") {
                                    name.to_string()
                                } else {
                                    format!("{name}.tex")
                                };
                                // `\input` is relative to the including
                                // file's directory, not the project root
                                let dep_rel = match rel.rfind('/') {
                                    Some(i) => format!("{}/{dep}", &rel[..i]),
                                    None => dep,
                                };
                                if !visited.contains(&dep_rel) {
                                    queue.push((dep_rel, depth + 1));
                                }
                            }
                        }
                        // advance past this match WITHOUT landing mid-
                        // codepoint: skip the command, then one full
                        // character (the `{` or whatever follows), then the
                        // next loop iteration scans from a char boundary.
                        idx += pos + cmd.len();
                        if idx < line.len() {
                            let ch = line[idx..].chars().next().unwrap();
                            idx += ch.len_utf8();
                        }
                    }
                }
            }
        }
        out
    }

    /// Write a file (creating parent dirs as needed). The resolved parent
    /// directory is canonicalized and verified to stay inside the project
    /// root, so a symlinked directory inside the project cannot redirect
    /// the write outside the project (defense in depth, mirrors the read
    /// side of `read_file`).
    pub fn write_file(&self, rel: &str, content: &str) -> Result<(), String> {
        let p = self.resolve(rel).ok_or_else(|| "路径越界".to_string())?;
        if let Some(parent) = p.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let canon_parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
            let root_canon = std::fs::canonicalize(&self.root).unwrap_or_else(|_| self.root.clone());
            if !canon_parent.starts_with(&root_canon) {
                return Err("路径越界（符号链接指向项目外）".to_string());
            }
        }
        // a file-level symlink pointing outside the project must not be
        // followed either (mirrors the read side in lib.rs). A dangling
        // symlink is rejected too: `fs::write` would otherwise CREATE the
        // target file outside the project.
        if p.exists() {
            let canon_file = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;
            let root_canon = std::fs::canonicalize(&self.root).unwrap_or_else(|_| self.root.clone());
            if !canon_file.starts_with(&root_canon) {
                return Err("路径越界（文件符号链接指向项目外）".to_string());
            }
        } else if std::fs::symlink_metadata(&p).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            return Err("路径越界（悬空符号链接）".to_string());
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
        ("article-en", "English article", TEMPLATE_ARTICLE_EN),
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

/// English starter template — for users who write LaTeX in English.
pub const TEMPLATE_ARTICLE_EN: &str = r#"\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage{graphicx}
\usepackage{float}
\usepackage{xcolor}
\usepackage{amsmath, amssymb}
\usepackage{hyperref}

\title{A New TeXButler Project}
\author{Author Name}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}

Write your introduction here. A common structure is: state the problem,
summarize related work, then present your contribution.

\section{Methods}

\subsection{Setup}

Describe the experimental setup. Use equations when needed:

\begin{equation}
E = mc^2
\label{eq:energy}
\end{equation}

\subsection{Results}

Tables are easy with \texttt{booktabs}:

\begin{table}[H]
\centering
\caption{Results overview}
\label{tab:results}
\begin{tabular}{lcc}
\toprule
Metric & Value A & Value B \\
\midrule
Accuracy & 0.94 & 0.91 \\
F1-score & 0.92 & 0.89 \\
\bottomrule
\end{tabular}
\end{table}

\section{Conclusion}

Summarize the findings and outline future work.

\begin{thebibliography}{9}
\bibitem{example} Author, A. \emph{An Example Reference}. Journal, 2026.
\end{thebibliography}

\end{document}
"#;

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

fn collect_tex(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            collect_tex(root, &p, out);
        } else if name.to_ascii_lowercase().ends_with(".tex") {
            if let Ok(rel) = p.strip_prefix(root) {
                // relative path, forward slashes — detect_main's
                // `contains(&"main.tex")` and document_roots rely on this
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
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
    fn tex_files_are_relative_and_detect_main_picks_main_tex() {
        // regression (user report): a multi-file project compiled the wrong
        // file — collect_tex returned ABSOLUTE paths, so detect_main's
        // `contains(&"main.tex")` never matched and the alphabetically first
        // file won (chapter2.tex → "Undefined control sequence")
        let dir = std::env::temp_dir().join(format!("tb-relmain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{chapter2}\n\\end{document}\n").unwrap();
        std::fs::write(dir.join("chapter2.tex"), "\\section{Chapter Two}\n").unwrap();
        let proj = Project::open(&dir).unwrap();
        let files = proj.tex_files();
        assert!(
            files.iter().all(|f| !f.contains(':') && !f.starts_with('/') && !f.starts_with('\\')),
            "tex_files must be relative: {files:?}"
        );
        assert_eq!(proj.main_file, "main.tex", "main.tex must win detect_main: {files:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_by_basename_matches_unique_file_anywhere() {
        // AI-hallucinated path (wrong directory) still resolves when the
        // basename is unique inside the project
        let dir = std::env::temp_dir().join(format!("tb-basename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("contents")).unwrap();
        std::fs::write(dir.join("contents/abstract.tex"), "\\begin{abstract}\n\\end{abstract}\n").unwrap();
        std::fs::write(dir.join("main.tex"), "\\documentclass{article}\n").unwrap();
        let proj = Project::open(&dir).unwrap();
        // the model said "t/my-latex-project/contents/abstract.tex" — only
        // the basename matters for the fallback
        let found = proj.find_by_basename("t/my-latex-project/contents/abstract.tex");
        assert_eq!(found.as_deref().map(|r| r.replace('\\', "/")), Some("contents/abstract.tex".into()));
        // a plain relative path that happens to exist must NOT be rewritten
        assert_eq!(proj.find_by_basename("contents/abstract.tex"), Some("contents/abstract.tex".into()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_by_basename_ambiguous_or_missing_returns_none() {
        let dir = std::env::temp_dir().join(format!("tb-basename2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("b")).unwrap();
        std::fs::write(dir.join("a/notes.tex"), "a\n").unwrap();
        std::fs::write(dir.join("b/notes.tex"), "b\n").unwrap();
        let proj = Project::open(&dir).unwrap();
        // two files share the name → ambiguous → None (never guess)
        assert_eq!(proj.find_by_basename("notes.tex"), None);
        // build dirs are skipped: target/main.tex must not win
        std::fs::create_dir_all(dir.join("target")).unwrap();
        std::fs::write(dir.join("target/main.tex"), "build artifact\n").unwrap();
        std::fs::write(dir.join("main.tex"), "real\n").unwrap();
        let proj2 = Project::open(&dir).unwrap();
        assert_eq!(
            proj2.find_by_basename("some/where/main.tex").as_deref().map(|r| r.replace('\\', "/")),
            Some("main.tex".into())
        );
        // missing basename → None
        assert_eq!(proj2.find_by_basename("nope.tex"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn document_roots_sees_documentclass_after_magic_comment() {
        // regression: the first-line magic comment used to truncate the
        // whole file for comment_start, hiding the \documentclass
        let dir = std::env::temp_dir().join(format!("tb-roots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("main.tex"),
            "% !TeX program = xelatex\n\\documentclass{ctexart}\n\\begin{document}\n正文\n\\end{document}\n",
        )
        .unwrap();
        std::fs::write(dir.join("notes.txt"), "not tex").unwrap();
        let proj = Project::open(&dir).unwrap();
        let roots = proj.document_roots();
        assert_eq!(roots.len(), 1, "magic comment must not hide the root");
        assert!(
            roots[0].replace('\\', "/").ends_with("main.tex"),
            "unexpected root: {}",
            roots[0]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

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
    fn dependency_chain_follows_inputs() {
        let dir = std::env::temp_dir().join(format!("tb-depchain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let proj = Project::open(std::path::Path::new(&dir)).expect("open project");
        proj.write_file("main.tex", "\\input{chapters/intro}\n\\include{chapters/methods}\n正文").unwrap();
        proj.write_file("chapters/intro.tex", "引言内容\n\\input{sub.tex}\n").unwrap();
        proj.write_file("chapters/methods.tex", "方法内容").unwrap();
        proj.write_file("chapters/sub.tex", "子文件").unwrap();
        let chain = proj.dependency_chain("main.tex");
        let rels: Vec<&str> = chain.iter().map(|(r, _)| r.as_str()).collect();
        assert!(rels.contains(&"main.tex"));
        assert!(rels.contains(&"chapters/intro.tex"));
        assert!(rels.contains(&"chapters/methods.tex"));
        assert!(rels.contains(&"chapters/sub.tex"), "transitive dep must be found: {rels:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dependency_chain_missing_file_skipped() {
        let dir = std::env::temp_dir().join(format!("tb-depchain2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let proj = Project::open(std::path::Path::new(&dir)).expect("open project");
        proj.write_file("main.tex", "\\input{missing.tex}\n正文").unwrap();
        let chain = proj.dependency_chain("main.tex");
        assert_eq!(chain.len(), 1, "only main survives: {chain:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_file_rejects_symlink_parent_outside_project() {
        let dir = std::env::temp_dir().join(format!("tb-symwrite-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let proj = Project::open(std::path::Path::new(&dir)).expect("open project");
        proj.write_file("main.tex", "正文").unwrap();
        // create a symlink inside the project pointing outside
        let outside = std::env::temp_dir().join(format!("tb-symwrite-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        #[cfg(windows)]
        let link_ok = std::os::windows::fs::symlink_dir(&outside, dir.join("evil"));
        #[cfg(not(windows))]
        let link_ok = std::os::unix::fs::symlink(&outside, dir.join("evil"));
        if link_ok.is_ok() {
            let r = proj.write_file("evil/escape.tex", "越界内容");
            assert!(r.is_err(), "symlinked parent must be rejected: {:?}", r);
        }
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn write_file_rejects_dangling_symlink() {
        let dir = std::env::temp_dir().join(format!("tb-symdangling-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let proj = Project::open(std::path::Path::new(&dir)).expect("open project");
        proj.write_file("main.tex", "正文").unwrap();
        let target = std::env::temp_dir().join(format!("tb-symdangling-out-{}", std::process::id()));
        let _ = std::fs::remove_file(&target);
        #[cfg(windows)]
        let link_ok = std::os::windows::fs::symlink_file(&target, dir.join("evil.tex"));
        #[cfg(not(windows))]
        let link_ok = std::os::unix::fs::symlink(&target, dir.join("evil.tex"));
        if link_ok.is_ok() {
            let r = proj.write_file("evil.tex", "越界内容");
            assert!(r.is_err(), "dangling symlink must be rejected: {:?}", r);
            assert!(!target.exists(), "target must not be created outside the project");
        }
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&target);
    }

    #[test]
    fn read_file_rejects_symlink_outside_project() {
        let dir = std::env::temp_dir().join(format!("tb-symread-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let proj = Project::open(std::path::Path::new(&dir)).expect("open project");
        proj.write_file("main.tex", "正文").unwrap();
        // a secret file outside the project
        let outside = std::env::temp_dir().join(format!("tb-symread-out-{}", std::process::id()));
        let _ = std::fs::remove_file(&outside);
        std::fs::write(&outside, "secret").unwrap();
        #[cfg(windows)]
        let link_ok = std::os::windows::fs::symlink_file(&outside, dir.join("leak.tex"));
        #[cfg(not(windows))]
        let link_ok = std::os::unix::fs::symlink(&outside, dir.join("leak.tex"));
        if link_ok.is_ok() {
            let r = proj.read_file("leak.tex");
            assert!(r.is_err(), "symlinked file must not be readable: {:?}", r);
        }
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn read_file_rejects_symlink_parent_outside_project() {
        let dir = std::env::temp_dir().join(format!("tb-symreaddir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let proj = Project::open(std::path::Path::new(&dir)).expect("open project");
        proj.write_file("main.tex", "正文").unwrap();
        let outside = std::env::temp_dir().join(format!("tb-symreaddir-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.tex"), "secret").unwrap();
        #[cfg(windows)]
        let link_ok = std::os::windows::fs::symlink_dir(&outside, dir.join("chapters"));
        #[cfg(not(windows))]
        let link_ok = std::os::unix::fs::symlink(&outside, dir.join("chapters"));
        if link_ok.is_ok() {
            let r = proj.read_file("chapters/secret.tex");
            assert!(r.is_err(), "symlinked parent must be rejected: {:?}", r);
        }
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn canonical_inside_accepts_new_file_in_project() {
        let dir = std::env::temp_dir().join(format!("tb-canonnew-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let proj = Project::open(std::path::Path::new(&dir)).expect("open project");
        let cp = proj
            .canonical_inside(&proj.root.join("chapters").join("new.tex"))
            .expect("new file inside the project must be accepted");
        let root_canon = std::fs::canonicalize(&proj.root).unwrap_or_else(|_| proj.root.clone());
        assert!(cp.starts_with(&root_canon), "canonical path inside root: {cp:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dependency_chain_survives_cjk_after_command() {
        // `\input中文` (no brace, no space) used to advance idx by 1 byte
        // into the middle of a CJK codepoint and panic on line[idx..]
        let dir = std::env::temp_dir().join(format!("tb-depcjk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let proj = Project::open(std::path::Path::new(&dir)).expect("open project");
        proj.write_file("main.tex", "\\input中文\n\\input{sub.tex}\n正文内容").unwrap();
        proj.write_file("sub.tex", "子文件").unwrap();
        let chain = proj.dependency_chain("main.tex");
        let rels: Vec<&str> = chain.iter().map(|(r, _)| r.as_str()).collect();
        assert!(rels.contains(&"sub.tex"), "real dep must still be found: {rels:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn canonical_inside_rejects_dangling_symlink_component() {
        // a dangling symlink (target does not exist) must not be usable to
        // redirect a write outside the project via the missing-tail path
        let dir = std::env::temp_dir().join(format!("tb-canonhang-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let proj = Project::open(std::path::Path::new(&dir)).expect("open project");
        let outside = std::env::temp_dir().join(format!("tb-canonhang-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        #[cfg(windows)]
        let link_ok = std::os::windows::fs::symlink_dir(&outside, dir.join("chapters"));
        #[cfg(not(windows))]
        let link_ok = std::os::unix::fs::symlink(&outside, dir.join("chapters"));
        if link_ok.is_ok() {
            // `chapters` is a symlink to a not-yet-existing outside dir
            let r = proj.canonical_inside(&proj.root.join("chapters").join("new.tex"));
            assert!(r.is_err(), "dangling symlink component must be rejected: {:?}", r);
            assert!(!outside.exists(), "outside target must not be created");
        }
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn collect_tex_survives_multibyte_filenames() {
        // the case-insensitive `.tex` check must never byte-slice through a
        // multi-byte codepoint (a Chinese-named file used to panic)
        let dir = std::env::temp_dir().join(format!("tb-collectmb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let proj = Project::open(std::path::Path::new(&dir)).expect("open project");
        proj.write_file("说明.md", "not tex").unwrap();
        proj.write_file("图片", "no extension").unwrap();
        proj.write_file("MAIN.TEX", "\\documentclass{article}").unwrap();
        let files = proj.tex_files();
        assert!(
            files.iter().any(|f| f.to_ascii_lowercase().ends_with("main.tex")),
            "uppercase .TEX must be found: {files:?}"
        );
        assert!(!files.iter().any(|f| f.ends_with(".md")), "md must be excluded: {files:?}");
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
