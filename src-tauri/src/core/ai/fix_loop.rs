//! AI fix loop: diagnose -> propose unified diff -> apply -> recompile ->
//! verify. At most `max_rounds` iterations; on final failure the applied
//! changes are rolled back from the timestamped backup (`.texbutler/backup/`).
//!
//! The AI never writes files directly: it returns a diff, the app applies
//! it after parsing, and the frontend can show the diff before accepting.

use super::prompt_templates;
use super::provider::{AiSettings, ChatMsg, chat};
use crate::core::compiler::{CompileResult, CompilerScheduler};
use crate::core::project::Project;
use crate::core::{FixReport, Issue, SourceContext};
use std::path::{Path, PathBuf};

/// Apply a unified diff text to a single file (we only ever diff one file
/// at a time; the AI is instructed to diff `ctx.file` only).
///
/// Returns the new file content.
pub fn apply_unified_diff(original: &str, diff: &str) -> Result<String, String> {
    let lines: Vec<&str> = diff.lines().collect();
    let mut hunks: Vec<Vec<&str>> = Vec::new();
    let mut current: Vec<&str> = Vec::new();

    for line in lines {
        // The AI appends per-hunk explanations after the diff
        // (`解释：` / `Explanation:`). They must not be parsed as diff
        // lines — a `- 8: ...` explanation starts with `-` and would be
        // treated as a removal line.
        let trimmed = line.trim();
        if trimmed == "解释：" || trimmed == "解释:" || trimmed == "Explanation:" {
            break;
        }
        if line.starts_with("@@") {
            if !current.is_empty() {
                hunks.push(std::mem::take(&mut current));
            }
            current.push(line);
        } else if line.starts_with("---") || line.starts_with("+++") {
            // file headers — ignore (we know the target file)
            continue;
        } else if !current.is_empty() {
            if is_valid_diff_line(line) {
                current.push(line);
            } else {
                // trailing garbage like `*** End of diff` (Claude-style
                // markers some models emit) terminates the current hunk
                // instead of being treated as a context line
                hunks.push(std::mem::take(&mut current));
            }
        } else if line.starts_with('+') || line.starts_with('-') {
            // tolerate diffs without @@ headers
            current.push(line);
        }
    }
    if !current.is_empty() {
        hunks.push(current);
    }
    if hunks.is_empty() {
        return Err("diff 中没有可应用的 hunk".into());
    }

    let mut result = original.to_string();
    // Apply hunks bottom-up so line numbers stay valid. Report which hunk
    // failed so the user/AI knows exactly what could not be applied.
    let total = hunks.len();
    for (i, hunk) in hunks.iter().rev().enumerate() {
        match apply_hunk(&result, hunk) {
            Ok(r) => result = r,
            Err(e) => return Err(format!("第 {}/{} 个 hunk 无法应用：{e}", total - i, total)),
        }
    }
    Ok(result)
}

/// Compare a diff line against the file content, tolerating trailing
/// whitespace differences (`\r` from CRLF files, trailing spaces an LLM
/// dropped). Leading whitespace is significant (LaTeX indentation).
fn diff_line_matches(old: &str, want: &str) -> bool {
    old.trim_end() == want.trim_end()
}

/// A valid unified-diff body line starts with `+`, `-` or a space
/// (context). Anything else (e.g. `*** End of diff`) ends the hunk.
fn is_valid_diff_line(line: &str) -> bool {
    line.is_empty() || line.starts_with('+') || line.starts_with('-') || line.starts_with(' ')
}

fn apply_hunk(original: &str, hunk: &[&str]) -> Result<String, String> {
    let src_lines: Vec<String> = original.lines().map(|s| s.to_string()).collect();
    let target = src_lines.clone();

    // parse `@@ -start,count +start,count @@` (counts optional)
    let header = hunk.iter().find(|l| l.starts_with("@@")).copied().unwrap_or("@@ -1,1 +1,1 @@");
    let (old_start, _old_count) = parse_hunk_header(header)?;

    let body: Vec<&str> = hunk.iter().filter(|l| !l.starts_with("@@")).copied().collect();

    // --- anchor calibration ---
    // AI-generated diffs often have line numbers off by a few lines (they
    // derive them from the context window). If the @@ position does not
    // match the file content, search for the hunk nearby (window ±15,
    // full-file when out of bounds) and refuse ambiguous positions.

    let mut old_idx = match locate_hunk_start(&target, &body, old_start.saturating_sub(1)) {
        Ok(idx) => idx,
        Err(e) => return Err(e),
    }; // 0-based
    // IMPORTANT: everything before the hunk stays untouched — the output
    // must start with the file's leading lines (a bug where `out` started
    // empty silently dropped the file head once calibration moved past it).
    let mut out: Vec<String> = target.iter().take(old_idx).cloned().collect();
    let mut i = 0;
    let mut applied_any = false;

    // First pass: build the output by consuming old lines.
    while i < body.len() {
        let line = body[i];
        match line.chars().next() {
            Some('-') => {
                let expected = &line[1..];
                // no-op pair: `-X` immediately followed by `+X` with the
                // same content — the AI "edited" a line without changing it
                // (observed with undefined-command lines). Treat it as an
                // unchanged context line instead of wasting the round.
                if let Some(next) = body.get(i + 1) {
                    if next.starts_with('+') && &next[1..] == expected {
                        match target.get(old_idx) {
                            Some(old) if diff_line_matches(old, expected) => {
                                out.push(old.clone());
                                old_idx = match old_idx.checked_add(1) {
                                    Some(v) => v,
                                    None => return Err("diff 行号溢出".into()),
                                };
                                i += 2; // consume both lines
                                continue;
                            }
                            _ => {}
                        }
                    }
                }
                // verify against the old content when possible; a `-` line
                // whose content is empty removes an empty line (== matches
                // it), never ANY line — otherwise a malformed `-\n` would
                // delete arbitrary content after anchor calibration
                match target.get(old_idx) {
                    Some(old_line) if diff_line_matches(old_line, expected) => {}
                    Some(old_line) => {
                        return Err(format!(
                            "diff 上下文不匹配：第 {} 行期望 `{}`，实际 `{}`",
                            old_idx + 1,
                            expected,
                            old_line
                        ));
                    }
                    // removing the file's final (empty) line: allowed
                    None if expected.is_empty() => {}
                    None => return Err("diff 上下文超出文件范围".into()),
                }
                old_idx = match old_idx.checked_add(1) {
                    Some(v) => v,
                    None => return Err("diff 行号溢出".into()),
                };
                applied_any = true;
            }
            Some('+') => {
                out.push(line[1..].to_string());
                applied_any = true;
            }
            _ => {
                // context line: keep old line and advance both
                let context = line.strip_prefix(' ').unwrap_or(line);
                if let Some(old_line) = target.get(old_idx) {
                    if !diff_line_matches(old_line, context) {
                        return Err(format!(
                            "diff 上下文不匹配：第 {} 行期望 `{}`，实际 `{}`",
                            old_idx + 1,
                            context,
                            old_line
                        ));
                    }
                    out.push(old_line.clone());
                    old_idx = match old_idx.checked_add(1) {
                        Some(v) => v,
                        None => return Err("diff 行号溢出".into()),
                    };
                } else {
                    return Err("diff 上下文超出文件范围".into());
                }
            }
        }
        i += 1;
    }
    // append remaining old lines
    out.extend(target.iter().skip(old_idx).cloned());
    if !applied_any {
        return Err("diff 没有实际修改（只有上下文行）".into());
    }
    Ok(out.join("\n"))
}

fn parse_hunk_header(header: &str) -> Result<(usize, usize), String> {
    // `@@ -12,4 +12,4 @@` or `@@ -12 +12 @@`
    let inner = header
        .trim_start_matches("@@")
        .trim_end_matches("@@")
        .trim();
    let parts: Vec<&str> = inner.split_whitespace().collect();
    let old_part = parts.first().ok_or_else(|| format!("无法解析 diff 头: {header}"))?.trim_start_matches('-');
    let (start, count) = match old_part.split_once(',') {
        Some((s, c)) => (
            s.parse::<usize>().map_err(|_| format!("无法解析 diff 行号: {header}"))?,
            c.parse::<usize>().unwrap_or(1),
        ),
        None => (old_part.parse::<usize>().map_err(|_| format!("无法解析 diff 行号: {header}"))?, 1),
    };
    Ok((start, count))
}

/// List files in the project root (relative paths, `.texbutler` excluded).
/// Shown to the AI so it never references files that do not exist.
fn project_file_listing(project: &Project) -> Vec<String> {
    let mut files = Vec::new();
    crate::core::project::flatten_tree(project.file_tree(), &mut files);
    files
}

/// Scan a source text for `\includegraphics`/`\input`/`\include`/
/// `\bibliography` references that do not exist in the project.
/// `is_diff` strips diff markers: when scanning a DIFF, only `+` lines are
/// checked; when scanning plain source, all lines are checked (a LaTeX line
/// legitimately starting with `-` must not be skipped).
fn missing_references_in_text(project: &Project, text: &str, is_diff: bool) -> Vec<String> {
    let mut missing: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in text.lines() {
        let content = if is_diff {
            // in diff mode ONLY added lines introduce new references —
            // context lines (space prefix) and `@@`/`---`/`+++` headers
            // must not be scanned (their references pre-exist in the file)
            if !line.starts_with('+') {
                continue;
            }
            &line[1..]
        } else {
            line
        };
        for (cmd, pattern) in [
            ("\\includegraphics", None),
            ("\\input", Some(".tex")),
            ("\\include", Some(".tex")),
            ("\\bibliography", Some(".bib")),
        ] {
            if !content.contains(cmd) {
                continue;
            }
            // extract `{...}` right after the command (skipping optional
            // `[...]` arguments like `\includegraphics[width=0.7\linewidth]`)
            let Some(open) = content.find(cmd) else { continue };
            let mut rest = content[open + cmd.len()..].trim_start();
            while rest.starts_with('[') {
                match rest.find(']') {
                    Some(close_bracket) => rest = rest[close_bracket + 1..].trim_start(),
                    None => break,
                }
            }
            let Some(rest) = rest.strip_prefix('{') else { continue };
            let Some(close) = rest.find('}') else { continue };
            let name = rest[..close].trim().to_string();
            if name.is_empty() || seen.contains(&name) {
                continue;
            }
            seen.insert(name.clone());
            // resolve: try as-is, then with the expected extension
            let mut candidates = vec![name.clone()];
            if let Some(ext) = pattern {
                if !name.ends_with(ext) {
                    candidates.push(format!("{name}{ext}"));
                }
            }
            let exists = candidates
                .iter()
                .any(|c| project.resolve(c).map(|p| p.is_file()).unwrap_or(false));
            if !exists {
                missing.push(name);
            }
        }
    }
    missing
}

/// Audit a proposed diff before applying it: every `\includegraphics`,
/// `\input`, `\include`, `\bibliography` reference introduced by the diff
/// must resolve to a file that actually exists in the project. Otherwise the
/// fix would replace one "file not found" error with another (the q1_zh
/// report: the AI switched `image.png` → `image.pdf` although neither
/// existed).
fn validate_diff_references(project: &Project, diff_text: &str) -> Result<(), String> {
    let missing = missing_references_in_text(project, diff_text, true);
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "审核未通过：diff 引用了项目中不存在的文件（{}）。请勿引用不存在的文件。项目中的文件：{}",
            missing.join(", "),
            project_file_listing(project).join("、")
        ))
    }
}

/// Deterministic fixes for unambiguous, machine-verifiable errors — applied
/// BEFORE asking the AI (the AI often fails to add missing packages, e.g.
/// it rewrote `\color{red!60}` to `\textcolor{...}` instead of loading
/// xcolor). Only provably-correct edits are made here.
fn deterministic_fix(content: &str, issue: &Issue) -> Option<String> {
    let raw = issue.raw.as_deref().unwrap_or("");
    let low = raw.to_lowercase();

    // 1) Undefined `\color`/`\textcolor`/`\definecolor` and xcolor not loaded
    //    → insert `\usepackage{xcolor}` right after the \documentclass line.
    let undefined_color = (low.contains("undefined control sequence") || low.contains("undefined"))
        && (raw.contains("\\color") || raw.contains("\\textcolor") || raw.contains("\\definecolor"))
        && !content.contains("\\usepackage{xcolor}");
    if undefined_color {
        let mut out = String::new();
        let mut inserted = false;
        for line in content.lines() {
            out.push_str(line);
            out.push('\n');
            if !inserted && line.contains("\\documentclass") {
                out.push_str("\\usepackage{xcolor}\n");
                inserted = true;
            }
        }
        if !inserted {
            return Some(format!("\\usepackage{{xcolor}}\n{content}"));
        }
        return Some(out);
    }

    // 2) `\begin{document}` without `\end{document}` → append it.
    if content.contains("\\begin{document}") && !content.contains("\\end{document}") {
        return Some(format!("{content}\n\\end{{document}}\n"));
    }

    // 3) Standalone undefined command on its own line (`\undefinedcommand`)
    //    → drop EXACTLY the line reported by the compiler (issue.line), and
    //    only when its trimmed content IS the command. Commands embedded in
    //    sentences and other occurrences of the same name are untouched.
    if low.contains("undefined control sequence") {
        if let Some(cmd) = extract_undefined_cmd(raw) {
            if let Some(target_line) = issue.line {
                let mut out = String::new();
                let mut removed = false;
                for (i, line) in content.lines().enumerate() {
                    if i + 1 == target_line && line.trim() == cmd {
                        removed = true; // drop exactly this line
                    } else {
                        out.push_str(line);
                        out.push('\n');
                    }
                }
                if removed {
                    return Some(out);
                }
            }
        }
    }

    // 4) Paragraph gluing (rule "paragraph"): adjacent prose lines with no
    //    blank line between them → insert blank lines. This is a
    //    deterministic, machine-verifiable fix applied to ALL glued pairs
    //    at once (the user's 143-issue report gets fixed in one pass
    //    instead of one AI round per issue).
    if issue.rule_id.as_deref() == Some("paragraph") {
        return fix_paragraph_gluing(content);
    }

    None
}

/// Insert a blank line between every pair of adjacent prose lines (both
/// ≥ 4 chars, per the paragraph rule heuristic). Command lines, comments,
/// environment delimiters and table rows are left untouched (the rule's
/// `is_prose_line` already excludes them). Scans the whole file so a batch
/// of gluing issues is repaired in a single deterministic pass.
fn fix_paragraph_gluing(content: &str) -> Option<String> {
    let mut lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();
    let mut changed = false;
    let mut i = 0;
    while i + 1 < lines.len() {
        let a = lines[i].trim();
        let b = lines[i + 1].trim();
        let a_prose = crate::core::rules::paragraph::is_prose_line(a);
        let b_prose = crate::core::rules::paragraph::is_prose_line(b);
        if a_prose && b_prose && a.chars().count() >= 4 && b.chars().count() >= 4 {
            lines.insert(i + 1, String::new());
            changed = true;
            i += 2; // skip the inserted blank
        } else {
            i += 1;
        }
    }
    changed.then(|| lines.join("\n"))
}

/// Extract the undefined command name from a raw error block.
fn extract_undefined_cmd(raw: &str) -> Option<String> {
    for line in raw.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("l.") {
            // e.g. `27 \undefinedcommand` or `27 ...\undefinedcommand`
            if let Some(word) = rest.split_whitespace().find(|w| w.starts_with('\\')) {
                let cmd = word.trim_end_matches(|c: char| !c.is_ascii_alphabetic() && c != '@');
                if cmd.len() > 1 {
                    return Some(cmd.to_string());
                }
            }
        }
    }
    None
}

/// Detect "missing file" errors (Unable to load picture / File not found)
/// and extract the referenced filename. AI cannot fix a physically missing
/// file — failing fast with a clear message beats burning 3 rounds.
fn missing_file_from_error(issues: &[Issue]) -> Option<String> {
    for i in issues {
        let raw = i.raw.as_deref().unwrap_or("");
        let low = raw.to_lowercase();
        let is_missing = low.contains("unable to load picture")
            || low.contains("unable to load image")
            || (low.contains("file") && low.contains("not found"));
        if !is_missing {
            continue;
        }
        for needle in ['\'', '`'] {
            if let Some(start) = raw.find(needle) {
                let rest = &raw[start + 1..];
                if let Some(end) = rest.find(needle) {
                    let name = &rest[..end];
                    if !name.is_empty() && name.chars().count() < 200 {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Minimum token budget for the fix loop (DeepSeek thinking mode verified to
/// exhaust 1024 tokens with an empty reply; 4096 produces a valid diff).
fn fix_max_tokens(user_setting: u32) -> u32 {
    user_setting.max(4096).min(16384)
}

/// Locate where a hunk should start applying. Prefers the `@@` line number;
/// when the content there does not match (AI diffs often have line numbers
/// off by a few lines), collects every position in a ±15-line window (whole
/// file when the suggestion is out of bounds) where the FULL hunk matches —
/// ambiguous positions are rejected with an error so a repeated anchor line
/// can never silently modify the wrong spot.
fn locate_hunk_start(target: &[String], body: &[&str], suggested: usize) -> Result<usize, String> {
    if target.is_empty() {
        return Ok(suggested);
    }

    // quick check: does the suggested position match the whole hunk?
    if hunk_matches_at(target, body, suggested) {
        return Ok(suggested);
    }

    // collect every position in the window where the FULL hunk matches
    let last = target.len().saturating_sub(1);
    let lo = if suggested > last {
        0
    } else {
        suggested.saturating_sub(15)
    };
    let hi = suggested.saturating_add(15).min(last);
    if lo > hi {
        return Ok(suggested);
    }
    let mut found: Option<usize> = None;
    for idx in lo..=hi {
        if hunk_matches_at(target, body, idx) {
            if found.is_some() {
                return Err(
                    "diff 锚定位置不唯一（文件中存在多处匹配），为避免误改已拒绝应用。请修改后重试或手动编辑。"
                        .to_string(),
                );
            }
            found = Some(idx);
        }
    }
    Ok(found.unwrap_or(suggested))
}

/// True when the hunk body (context lines + removed lines) matches the file
/// starting at 0-based index `idx`. Added lines are ignored here; the
/// application pass re-validates everything.
fn hunk_matches_at(target: &[String], body: &[&str], mut idx: usize) -> bool {
    let mut bi = 0;
    while bi < body.len() {
        let line = body[bi];
        let c = line.chars().next();
        match c {
            Some('-') => {
                let expected = &line[1..];
                // no-op pair handling mirrors apply_hunk: `-X`+`+X` same
                // content consumes one old line without requiring changes
                if let Some(next) = body.get(bi + 1) {
                    if next.starts_with('+') && &next[1..] == expected {
                        if target.get(idx).map(|o| diff_line_matches(o, expected)).unwrap_or(false) {
                            idx = match idx.checked_add(1) {
                                Some(v) => v,
                                None => return false,
                            };
                            bi += 2;
                            continue;
                        }
                    }
                }
                // strict: a `-` line removes exactly that line (an empty
                // `-` removes an empty line — never any line); removing the
                // file's final (empty) line is allowed
                match target.get(idx) {
                    Some(old) if diff_line_matches(old, expected) => {}
                    None if expected.is_empty() => {}
                    _ => return false,
                }
                idx = match idx.checked_add(1) {
                    Some(v) => v,
                    None => return false,
                };
            }
            Some('+') => {}
            _ => {
                let context = line.strip_prefix(' ').unwrap_or(line);
                match target.get(idx) {
                    Some(old) if diff_line_matches(old, context) => {}
                    _ => return false,
                }
                idx = match idx.checked_add(1) {
                    Some(v) => v,
                    None => return false,
                };
            }
        }
        bi += 1;
    }
    true
}

/// Rollback snapshot: copy file content into `.texbutler/backup/<ts>/<rel>`.
/// The relative path is validated through `Project::resolve` so a caller
/// can never write outside the backup dir via `../`.
pub fn snapshot(project: &Project, rel: &str, content: &str) -> Result<PathBuf, String> {
    let safe_rel = if Path::new(rel).is_absolute() {
        project.relative_path(rel)
    } else {
        rel.to_string()
    };
    if project.resolve(&safe_rel).is_none() {
        return Err(format!("非法备份路径: {rel}"));
    }
    let ts = chrono_like_timestamp();
    let dir = project.backup_dir().join(ts);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&safe_rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path)
}

fn chrono_like_timestamp() -> String {
    // no chrono dependency: use system time formatted manually.
    // Milliseconds avoid collisions when AI chat edits snapshot twice
    // within the same second (rollback would restore the wrong content).
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{:010}-{:03}", now.as_secs(), now.subsec_millis())
}

/// Redact the API key from an error string before it reaches the UI.
fn redact_key_in(s: &AiSettings, err: &super::provider::AiError) -> String {
    let msg = err.to_string();
    match &s.api_key {
        Some(k) if !k.is_empty() && msg.contains(k.as_str()) => msg.replace(k, "***"),
        _ => msg,
    }
}

/// The full fix loop. `compile` is injected so tests can stub it.
/// `apply: true` (default) writes the diff and recompiles; `apply: false`
/// is suggest mode — the AI diff is returned without touching the disk.
pub async fn fix_loop(
    issue: &Issue,
    project: &Project,
    s: &AiSettings,
    max_rounds: u32,
    apply: bool,
) -> FixReport {
    let max_rounds = max_rounds.clamp(1, 5);
    let file = issue
        .file
        .clone()
        .map(|f| project.relative_path(&f))
        .unwrap_or_else(|| project.main_file.clone());
    let Ok(original) = project.read_file(&file) else {
        return FixReport {
            ok: false,
            rounds: 0,
            diff: None,
            summary: format!("无法读取文件 `{file}`，放弃修复。"),
            issues_after: vec![],
            rolled_back: false,
            backup: None,
            hunks: vec![],
            suggested: !apply,
        };
    };

    let ctx = SourceContext::around(&file, issue.line, &original, 20);
    let mut current_content = original.clone();
    let mut last_diff: Option<String> = None;
    let mut last_error: String = String::new();
    let mut rolled_back = false;
    let mut issues_after: Vec<Issue> = Vec::new();
    // Track the CURRENT error: after each failed round the first real Error
    // becomes the target (deterministic fixes and the AI must see the error
    // that is actually failing NOW, not the original one).
    let mut current_issue = issue.clone();

    // Project file inventory for the AI: it must not reference files that
    // do not exist (e.g. suggesting `image.pdf` when only `image.png` is
    // missing entirely — see the q1_zh user report).
    let project_files = project_file_listing(project);
    // Dependency chain of the target file: `\input`/`\include` reachable
    // files with contents, so the AI can fix cross-file errors.
    let deps: Vec<(String, String)> = if apply {
        let mut chain = project.dependency_chain(&file);
        chain.retain(|(rel, _)| rel != &file);
        chain
    } else {
        Vec::new()
    };

    for round in 1..=max_rounds {
        // Fail fast on missing-file errors (e.g. `Unable to load picture`):
        // the AI cannot fix a physically absent file, and models sometimes
        // waste rounds emitting unrelated no-op diffs for such errors.
        if let Some(missing) = missing_file_from_error(std::slice::from_ref(&current_issue)) {
            return FixReport {
                ok: false,
                rounds: round - 1,
                diff: None,
                summary: format!(
                    "项目缺少文件 `{missing}`，AI 无法修复（文件本身不存在）。请将该文件放入项目目录后重新编译。"
                ),
                issues_after: issues_after.clone(),
                rolled_back: false,
                backup: None,
                hunks: vec![],
                suggested: !apply,
            };
        }
        // Deterministic fixes first: unambiguous errors (missing xcolor,
        // standalone undefined commands, missing \end{document}) are fixed
        // without the AI — it repeatedly failed to add `\usepackage{xcolor}`
        // or delete `\undefinedcommand` (rewrote them instead).
        // Suggest mode skips deterministic fixes: they have no diff to
        // preview, so the AI proposal is the only thing the user can review.
        if apply {
            if let Some(det_content) = deterministic_fix(&current_content, &current_issue) {
                if det_content != current_content {
                // keep a backup snapshot before the deterministic write so a
                // crash mid-loop cannot leave an unrecoverable file
                let snap_det = snapshot(project, &file, &current_content)
                    .ok()
                    .map(|p| p.to_string_lossy().to_string());
                if let Err(e) = project.write_file(&file, &det_content) {
                    last_error = format!("写入文件失败: {e}");
                } else {
                    let settings = crate::core::settings::Settings::load();
                    let scheduler =
                        CompilerScheduler::new_with_passes(settings.engine, settings.texlive_passes);
                    let proj_clone = project.clone();
                    let main_name = project.main_file.clone();
                    let det_result: CompileResult = tokio::task::spawn_blocking(move || {
                        scheduler.compile(&proj_clone, std::path::Path::new(&main_name), &|| false)
                    })
                    .await
                    .unwrap_or_else(|_| {
                        CompileResult::failed(project.log_path(), crate::core::compiler::EngineUsed::Tectonic, "编译任务异常")
                    });
                    if det_result.ok {
                        return FixReport {
                            ok: true,
                            rounds: round,
                            diff: Some("确定性修复（无需 AI）：".to_string()),
                            summary: format!("第 {round} 轮确定性修复成功：编译已通过（引擎: {}）。", det_result.engine.label()),
                            issues_after: det_result.issues,
                            rolled_back: false,
                            backup: snap_det,
                            hunks: vec![],
                            suggested: false,
                        };
                    }
                    issues_after = det_result.issues.clone();
                    // missing-file errors cannot be fixed by AI — fail fast
                    if let Some(missing) = missing_file_from_error(&issues_after) {
                        return FixReport {
                            ok: false,
                            rounds: round - 1,
                            diff: None,
                            summary: format!(
                                "项目缺少文件 `{missing}`，AI 无法修复（文件本身不存在）。请将该文件放入项目目录后重新编译。"
                            ),
                            issues_after,
                            rolled_back: false,
                            backup: None,
                            hunks: vec![],
                            suggested: !apply,
                        };
                    }
                    last_error = issues_after
                        .first()
                        .map(|i| i.raw.clone().unwrap_or_else(|| i.message.clone()))
                        .unwrap_or_else(|| "编译失败但无错误详情".into());
                    // advance to the current failing error (this branch used
                    // to `continue` past the update, so round 2 kept
                    // targeting the original error — the demo bug)
                    if let Some(next_err) = issues_after.iter().find(|i| i.severity == crate::core::Severity::Error) {
                        current_issue = next_err.clone();
                    }
                    // PROGRESSIVE deterministic fixes: KEEP the applied
                    // change (e.g. added xcolor) and continue from it next
                    // round — reverting to `original` made xcolor and
                    // \undefinedcommand fixes overwrite each other forever.
                    // The final rollback still restores the original file.
                    current_content = det_content;
                    continue;
                }
            }
        }
        }
        // Round ≥ 2 with a small file: hand the AI the complete numbered
        // source so diff line numbers/context stop hallucinating.
        let full_source = if round > 1 && original.lines().count() < 300 {
            Some(original.as_str())
        } else {
            None
        };
        let prompt = prompt_templates::fix_prompt(
            &current_issue,
            &ctx,
            round,
            if round > 1 { Some(&last_error) } else { None },
            &project_files,
            full_source,
            &deps,
        );
        let guide = crate::core::ai::guide::guide_system_fragment(project);
        let messages = vec![
            ChatMsg {
                role: "system".into(),
                content: prompt_templates::diagnose_system_prompt(&guide),
            },
            ChatMsg { role: "user".into(), content: prompt },
        ];
        // Diff generation needs headroom: DeepSeek's thinking mode can eat
        // the whole budget and return an EMPTY reply (verified against the
        // real API — 1024 tokens → empty content, 4096 → valid diff).
        let mut fix_settings = s.clone();
        fix_settings.max_tokens = fix_max_tokens(fix_settings.max_tokens);
        let reply = match chat(&fix_settings, &messages).await {
            Ok(t) => t,
            Err(e) => {
                return FixReport {
                    ok: false,
                    rounds: round - 1,
                    diff: None,
                    summary: format!("AI 调用失败: {}", redact_key_in(s, &e)),
                    issues_after: vec![],
                    rolled_back: false,
                    backup: None,
                    hunks: vec![],
                    suggested: !apply,
                };
            }
        };
        // Empty / unparseable AI replies: fail fast with a clear message
        // instead of burning the remaining rounds (the user's last report
        // showed "AI 原始回复: " with nothing after it).
        let trimmed_reply = reply.trim();
        if trimmed_reply.is_empty() {
            return FixReport {
                ok: false,
                rounds: round - 1,
                diff: None,
                summary: format!(
                    "AI 回复为空（第 {round} 轮）。请检查模型配置：模型名是否最新、API Key 是否有效、max_tokens 是否足够。当前模型: {}",
                    s.model
                ),
                issues_after: vec![],
                rolled_back: false,
                backup: None,
                hunks: vec![],
                suggested: !apply,
            };
        }
        let diff_text = strip_code_fences(trimmed_reply);
        last_diff = Some(diff_text.clone());
        if diff_text.trim().is_empty() {
            return FixReport {
                ok: false,
                rounds: round - 1,
                diff: None,
                summary: format!(
                    "AI 回复中没有可解析的 diff 内容（第 {round} 轮，回复 {} 字）。请检查模型配置或换用支持代码输出的模型。原始回复开头: {}",
                    trimmed_reply.chars().count(),
                    truncate(trimmed_reply, 120),
                ),
                issues_after: vec![],
                rolled_back: false,
                backup: None,
                hunks: vec![],
                suggested: !apply,
            };
        }

        let new_content = match apply_unified_diff(&current_content, &diff_text) {
            Ok(c) => c,
            Err(e) => {
                last_error = format!("diff 无法应用: {e}（AI 原始回复: {}）", truncate(trimmed_reply, 200));
                continue;
            }
        };
        if new_content == current_content {
            last_error = "AI 给出的 diff 没有产生任何修改".into();
            continue;
        }

        // ---- feasibility audit ----
        // The diff must not introduce references to files that do not exist
        // (the AI once replaced a missing `.png` with a missing `.pdf`).
        if let Err(audit_err) = validate_diff_references(project, &diff_text) {
            last_error = audit_err;
            // give the AI one more round with the audit feedback
            continue;
        }

        // ---- suggest mode: return the proposal without touching the disk ----
        if !apply {
            let mut hunks = build_hunks(&diff_text, &file);
            attach_explanations(&mut hunks, &trimmed_reply);
            return FixReport {
                ok: true,
                rounds: round,
                diff: Some(diff_text.clone()),
                summary: format!(
                    "已生成修复建议（第 {round} 轮，未应用）。你可以逐块审阅后手动应用，或切换回自动模式重试。"
                ),
                issues_after: vec![],
                rolled_back: false,
                backup: None,
                hunks,
                suggested: true,
            };
        }

        // apply with rollback snapshot
        let snap = snapshot(project, &file, &current_content)
            .ok()
            .map(|p| p.to_string_lossy().to_string());
        if let Err(e) = project.write_file(&file, &new_content) {
            last_error = format!("写入文件失败: {e}");
            continue;
        }

        // recompile (blocking engine → run on a blocking thread)
        let settings = crate::core::settings::Settings::load();
        let scheduler = CompilerScheduler::new_with_passes(settings.engine, settings.texlive_passes);
        let proj_clone = project.clone();
        let main_name = project.main_file.clone();
        let result: CompileResult = tokio::task::spawn_blocking(move || {
            scheduler.compile(&proj_clone, std::path::Path::new(&main_name), &|| false)
        })
        .await
        .unwrap_or_else(|_| CompileResult::failed(project.log_path(), crate::core::compiler::EngineUsed::Tectonic, "编译任务异常"));
        issues_after = result.issues.clone();
        // missing-file errors cannot be fixed by AI — fail fast with a
        // clear message instead of burning the remaining rounds
        if let Some(missing) = missing_file_from_error(&issues_after) {
            return FixReport {
                ok: false,
                rounds: round - 1,
                diff: last_diff,
                summary: format!(
                    "项目缺少文件 `{missing}`，AI 无法修复（文件本身不存在）。请将该文件放入项目目录后重新编译。"
                ),
                issues_after,
                rolled_back: false,
                backup: None,
                hunks: vec![],
                suggested: !apply,
            };
        }
        if result.ok {
            let mut hunks = build_hunks(&diff_text, &file);
            attach_explanations(&mut hunks, &trimmed_reply);
            return FixReport {
                ok: true,
                rounds: round,
                diff: Some(diff_text),
                summary: format!("第 {round} 轮修复成功：编译已通过（引擎: {}）。", result.engine.label()),
                issues_after,
                rolled_back: false,
                backup: snap,
                hunks,
                suggested: false,
            };
        }
        // failed: revert this round's edit (back to current_content, which
        // includes any progressive deterministic fixes)
        if let Some(snap_path) = snap {
            if let Ok(backup) = std::fs::read_to_string(&snap_path) {
                let _ = project.write_file(&file, &backup);
                rolled_back = true;
            }
        }
        // do NOT reset to `original` — deterministic fixes applied earlier
        // must survive; the final failure path restores the original file
        last_error = issues_after
            .first()
            .map(|i| i.raw.clone().unwrap_or_else(|| i.message.clone()))
            .unwrap_or_else(|| "编译失败但无错误详情".into());
        // advance to the first real Error so the next round targets the
        // error that is actually failing now
        if let Some(next_err) = issues_after.iter().find(|i| i.severity == crate::core::Severity::Error) {
            current_issue = next_err.clone();
        }
        // If the file references files that do not exist in the project,
        // tell the AI explicitly — otherwise it keeps guessing extensions
        // (q1_zh: `.png` → `.pdf` when neither exists).
        let missing = missing_references_in_text(project, &new_content, false);
        if !missing.is_empty() {
            last_error = format!(
                "{} 此外：当前文件引用的以下文件在项目中不存在（请勿改为其他扩展名，它们同样不存在）：{}。项目中的文件：{}",
                last_error,
                missing.join("、"),
                project_file_listing(project).join("、"),
            );
        }
    }

    // final failure: restore original content
    if rolled_back {
        let _ = project.write_file(&file, &original);
    } else if current_content != original {
        let _ = project.write_file(&file, &original);
    }
    FixReport {
        ok: false,
        rounds: max_rounds,
        diff: last_diff,
        summary: format!("{max_rounds} 轮修复均未通过编译，已回滚原文件。最后一次错误: {}", truncate(&last_error, 300)),
        issues_after,
        rolled_back: true,
        backup: None,
        hunks: vec![],
        suggested: !apply,
    }
}

/// Split a unified diff into per-hunk (line, old, new) summaries for the
/// frontend's per-hunk review UI (suggest mode / diff details).
pub fn build_hunks(diff: &str, file: &str) -> Vec<crate::core::FixHunk> {
    let mut out = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut start_line: Option<u32> = None;
    let flush = |hunk: &mut Vec<&str>, line: Option<u32>, out: &mut Vec<crate::core::FixHunk>| {
        if hunk.is_empty() {
            return;
        }
        let mut old = String::new();
        let mut new = String::new();
        for l in hunk.iter().skip(1) {
            if let Some(rest) = l.strip_prefix('-') {
                if !rest.starts_with('-') {
                    old.push_str(rest);
                    old.push('\n');
                }
            } else if let Some(rest) = l.strip_prefix('+') {
                if !rest.starts_with('+') {
                    new.push_str(rest);
                    new.push('\n');
                }
            } else if let Some(rest) = l.strip_prefix(' ') {
                // context line: keep it on BOTH sides so the rebuilt
                // per-hunk patch keeps its anchor and can be applied
                // even when the hunk text appears multiple times
                old.push_str(rest);
                old.push('\n');
                new.push_str(rest);
                new.push('\n');
            }
        }
        out.push(crate::core::FixHunk {
            file: file.to_string(),
            line: line.unwrap_or(0),
            old: old.trim_end().to_string(),
            new: new.trim_end().to_string(),
            why: String::new(),
        });
    };
    for line in diff.lines() {
        let trimmed = line.trim();
        if trimmed == "解释：" || trimmed == "解释:" || trimmed == "Explanation:" {
            break;
        }
        if line.starts_with("@@") {
            if !current.is_empty() {
                flush(&mut current, start_line, &mut out);
            }
            start_line = parse_hunk_line_no(line);
            current.clear();
            current.push(line);
        } else if line.starts_with("+++ ") || line.starts_with("--- ") {
            continue;
        } else if !current.is_empty() {
            if is_valid_diff_line(line) {
                current.push(line);
            } else {
                flush(&mut current, start_line, &mut out);
                current.clear();
            }
        }
    }
    if !current.is_empty() {
        flush(&mut current, start_line, &mut out);
    }
    out
}

/// Parse `@@ -old,n +new,n @@` and return the new-file start line.
fn parse_hunk_line_no(line: &str) -> Option<u32> {
    let rest = line.strip_prefix("@@")?;
    let plus = rest.find('+')?;
    let after_plus = &rest[plus + 1..];
    let start: String = after_plus
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    start.parse().ok()
}

/// Parse AI-provided per-hunk explanations appended after the diff:
///
/// ```text
/// 解释：
/// - 行12: 缺少宏包 xcolor，补上后颜色命令可用
/// - 行45: 未定义命令 \foo 被删除
/// ```
///
/// Lines are matched to hunks by their start line. Explanations are
/// best-effort: missing or malformed ones leave `why` empty.
pub fn attach_explanations(hunks: &mut [crate::core::FixHunk], reply: &str) {
    let mut want_explain = false;
    for line in reply.lines() {
        let l = line.trim();
        if l == "解释：" || l == "Explanation:" || l == "解释:" {
            want_explain = true;
            continue;
        }
        if !want_explain {
            continue;
        }
        if l.is_empty() {
            continue;
        }
        let Some(rest) = l.strip_prefix("- 行") else {
            // a non-explanation line ends the section
            want_explain = false;
            continue;
        };
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let Ok(num) = digits.parse::<u32>() else { continue };
        let why = rest[digits.len()..]
            .trim_start_matches(':')
            .trim_start_matches('：')
            .trim()
            .to_string();
        if why.is_empty() {
            continue;
        }
        for h in hunks.iter_mut() {
            if h.line == num && h.why.is_empty() {
                h.why = why.clone();
                break;
            }
        }
    }
}

/// A snapshot entry in the project's backup timeline.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SnapshotInfo {
    /// Full path to the snapshot file (pass to `tb_ai_rollback`).
    pub path: String,
    /// Unix timestamp (seconds) of the snapshot.
    pub ts: String,
    /// The project-relative file it backs up.
    pub file: String,
}

/// List every snapshot in `<root>/.texbutler/backup/` newest first.
pub fn list_snapshots(project: &Project) -> Result<Vec<SnapshotInfo>, String> {
    let dir = project.backup_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<SnapshotInfo> = Vec::new();
    for e in entries.flatten() {
        let ts = e.file_name().to_string_lossy().to_string();
        let Ok(files) = std::fs::read_dir(e.path()) else { continue };
        for f in files.flatten() {
            let file = f.file_name().to_string_lossy().to_string();
            out.push(SnapshotInfo {
                path: f.path().to_string_lossy().to_string(),
                ts: ts.clone(),
                file,
            });
        }
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(out)
}

/// Restore a file from a snapshot created by `snapshot()` (reject flow).
///
/// The snapshot path must live inside the project backup dir; the relative
/// target is derived from `<backup_dir>/<ts>/<rel>` and written back through
/// `Project::write_file` (path-traversal safe).
pub fn rollback_from_backup(project: &Project, backup: &str) -> Result<String, String> {
    let backup_dir = project.backup_dir();
    let path = std::path::Path::new(backup);
    let rel_to_backup = path
        .strip_prefix(&backup_dir)
        .map_err(|_| "备份路径不在项目备份目录内".to_string())?;
    // reject traversal components: `<backup_dir>/../../x` must not read (or
    // later write) files outside the backup dir even though the prefix matches
    for comp in rel_to_backup.components() {
        if matches!(
            comp,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        ) {
            return Err("备份路径包含非法组件".into());
        }
    }
    let mut comps = rel_to_backup.components();
    let _ts = comps
        .next()
        .ok_or_else(|| "备份路径缺少时间戳目录".to_string())?;
    let rel: std::path::PathBuf = comps.collect();
    let rel_str = rel.to_string_lossy().to_string();
    if rel_str.is_empty() {
        return Err("备份路径无效".into());
    }
    // Symlink defense: the backup read must resolve inside the backup dir.
    let Ok(canon) = std::fs::canonicalize(path) else {
        return Err("备份文件不存在".into());
    };
    let backup_canon =
        std::fs::canonicalize(&backup_dir).unwrap_or_else(|_| backup_dir.clone());
    if !canon.starts_with(&backup_canon) {
        return Err("备份路径越界（符号链接指向备份目录外）".into());
    }
    let content = std::fs::read_to_string(&canon).map_err(|e| format!("读取备份失败: {e}"))?;
    project.write_file(&rel_str, &content)?;
    Ok(rel_str)
}

fn strip_code_fences(reply: &str) -> String {
    let t = reply.trim();
    if t.starts_with("```") {
        let without_first = &t[3..];
        // strip optional language tag on the first line
        let body = match without_first.find('\n') {
            Some(nl) => &without_first[nl + 1..],
            None => without_first,
        };
        return body.trim_end_matches("```").trim().to_string();
    }
    t.to_string()
}

fn truncate(s: &str, max: usize) -> String {
    // truncate at a char boundary (byte slicing into a multi-byte UTF-8
    // sequence would panic; AI replies are untrusted input)
    match s.char_indices().nth(max) {
        Some((idx, _)) => format!("{}…", &s[..idx]),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_hunks_keeps_context_lines() {
        // context lines (` ` prefix) must survive into old AND new so the
        // rebuilt per-hunk patch keeps its anchor
        let diff = "@@ -1,3 +1,3 @@\n context-a\n-old line\n+new line\n context-b\n";
        let hunks = build_hunks(diff, "main.tex");
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0].old.contains("context-a"), "old keeps context: {:?}", hunks[0].old);
        assert!(hunks[0].new.contains("context-a"), "new keeps context: {:?}", hunks[0].new);
        assert!(hunks[0].old.contains("old line"));
        assert!(hunks[0].new.contains("new line"));
    }

    #[test]
    fn explanations_after_diff_are_not_parsed_as_lines() {
        // The AI appends `解释：` after the diff; the explanation lines
        // start with `- 行N:` and must not be treated as diff removals.
        let src = "\\documentclass{article}\n\\begin{document}\n\\undefinedcmd\n\\end{document}\n";
        let diff = "--- a/main.tex\n+++ b/main.tex\n@@ -3,1 +3,1 @@\n-\\undefinedcmd\n+\n解释：\n- 行3: 删除未定义的命令\n";
        let out = apply_unified_diff(src, diff).expect("explanation lines must be ignored");
        assert!(!out.contains("undefinedcmd"));
        assert!(!out.contains("行3"));
    }

    #[test]
    fn build_hunks_splits_multiple_hunks() {
        let diff = "--- a/main.tex\n+++ b/main.tex\n@@ -1,2 +1,3 @@\n-old line\n+new line\n+extra\n@@ -10,1 +10,1 @@\n-second change\n+first change\n";
        let hunks = build_hunks(diff, "main.tex");
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].line, 1);
        assert!(hunks[0].old.contains("old line"));
        assert!(hunks[0].new.contains("new line"));
        assert!(hunks[0].new.contains("extra"));
        assert_eq!(hunks[1].line, 10);
        assert_eq!(hunks[0].file, "main.tex");
    }

    #[test]
    fn attach_explanations_matches_by_line() {
        let diff = "@@ -1,2 +1,3 @@\n-old\n+new\n";
        let reply = format!("{diff}\n解释：\n- 行1: 修复了格式问题\n- 行10: 未匹配的解释\n");
        let mut hunks = build_hunks(&diff, "main.tex");
        attach_explanations(&mut hunks, &reply);
        assert_eq!(hunks[0].why, "修复了格式问题");
    }

    #[test]
    fn attach_explanations_ignores_garbage() {
        let diff = "@@ -1,1 +1,1 @@\n-a\n+b\n";
        let mut hunks = build_hunks(&diff, "main.tex");
        attach_explanations(&mut hunks, "无解释段的回复");
        assert!(hunks[0].why.is_empty());
    }

    #[test]
    fn deterministic_fix_adds_missing_xcolor() {
        let content = "\\documentclass[UTF8]{ctexart}\n\\usepackage{graphicx}\n\\begin{document}\n{\\color{red!60}文本}\n\\end{document}\n";
        let issue = Issue::new(
            crate::core::Severity::Error,
            crate::core::IssueKind::CompileError,
            "x",
        )
        .with_raw("! Undefined control sequence.\nl.4 {\\color");
        let fixed = deterministic_fix(content, &issue).unwrap();
        assert!(fixed.contains("\\usepackage{xcolor}"));
        assert!(fixed.contains("\\color{red!60}"));
        // inserted after documentclass
        assert!(fixed.starts_with("\\documentclass[UTF8]{ctexart}\n\\usepackage{xcolor}\n"));
    }

    #[test]
    fn deterministic_fix_appends_missing_end_document() {
        let content = "\\begin{document}\n内容\n";
        let issue = Issue::new(crate::core::Severity::Error, crate::core::IssueKind::CompileError, "x");
        let fixed = deterministic_fix(content, &issue).unwrap();
        assert!(fixed.ends_with("\\end{document}\n"));
    }

    #[test]
    fn deterministic_fix_returns_none_when_not_applicable() {
        let content = "\\begin{document}\n\\end{document}\n";
        let issue = Issue::new(crate::core::Severity::Error, crate::core::IssueKind::CompileError, "x")
            .with_raw("! Undefined control sequence.\nl.3 \\foo");
        assert!(deterministic_fix(content, &issue).is_none());
    }

    #[test]
    fn deterministic_fix_removes_standalone_undefined_command() {
        let content = "\\begin{document}\n正文\n\\undefinedcommand\n\\undefinedcommand\n\\end{document}\n";
        let issue = Issue::new(crate::core::Severity::Error, crate::core::IssueKind::CompileError, "x")
            .with_raw("! Undefined control sequence.\nl.3 \\undefinedcommand\n\nThe control sequence at the end of the top line of your error message was never \\def'ed.")
            .with_line(3);
        let fixed = deterministic_fix(content, &issue).unwrap();
        // only line 3 is removed; the second occurrence survives untouched
        let lines: Vec<&str> = fixed.lines().collect();
        assert_eq!(lines.len(), 4, "只应删除一行: {fixed:?}");
        assert_eq!(lines[0], "\\begin{document}");
        assert_eq!(lines[1], "正文");
        assert_eq!(lines[2], "\\undefinedcommand");
        assert_eq!(lines[3], "\\end{document}");
    }

    #[test]
    fn deterministic_fix_fixes_all_paragraph_gluing_at_once() {
        // three glued pairs + a legitimately separated pair: all glued
        // pairs get a blank line inserted in ONE pass; command/table lines
        // and already-separated prose stay untouched
        let content = "\\documentclass{article}\n\\begin{document}\n第一段文字内容\n第二段文字内容\n\\section*{标题}\n第三段文字内容\n第四段文字内容\n\n第五段文字内容\n\\begin{tabular}{cc}\na & b \\\\\n\\end{tabular}\n第六段文字内容\n\\end{document}\n";
        let issue = Issue::new(crate::core::Severity::Info, crate::core::IssueKind::RuleCheck, "段落粘连")
            .with_rule("paragraph", "在两行之间插入一个空行。");
        let fixed = deterministic_fix(content, &issue).expect("paragraph fix applies");
        let lines: Vec<&str> = fixed.lines().collect();
        // blank lines inserted between every adjacent prose pair
        let p1 = lines.iter().position(|l| l.contains("第一段")).unwrap();
        let p2 = lines.iter().position(|l| l.contains("第二段")).unwrap();
        let p3 = lines.iter().position(|l| l.contains("第三段")).unwrap();
        let p4 = lines.iter().position(|l| l.contains("第四段")).unwrap();
        assert_eq!(p2, p1 + 2, "第一段与第二段之间应有空行: {lines:?}");
        assert_eq!(p4, p3 + 2, "第三段与第四段之间应有空行: {lines:?}");
        // command / table lines untouched
        assert!(fixed.contains("\\section*{标题}"));
        assert!(fixed.contains("\\begin{tabular}{cc}"));
        // already-separated pair untouched: 第五段 keeps its blank line
        let p5 = lines.iter().position(|l| l.contains("第五段")).unwrap();
        assert!(lines[p5 - 1].trim().is_empty(), "第五段前的空行保留");
        // a re-run finds nothing more to fix (idempotent)
        let fixed2 = deterministic_fix(&fixed, &issue).unwrap_or_else(|| fixed.clone());
        assert_eq!(fixed2, fixed);
    }

    #[test]
    fn deterministic_fix_keeps_command_embedded_in_sentence() {
        // commands inside sentences are NOT removed (conservative)
        let content = "\\begin{document}\n这里调用 \\undefinedcommand 命令。\n\\end{document}\n";
        let issue = Issue::new(crate::core::Severity::Error, crate::core::IssueKind::CompileError, "x")
            .with_raw("! Undefined control sequence.\nl.2 这里调用 \\undefinedcommand 命令。")
            .with_line(2);
        assert!(deterministic_fix(content, &issue).is_none());
    }

    #[test]
    fn noop_remove_add_pair_is_ignored() {
        // AI "edits" a line without changing it: `-X` + `+X` identical.
        let original = "a\n\\undefinedcommand\nb\n";
        // mixed: no-op pair + real change → Ok, no-op line stays unchanged
        let diff = "@@ -1,3 +1,4 @@\n a\n-\\undefinedcommand\n+\\undefinedcommand\n b\n+\\usepackage{xcolor}\n";
        let result = apply_unified_diff(original, diff).unwrap();
        assert!(result.contains("\\usepackage{xcolor}"));
        assert!(result.contains("\\undefinedcommand"), "no-op 行应保留");

        // ONLY no-op pairs → Err "没有实际修改" (fix_loop reports this back
        // to the AI instead of burning a compile round)
        let diff2 = "@@ -1,1 +1,1 @@\n-a\n+a\n";
        assert!(apply_unified_diff(original, diff2).is_err());
    }

    #[test]
    fn applies_diff_with_end_of_diff_marker() {
        // user-reported: DeepSeek emits `*** End of diff` after the hunk;
        // it must not be treated as a context line
        let original = "a\n\\undefinedcommand\nb\n";
        let diff = "@@ -1,3 +1,3 @@\n a\n-\\undefinedcommand\n+\n b\n*** End of diff\n";
        let result = apply_unified_diff(original, diff).unwrap();
        assert!(!result.contains("\\undefinedcommand"));
        assert_eq!(result, "a\n\nb");
    }

    #[test]
    fn applies_diff_with_shifted_line_numbers() {
        // User-reported regression: AI generates `@@ -29` but the anchor
        // (`\begin{figure}[H]`) actually sits at line 27 — the old strict
        // matcher failed the whole fix round. The anchor search must locate
        // it by content within the ±15 window.
        let original = "段落文本行\n\n\\begin{figure}[H]\n\\centering\n\\includegraphics[width=0.72\\linewidth]{q1a_foundry_share.png}\n\\caption{x}\n\\label{fig:q1a}\n\\end{figure}\n";
        let diff = "@@ -29,7 +29,7 @@\n \\begin{figure}[H]\n \\centering\n-\\includegraphics[width=0.72\\linewidth]{q1a_foundry_share.png}\n+\\includegraphics[width=0.72\\linewidth]{q1a_foundry_share.pdf}\n \\caption{x}\n \\label{fig:q1a}\n \\end{figure}\n";
        let result = apply_unified_diff(original, diff).unwrap();
        assert!(result.contains("q1a_foundry_share.pdf"));
        assert!(!result.contains("q1a_foundry_share.png"));
        // surrounding structure preserved
        assert!(result.contains("\\begin{figure}[H]"));
        assert!(result.contains("\\end{figure}"));
    }

    #[test]
    fn empty_file_does_not_panic() {
        // regression: target.len()==0 used to index target[0]
        let diff = "@@ -1,3 +1,3 @@\n a\n-b\n+c\n";
        let result = apply_unified_diff("", diff);
        assert!(result.is_err());
    }

    #[test]
    fn huge_line_number_header_does_not_overflow() {
        // security: `suggested + 15` overflowed on crafted headers near
        // usize::MAX (2^63-1 is NOT enough on 64-bit — +15 still fits)
        let original = "a\nb\n";
        let diff = "@@ -18446744073709551615,1 +1,1 @@\n-a\n+A\n";
        let result = apply_unified_diff(original, diff);
        // must not panic; either clean error or correct application
        match result {
            Ok(r) => assert!(r.contains('A')),
            Err(_) => {}
        }
    }

    #[test]
    fn huge_line_number_with_empty_minus_does_not_overflow() {
        // security: giant @@ header + bare `-` lines must not overflow
        // idx (debug panic / release wrap would duplicate content)
        let original = "a\nb\n";
        let diff = "@@ -18446744073709551615,2 +1,0 @@\n-\n-\n";
        let result = apply_unified_diff(original, diff);
        // no panic; error (clean) or correct application, never duplication
        match result {
            Ok(r) => assert!(!r.contains("a\nb\na\nb\n")),
            Err(_) => {}
        }
    }

    #[test]
    fn bare_minus_line_removes_only_empty_lines() {
        // security: a bare `-` (delete empty line) must not delete a
        // non-empty line even after anchor calibration
        let original = "x\ny\nz\n";
        let diff = "@@ -1,1 +1,0 @@\n-\n";
        let result = apply_unified_diff(original, diff);
        assert!(result.is_err(), "must not delete non-empty line: {result:?}");
        // but an actual empty line IS removed
        let original2 = "x\n\ny\n";
        let diff2 = "@@ -1,2 +1,1 @@\n x\n-\n";
        let result2 = apply_unified_diff(original2, diff2).unwrap();
        assert_eq!(result2, "x\ny");
    }

    #[test]
    fn ambiguous_anchor_is_rejected_not_misapplied() {
        // repeated anchor line (`x` twice) + a line number far out of range:
        // the window search finds two full-hunk matches → refuse (no edit)
        let original = "x\ny\nz\nx\nw\n";
        let diff = "@@ -9,1 +9,1 @@\n-x\n+X\n";
        let result = apply_unified_diff(original, diff);
        assert!(result.is_err(), "must refuse ambiguous anchor: {result:?}");
    }

    #[test]
    fn unambiguous_anchor_still_applies() {
        // single `x` occurrence → calibration succeeds
        let original = "x\ny\nz\nw\n";
        let diff = "@@ -9,1 +9,1 @@\n-x\n+X\n";
        let result = apply_unified_diff(original, diff).unwrap();
        assert!(result.contains("X"));
        assert!(!result.contains("\nx\n"));
    }

    #[test]
    fn hunk_keeps_preceding_file_content() {
        // regression: applying a mid-file hunk used to drop the file head
        let original = "header1\nheader2\nmid\nb\ntail\n";
        let diff = "@@ -3,2 +3,2 @@\n-mid\n+MID\n b\n";
        let result = apply_unified_diff(original, diff).unwrap();
        assert!(result.starts_with("header1\nheader2\n"));
        assert!(result.contains("MID"));
        assert!(result.ends_with("tail"));
    }

    #[test]
    fn applies_simple_diff() {
        let original = "a\nb\nc\n";
        let diff = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
        let result = apply_unified_diff(original, diff).unwrap();
        assert_eq!(result, "a\nB\nc");
    }

    #[test]
    fn tolerates_trailing_whitespace_in_context() {
        // CRLF file + LLM dropped trailing spaces: must still apply
        let original = "\\documentclass{article}\r\n\\begin{document}\r\n正文\r\n\\end{document}\r\n";
        let diff = "@@ -1,4 +1,5 @@\n \\documentclass{article}\n+\\usepackage{float}\n \\begin{document}\n 正文\n \\end{document}\n";
        let result = apply_unified_diff(original, diff).unwrap();
        assert!(result.contains("\\usepackage{float}"));
        // trailing space on a context/removed line is tolerated too; the
        // file's original line (with its trailing spaces) is preserved
        let original2 = "a  \nb\n";
        let diff2 = "@@ -1,2 +1,2 @@\n a\n-b\n+B\n";
        assert_eq!(apply_unified_diff(original2, diff2).unwrap(), "a  \nB");
    }

    #[test]
    fn reports_failing_hunk_index() {
        // 2 hunks, second one has mismatched context → error names the hunk
        let original = "a\nb\nc\nd\ne\nf\n";
        let diff = "@@ -1,2 +1,3 @@\n a\n+x\n b\n@@ -5,2 +6,2 @@\n z\n-e\n+E\n";
        let err = apply_unified_diff(original, diff).unwrap_err();
        assert!(err.contains("hunk 无法应用"), "{err}");
        assert!(err.contains("2/2"), "{err}");
    }

    #[test]
    fn applies_insertion_diff() {
        let original = "a\nc\n";
        let diff = "@@ -1,2 +1,3 @@\n a\n+b\n c\n";
        let result = apply_unified_diff(original, diff).unwrap();
        assert_eq!(result, "a\nb\nc");
    }

    #[test]
    fn applies_without_hunk_header() {
        let original = "x\ny\n";
        let diff = "-x\n+x!\n";
        let result = apply_unified_diff(original, diff).unwrap();
        assert_eq!(result, "x!\ny");
    }

    #[test]
    fn rejects_mismatched_context() {
        let original = "a\nb\n";
        let diff = "@@ -1,2 +1,2 @@\n z\n-b\n+B\n";
        assert!(apply_unified_diff(original, diff).is_err());
    }

    #[test]
    fn strips_markdown_fences() {
        let reply = "```diff\n--- a\n+++ b\n@@ -1 +1 @@\n-x\n+x\n```";
        let d = strip_code_fences(reply);
        assert!(!d.contains("```"));
        assert!(d.contains("@@"));
    }

    #[test]
    fn fix_max_tokens_clamps() {
        assert_eq!(fix_max_tokens(1024), 4096);
        assert_eq!(fix_max_tokens(4096), 4096);
        assert_eq!(fix_max_tokens(20000), 16384);
        assert_eq!(fix_max_tokens(64), 4096);
    }

    #[test]
    fn diff_audit_ignores_context_line_references() {
        // a diff whose CONTEXT lines reference a missing file but whose
        // added lines introduce nothing new must pass the audit
        let root = std::env::temp_dir().join(format!("tb-audit3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let proj = crate::core::project::Project::create(&root, "p").unwrap();
        let diff = "@@ -1,3 +1,3 @@\n \\includegraphics{missing.png}\n-a\n+b\n";
        assert!(
            validate_diff_references(&proj, diff).is_ok(),
            "上下文行的既有引用不应误拒 diff"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn diff_audit_rejects_missing_files() {
        // the q1_zh regression: AI switches a missing `.png` to a missing
        // `.pdf` — the audit must refuse such a diff
        let root = std::env::temp_dir().join(format!("tb-audit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let proj = crate::core::project::Project::create(&root, "p").unwrap();
        let diff = "@@ -29,7 +29,7 @@\n \\begin{figure}[H]\n \\centering\n-\\includegraphics[width=0.72\\linewidth]{q1a_foundry_share.png}\n+\\includegraphics[width=0.72\\linewidth]{q1a_foundry_share.pdf}\n \\caption{x}\n \\label{fig:q1a}\n \\end{figure}\n";
        let err = validate_diff_references(&proj, diff).unwrap_err();
        assert!(err.contains("q1a_foundry_share.pdf"), "err: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn diff_audit_allows_existing_files() {
        let root = std::env::temp_dir().join(format!("tb-audit2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mut proj = crate::core::project::Project::create(&root, "p").unwrap();
        std::fs::write(proj.root.join("pic.png"), "fake").unwrap();
        proj.scan().unwrap();
        let diff = "@@ -1,1 +1,1 @@\n-a\n+\\includegraphics{pic.png}\n";
        assert!(validate_diff_references(&proj, diff).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn truncate_never_panics_on_multibyte() {
        // multi-byte UTF-8 (Chinese) must not be sliced mid-sequence
        let s = "中文回复内容测试";
        let t = truncate(s, 3);
        assert_eq!(t.chars().count(), 4); // 3 字符 + …
        assert!(t.starts_with("中文回"));
        let long = "a".repeat(500);
        assert_eq!(truncate(&long, 200).chars().count(), 201); // 200 + …
        assert_eq!(truncate(s, 100), s);
        assert_eq!(truncate("", 5), "");
        assert_eq!(truncate(s, 0), "…");
        assert_eq!(truncate("abc", 3), "abc");
    }

    #[test]
    fn rollback_rejects_traversal_backup_path() {
        // `<backup_dir>/../../outside` must be rejected even though the
        // string prefix matches the backup dir (review should-fix)
        let root = std::env::temp_dir().join(format!("tb-rollback-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let proj = crate::core::project::Project::open(&root).unwrap();
        let backup_dir = proj.backup_dir();
        let evil = backup_dir.join("..").join("..").join("..").join("outside.txt");
        let err = rollback_from_backup(&proj, evil.to_string_lossy().as_ref());
        assert!(err.is_err(), "traversal path must be rejected: {err:?}");
        // a legit snapshot (backup/<ts>/<rel>) still works
        let ts = backup_dir.join("20260101-000000");
        std::fs::create_dir_all(&ts).unwrap();
        let snap = ts.join("main.tex");
        std::fs::write(&snap, "\\end{document}\n").unwrap();
        let ok = rollback_from_backup(&proj, snap.to_string_lossy().as_ref());
        assert!(ok.is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    fn make_symlink(outside: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(outside, link)
    }

    #[cfg(unix)]
    fn make_symlink(outside: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(outside, link)
    }

    #[test]
    fn rollback_rejects_symlink_outside_backup_dir() {
        // symlink defense: a link inside backup/ pointing OUTSIDE must be
        // rejected (canonicalize check). Skipped when the OS denies
        // creating symlinks (CI without developer mode).
        let root = std::env::temp_dir().join(format!("tb-rollback-sym-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let proj = crate::core::project::Project::open(&root).unwrap();
        let outside = root.join("outside.txt");
        std::fs::write(&outside, "secret").unwrap();
        let backup_dir = proj.backup_dir();
        let ts = backup_dir.join("20260101-000000");
        std::fs::create_dir_all(&ts).unwrap();
        let link = ts.join("evil.txt");
        if make_symlink(&outside, &link).is_err() {
            // no symlink privilege on this machine — nothing to assert
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        let err = rollback_from_backup(&proj, link.to_string_lossy().as_ref());
        assert!(err.is_err(), "symlink to outside must be rejected: {err:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hunk_header_parsing() {
        assert_eq!(parse_hunk_header("@@ -12,4 +12,4 @@").unwrap(), (12, 4));
        assert_eq!(parse_hunk_header("@@ -3 +3 @@").unwrap(), (3, 1));
    }
}
