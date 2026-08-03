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
    // Apply hunks bottom-up so line numbers stay valid.
    for hunk in hunks.iter().rev() {
        result = apply_hunk(&result, hunk)?;
    }
    Ok(result)
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
                            Some(old) if old == expected => {
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
                    Some(old_line) if old_line == expected => {}
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
                    if old_line != context {
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

    None
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
                        if target.get(idx).map(|o| o == expected).unwrap_or(false) {
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
                    Some(old) if old == expected => {}
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
                    Some(old) if old == context => {}
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
    // no chrono dependency: use system time formatted manually
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{:010}", now.as_secs())
}

/// The full fix loop. `compile` is injected so tests can stub it.
pub async fn fix_loop(
    issue: &Issue,
    project: &Project,
    s: &AiSettings,
    max_rounds: u32,
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

    for round in 1..=max_rounds {
        // Deterministic fixes first: unambiguous errors (missing xcolor,
        // standalone undefined commands, missing \end{document}) are fixed
        // without the AI — it repeatedly failed to add `\usepackage{xcolor}`
        // or delete `\undefinedcommand` (rewrote them instead).
        if let Some(det_content) = deterministic_fix(&current_content, &current_issue) {
            if det_content != current_content {
                // keep a backup snapshot before the deterministic write so a
                // crash mid-loop cannot leave an unrecoverable file
                let _snap = snapshot(project, &file, &current_content).ok();
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
        );
        let messages = vec![
            ChatMsg { role: "system".into(), content: prompt_templates::SYSTEM_PROMPT.to_string() },
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
                    summary: format!("AI 调用失败: {e}"),
                    issues_after: vec![],
                    rolled_back: false,
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

        // apply with rollback snapshot
        let snap = snapshot(project, &file, &current_content).ok();
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
            };
        }
        if result.ok {
            return FixReport {
                ok: true,
                rounds: round,
                diff: Some(diff_text),
                summary: format!("第 {round} 轮修复成功：编译已通过（引擎: {}）。", result.engine.label()),
                issues_after,
                rolled_back: false,
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
    }
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
    fn hunk_header_parsing() {
        assert_eq!(parse_hunk_header("@@ -12,4 +12,4 @@").unwrap(), (12, 4));
        assert_eq!(parse_hunk_header("@@ -3 +3 @@").unwrap(), (3, 1));
    }
}
