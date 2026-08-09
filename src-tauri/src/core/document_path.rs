use crate::core::project::{FileNode, Project};
use std::path::{Component, Path};

const DOCUMENT_EXTENSIONS: [&str; 4] = ["tex", "bib", "sty", "cls"];

fn normalized(value: &str) -> String {
    value.trim().trim_matches(['`', '"']).replace('\\', "/")
}

fn windows_drive_form(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1) == Some(&b':')
}

fn supported(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| {
            DOCUMENT_EXTENSIONS
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed))
        })
}

fn collect_documents(nodes: &[FileNode], out: &mut Vec<String>) {
    for node in nodes {
        if node.is_dir {
            collect_documents(&node.children, out);
        } else if supported(&node.path) {
            out.push(node.path.replace('\\', "/"));
        }
    }
}

fn exact_existing(project: &Project, candidate: &str) -> Option<String> {
    let path = Path::new(candidate);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        project.resolve(candidate)?
    };
    let canonical = project.canonical_inside(&absolute).ok()?;
    let metadata = std::fs::metadata(&canonical).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let root = std::fs::canonicalize(&project.root).ok()?;
    let rel = canonical
        .strip_prefix(root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    if !supported(&rel) {
        return None;
    }
    Some(rel)
}

pub fn resolve_existing_document(project: &Project, candidate: &str) -> Result<String, String> {
    let candidate = normalized(candidate);
    let native_absolute = Path::new(&candidate).is_absolute();
    let has_windows_drive_form = windows_drive_form(&candidate);
    if candidate.is_empty()
        || Path::new(&candidate)
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(format!("无法读取文件 `{candidate}`：路径无效"));
    }
    if has_windows_drive_form && !native_absolute {
        return Err(format!("无法读取文件 `{candidate}`：文件不在当前项目内"));
    }
    if let Some(rel) = exact_existing(project, &candidate) {
        return Ok(rel);
    }
    if native_absolute || has_windows_drive_form {
        return Err(format!("无法读取文件 `{candidate}`：文件不在当前项目内"));
    }

    let mut documents = Vec::new();
    collect_documents(project.file_tree(), &mut documents);
    let documents: Vec<String> = documents
        .into_iter()
        .filter_map(|path| exact_existing(project, &path))
        .collect();
    let folded = candidate.to_ascii_lowercase();
    let mut suffixes: Vec<String> = documents
        .iter()
        .filter(|rel| folded.ends_with(&format!("/{}", rel.to_ascii_lowercase())))
        .cloned()
        .collect();
    suffixes.sort();
    suffixes.dedup();
    if suffixes.len() == 1 {
        return Ok(suffixes.remove(0));
    }
    if suffixes.len() > 1 {
        return Err(format!(
            "无法读取文件 `{candidate}`：路径后缀匹配多个项目文件"
        ));
    }

    let basename = candidate.rsplit('/').next().unwrap_or(&candidate);
    let mut basenames: Vec<String> = documents
        .into_iter()
        .filter(|rel| {
            rel.rsplit('/')
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case(basename))
        })
        .collect();
    basenames.sort();
    basenames.dedup();
    match basenames.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err(format!("无法读取文件 `{candidate}`：项目内不存在该文档")),
        _ => Err(format!(
            "无法读取文件 `{candidate}`：同名文档不唯一（多个匹配）"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::project::Project;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(1);

    fn fixture(label: &str) -> (PathBuf, Project) {
        let root = std::env::temp_dir().join(format!(
            "tb-document-path-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("contents")).unwrap();
        std::fs::write(root.join("main.tex"), "\\documentclass{article}\\n").unwrap();
        std::fs::write(root.join("contents/abstract.tex"), "\\begin{abstract}\\n").unwrap();
        let project = Project::open(&root).unwrap();
        (root, project)
    }

    #[test]
    fn resolves_exact_absolute_and_truncated_suffix() {
        let (root, project) = fixture("resolve");
        assert_eq!(
            resolve_existing_document(&project, "contents/abstract.tex").unwrap(),
            "contents/abstract.tex"
        );
        let absolute = root
            .join("contents/abstract.tex")
            .to_string_lossy()
            .replace('\\', "/");
        assert_eq!(
            resolve_existing_document(&project, &absolute).unwrap(),
            "contents/abstract.tex"
        );
        assert_eq!(
            resolve_existing_document(&project, "t/my-latex-project/contents/abstract.tex")
                .unwrap(),
            "contents/abstract.tex",
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn returns_file_tree_path_for_lexically_noisy_relative_input() {
        let (root, project) = fixture("canonical-relative");
        assert_eq!(
            resolve_existing_document(&project, ".//contents///./abstract.tex").unwrap(),
            "contents/abstract.tex"
        );
        assert_eq!(
            resolve_existing_document(&project, ".\\contents\\\\abstract.tex").unwrap(),
            "contents/abstract.tex"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn resolves_internal_absolute_path_with_different_windows_casing() {
        let (root, project) = fixture("absolute-case");
        let absolute = root
            .join("contents/abstract.tex")
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_uppercase();
        assert_eq!(
            resolve_existing_document(&project, &absolute).unwrap(),
            "contents/abstract.tex"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recognizes_windows_drive_form_on_every_platform() {
        assert!(windows_drive_form("C:/outside/main.tex"));
        assert!(windows_drive_form("z:\\outside\\main.tex"));
        assert!(!windows_drive_form("contents/main.tex"));
    }

    #[cfg(not(windows))]
    #[test]
    fn refuses_windows_drive_form_that_exists_as_a_native_relative_path() {
        let (root, mut project) = fixture("drive-form");
        std::fs::create_dir_all(root.join("C:/outside")).unwrap();
        std::fs::write(root.join("C:/outside/main.tex"), "outside\\n").unwrap();
        project.scan().unwrap();
        assert!(resolve_existing_document(&project, "C:/outside/main.tex").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_ambiguous_truncated_suffix() {
        let (root, mut project) = fixture("suffix-ambiguity");
        std::fs::create_dir_all(root.join("dir")).unwrap();
        std::fs::write(root.join("a.tex"), "root\\n").unwrap();
        std::fs::write(root.join("dir/a.tex"), "nested\\n").unwrap();
        project.scan().unwrap();
        assert!(resolve_existing_document(&project, "prefix/dir/a.tex")
            .unwrap_err()
            .contains("多个"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_ambiguous_external_missing_and_unsupported_paths() {
        let (root, mut project) = fixture("refuse");
        std::fs::create_dir_all(root.join("appendix")).unwrap();
        std::fs::write(root.join("appendix/abstract.tex"), "duplicate\\n").unwrap();
        std::fs::write(root.join("contents/data.txt"), "not editable\\n").unwrap();
        project.scan().unwrap();
        assert!(resolve_existing_document(&project, "abstract.tex")
            .unwrap_err()
            .contains("多个"));
        assert!(resolve_existing_document(&project, "../outside.tex").is_err());
        assert!(resolve_existing_document(&project, "C:/Windows/win.ini").is_err());
        assert!(resolve_existing_document(&project, "missing.tex").is_err());
        assert!(resolve_existing_document(&project, "contents/data.txt").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_external_symlink_from_file_tree_fallback() {
        let (root, mut project) = fixture("dangling-symlink");
        let outside = std::env::temp_dir().join(format!(
            "tb-document-path-outside-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("leak.tex"), "outside\\n").unwrap();
        #[cfg(windows)]
        let link =
            std::os::windows::fs::symlink_file(outside.join("leak.tex"), root.join("leak.tex"));
        #[cfg(not(windows))]
        let link = std::os::unix::fs::symlink(outside.join("leak.tex"), root.join("leak.tex"));
        if link.is_ok() {
            project.scan().unwrap();
            assert!(resolve_existing_document(&project, "leak.tex").is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
}
