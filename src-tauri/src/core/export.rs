//! Lightweight LaTeX → Markdown / DOCX export. No pandoc dependency: a
//! pragmatic converter covering the constructs academic papers actually
//! use (sections, lists, math, tables, refs/cites, inline styling).

/// Convert a LaTeX document to Markdown.
pub fn to_markdown(tex: &str) -> String {
    let mut out = String::new();
    let mut list_stack: Vec<String> = Vec::new(); // "itemize" | "enumerate"
    let mut list_counters: Vec<usize> = Vec::new();
    let mut table_buffer: Vec<String> = Vec::new();
    let mut in_table = false;

    for raw in tex.lines() {
        let line = strip_comment(raw).trim().to_string();
        if line.is_empty() {
            continue;
        }
        // tables: buffer rows until \end{tabular}
        if in_table {
            if line.contains("\\end{tabular}") || line.contains("\\end{tabularx}") {
                out.push_str(&render_table(&table_buffer));
                out.push('\n');
                table_buffer.clear();
                in_table = false;
                continue;
            }
            table_buffer.push(line.clone());
            continue;
        }
        if line.contains("\\begin{tabular}") || line.contains("\\begin{tabularx}") {
            in_table = true;
            table_buffer.push(line.clone());
            continue;
        }
        // environment open/close
        if let Some(env) = env_name(&line, "\\begin{") {
            match env {
                "itemize" | "enumerate" => {
                    list_stack.push(env.to_string());
                    list_counters.push(0);
                }
                "equation" | "align" | "gather" | "displaymath" => {
                    out.push_str("$$\n");
                }
                "abstract" => out.push_str("> "),
                "center" | "figure" | "table" | "document" | "thebibliography" => {}
                _ => {}
            }
            continue;
        }
        if let Some(env) = env_name(&line, "\\end{") {
            match env {
                "itemize" | "enumerate" => {
                    list_stack.pop();
                    list_counters.pop();
                    out.push('\n');
                }
                "equation" | "align" | "gather" | "displaymath" => {
                    out.push_str("$$\n");
                }
                "abstract" => out.push_str("\n"),
                "thebibliography" => out.push_str("\n## References\n"),
                _ => {}
            }
            continue;
        }
        // section headings
        if let Some(title) = cmd_arg(&line, "\\chapter") {
            out.push_str(&format!("# {}\n\n", convert_inline(&title)));
            continue;
        }
        if let Some(title) = cmd_arg(&line, "\\section") {
            out.push_str(&format!("# {}\n\n", convert_inline(&title)));
            continue;
        }
        if let Some(title) = cmd_arg(&line, "\\subsection") {
            out.push_str(&format!("## {}\n\n", convert_inline(&title)));
            continue;
        }
        if let Some(title) = cmd_arg(&line, "\\subsubsection") {
            out.push_str(&format!("### {}\n\n", convert_inline(&title)));
            continue;
        }
        if line.starts_with("\\title{") || line.starts_with("\\author{") || line.starts_with("\\date{") {
            continue;
        }
        // preamble directives: not part of the body
        if line.starts_with("\\documentclass")
            || line.starts_with("\\usepackage")
            || line.starts_with("\\geometry")
            || line.starts_with("\\hypersetup")
            || line.starts_with("\\setCJK")
            || line.starts_with("\\setmainfont")
            || line.starts_with("\\setsansfont")
            || line.starts_with("\\setmonofont")
            || line.starts_with("\\pagestyle")
            || line.starts_with("\\bibliographystyle")
            || line.starts_with("\\graphicspath")
            || line.starts_with("\\addbibresource")
        {
            continue;
        }
        // list items
        if line.starts_with("\\item") {
            let body = line.trim_start_matches("\\item").trim();
            if let Some(list) = list_stack.last() {
                if list == "enumerate" {
                    if let Some(c) = list_counters.last_mut() {
                        *c += 1;
                        out.push_str(&format!("{}. {}\n", c, convert_inline(body)));
                    }
                } else {
                    out.push_str(&format!("- {}\n", convert_inline(body)));
                }
            } else {
                out.push_str(&format!("- {}\n", convert_inline(body)));
            }
            continue;
        }
        // math display
        if line.starts_with("\\[") || line == "$$" {
            out.push_str("$$\n");
            continue;
        }
        if line.starts_with("\\]") || line.contains("\\end{abstract}") {
            out.push_str("$$\n");
            continue;
        }
        // bibliography items
        if line.starts_with("\\bibitem") {
            let key = cmd_arg(&line, "\\bibitem").unwrap_or_default();
            let rest = line
                .find('}')
                .map(|i| line[i + 1..].trim().to_string())
                .unwrap_or_default();
            out.push_str(&format!("- {}. {}\n", key, convert_inline(&rest)));
            continue;
        }
        // plain paragraph
        let text = convert_inline(&line);
        if !text.is_empty() {
            out.push_str(&format!("{}\n\n", text));
        }
    }
    // trailing list close
    if !list_stack.is_empty() {
        out.push('\n');
    }
    out.trim().to_string() + "\n"
}

/// Convert a line with inline commands to Markdown.
fn convert_inline(line: &str) -> String {
    let mut s = line.to_string();
    // inline math first (protect $...$)
    let mut math_buf: Vec<String> = Vec::new();
    let mut i = 0;
    while i <= s.len() {
        let Some(pos) = s[i..].find('$') else { break };
        let abs = i + pos;
        if let Some(end) = s[abs + 1..].find('$') {
            let content = s[abs + 1..abs + 1 + end].to_string();
            math_buf.push(content);
            let placeholder = format!("\u{0}M{}M\u{0}", math_buf.len() - 1);
            s.replace_range(abs..abs + 2 + end, &placeholder);
            i = abs + placeholder.len();
        } else {
            break;
        }
    }
    let chars: Vec<(usize, char)> = s.char_indices().collect();
    let mut out = String::new();
    let mut k = 0usize;
    while k < chars.len() {
        let (_, c) = chars[k];
        if c != '\\' {
            out.push(c);
            k += 1;
            continue;
        }
        // command name: consecutive letters
        let mut j = k + 1;
        while j < chars.len() && (chars[j].1.is_ascii_alphabetic() || chars[j].1 == '@') {
            j += 1;
        }
        let cmd: String = chars[k + 1..j].iter().map(|(_, c)| *c).collect();
        let tail = if j < chars.len() { &s[chars[j].0..] } else { "" }; // substring right after the command name
        if matches!(cmd.as_str(), "textbf" | "textit" | "emph" | "texttt" | "underline" | "bm" | "code" | "itshape") {
            let (open, close) = match cmd.as_str() {
                "textbf" | "bm" => ("**", "**"),
                "textit" | "emph" | "itshape" => ("*", "*"),
                "texttt" | "code" => ("`", "`"),
                _ => ("__", "__"),
            };
            if let Some((content, end)) = wrap_arg(tail) {
                out.push_str(&format!("{open}{}{close}", convert_inline(&content)));
                // advance k past the consumed arg (end is a byte offset into tail)
                let consumed_chars = tail[..end].chars().count();
                k = j + consumed_chars;
                continue;
            }
            k = j;
            continue;
        }
        match cmd.as_str() {
            "ref" | "pageref" | "eqref" => {
                if let Some((arg, end)) = wrap_arg(tail) {
                    out.push_str(&format!("[{}](#{})", arg, arg));
                    let consumed_chars = tail[..end].chars().count();
                    k = j + consumed_chars;
                    continue;
                }
            }
            "cite" | "citep" | "citet" | "parencite" => {
                if let Some((arg, end)) = wrap_arg(tail) {
                    out.push_str(&format!("[{}]", arg));
                    let consumed_chars = tail[..end].chars().count();
                    k = j + consumed_chars;
                    continue;
                }
            }
            "label" => {
                // drop \label{...} entirely: consume its argument
                if let Some((_, end)) = wrap_arg(tail) {
                    let consumed_chars = tail[..end].chars().count();
                    k = j + consumed_chars;
                    continue;
                }
            }
            _ => {
                if j == k + 1 && j < chars.len() {
                    // escape like \% \& \\ — keep the escaped char
                    out.push(chars[j].1);
                    k = j + 1;
                    continue;
                }
            }
        }
        k = j;
    }
    // restore math
    for (idx, m) in math_buf.iter().enumerate() {
        out = out.replace(&format!("\u{0}M{}M\u{0}", idx), &format!("${}$", m));
    }
    out.replace("  ", " ")
}

/// Render a buffered tabular block as a Markdown table.
fn render_table(rows: &[String]) -> String {
    let mut cells: Vec<Vec<String>> = Vec::new();
    let mut align_spec = String::new();
    for line in rows {
        let l = line.trim();
        if l.starts_with("\\begin{tabular") {
            if let Some(spec) = l.split('{').nth(2).map(|s| s.trim_end_matches('}')) {
                align_spec = spec.to_string();
            }
            continue;
        }
        if l.is_empty() || l.starts_with("\\caption") || l.starts_with("\\label") || l.starts_with("\\toprule") || l.starts_with("\\midrule") || l.starts_with("\\bottomrule") || l.starts_with("\\hline") {
            continue;
        }
        let l = l.trim_end_matches("\\\\").trim_end();
        if l.is_empty() {
            continue;
        }
        let row: Vec<String> = l.split('&').map(|c| convert_inline(c.trim())).collect();
        cells.push(row);
    }
    if cells.is_empty() {
        return String::new();
    }
    let cols = cells.iter().map(|r| r.len()).max().unwrap_or(0);
    if cols == 0 {
        return String::new();
    }
    let mut md = String::new();
    md.push_str(&format!("| {} |\n", cells[0].iter().map(|c| c.clone()).collect::<Vec<_>>().join(" | ")));
    md.push_str(&format!("|{}|\n", " --- |".repeat(cols)));
    for row in cells.iter().skip(1) {
        let mut filled = row.clone();
        while filled.len() < cols {
            filled.push(String::new());
        }
        md.push_str(&format!("| {} |\n", filled.join(" | ")));
    }
    let _ = align_spec;
    md
}

fn strip_comment(line: &str) -> String {
    match crate::core::rules::comment_start(line) {
        Some(at) => line[..at].to_string(),
        None => line.to_string(),
    }
}

/// Extract the environment name from `\begin{name}` / `\end{name}` lines.
fn env_name<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(prefix)?;
    let end = rest.find('}')?;
    Some(&rest[..end])
}

/// Extract `{content}` right after the command in `line` (line starts at
/// the command's closing name). Returns (content, byte offset just past the
/// closing brace).
fn wrap_arg(line: &str) -> Option<(String, usize)> {
    let mut rest = line.trim_start();
    let leading = line.len() - rest.len();
    // optional star variant
    if let Some(r) = rest.strip_prefix('*') {
        rest = r.trim_start();
    }
    let open = rest.find('{')?;
    let bytes = rest.as_bytes();
    let mut depth = 1usize;
    let mut i = open + 1;
    while i < bytes.len() && depth > 0 {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    if depth != 0 {
        return None;
    }
    // i already counts from the start of `rest` (open+1 → past the closing
    // brace), so the byte offset into `line` is just leading + i; adding
    // `open` again would over-count for optional args like \cite[p. 5]{k}
    Some((rest[open + 1..i - 1].to_string(), leading + i))
}

/// Extract `{arg}` right after `cmd` (command name not included).
fn cmd_arg(line: &str, cmd: &str) -> Option<String> {
    // line already starts at or after the command; find the first `{...}`
    let rest = line.strip_prefix(cmd).or_else(|| line.find(cmd).map(|i| &line[i + cmd.len()..]))?;
    let mut rest = rest.trim_start();
    // optional star variant (\section*{...})
    if let Some(r) = rest.strip_prefix('*') {
        rest = r.trim_start();
    }
    let open = rest.find('{')?;
    let mut depth = 1;
    let bytes = rest.as_bytes();
    let mut i = open + 1;
    while i < bytes.len() && depth > 0 {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    if depth == 0 {
        Some(rest[open + 1..i - 1].to_string())
    } else {
        None
    }
}

/// Minimal DOCX writer: headings, paragraphs and Markdown-style tables.
/// Produces a valid .docx (Office Open XML) with a single section.
pub fn to_docx(md: &str) -> Result<Vec<u8>, String> {
    let mut document = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"#,
    );
    let lines: Vec<&str> = md.lines().collect();
    let mut i = 0usize;
    while i < lines.len() {
        let l = lines[i].trim_end();
        if l.is_empty() {
            i += 1;
            continue;
        }
        if let Some(h) = l.strip_prefix("# ") {
            push_heading(&mut document, h, 1);
        } else if let Some(h) = l.strip_prefix("## ") {
            push_heading(&mut document, h, 2);
        } else if let Some(h) = l.strip_prefix("### ") {
            push_heading(&mut document, h, 3);
        } else if l.starts_with('|') {
            let mut rows: Vec<Vec<String>> = Vec::new();
            while i < lines.len() && lines[i].trim().starts_with('|') {
                let cells: Vec<String> = lines[i]
                    .trim()
                    .trim_matches('|')
                    .split('|')
                    .map(|c| escape_xml(c.trim()))
                    .collect();
                // skip the Markdown header separator row (| --- | --- |)
                let is_separator = cells.iter().all(|c| {
                    let t = c.trim_matches(' ').trim_matches(':');
                    !t.is_empty() && t.chars().all(|ch| ch == '-')
                });
                if !is_separator {
                    rows.push(cells);
                }
                i += 1;
            }
            push_table(&mut document, &rows);
            continue;
        } else {
            push_paragraph(&mut document, l);
        }
        i += 1;
    }
    document.push_str("</w:body></w:document>");

    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;
    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("[Content_Types].xml", opts).map_err(|e| e.to_string())?;
    zip.write_all(content_types.as_bytes()).map_err(|e| e.to_string())?;
    zip.start_file("_rels/.rels", opts).map_err(|e| e.to_string())?;
    zip.write_all(rels.as_bytes()).map_err(|e| e.to_string())?;
    zip.start_file("word/document.xml", opts).map_err(|e| e.to_string())?;
    zip.write_all(document.as_bytes()).map_err(|e| e.to_string())?;
    let cursor = zip.finish().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn push_heading(doc: &mut String, text: &str, level: u32) {
    doc.push_str(&format!(
        r#"<w:p><w:pPr><w:pStyle w:val="Heading{}"/></w:pPr><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
        level,
        escape_xml(text)
    ));
}

fn push_paragraph(doc: &mut String, text: &str) {
    doc.push_str(&format!(
        r#"<w:p><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
        escape_xml(text)
    ));
}

fn push_table(doc: &mut String, rows: &[Vec<String>]) {
    doc.push_str("<w:tbl><w:tblPr><w:tblBorders>");
    doc.push_str("<w:top w:val=\"single\" w:sz=\"4\"/><w:left w:val=\"single\" w:sz=\"4\"/><w:bottom w:val=\"single\" w:sz=\"4\"/><w:right w:val=\"single\" w:sz=\"4\"/><w:insideH w:val=\"single\" w:sz=\"4\"/><w:insideV w:val=\"single\" w:sz=\"4\"/>");
    doc.push_str("</w:tblBorders></w:tblPr>");
    for row in rows {
        doc.push_str("<w:tr>");
        for cell in row {
            doc.push_str(&format!(
                r#"<w:tc><w:tcPr><w:tcW w:w="{}" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p></w:tc>"#,
                2000,
                cell
            ));
        }
        doc.push_str("</w:tr>");
    }
    doc.push_str("</w:tbl>");
}

use std::io::Write;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_sections_and_items() {
        let tex = "\\section{引言}\n这是正文。\n\\begin{itemize}\n\\item 第一点\n\\item 第二点\n\\end{itemize}\n";
        let md = to_markdown(tex);
        assert!(md.contains("# 引言"));
        assert!(md.contains("- 第一点"));
        assert!(md.contains("- 第二点"));
        assert!(md.contains("这是正文。"));
    }

    #[test]
    fn converts_math_and_refs() {
        let tex = "公式 $E = mc^2$ 见 \\ref{eq:1}。\n\\begin{equation}\na^2 + b^2 = c^2\n\\end{equation}\n";
        let md = to_markdown(tex);
        assert!(md.contains("$E = mc^2$"));
        assert!(md.contains("$$"));
        assert!(md.contains("[eq:1](#eq:1)"));
    }

    #[test]
    fn converts_tabular_to_md_table() {
        let tex = "\\begin{tabular}{lcr}\nA & B & C \\\\\n1 & 2 & 3 \\\\\n\\end{tabular}\n";
        let md = to_markdown(tex);
        assert!(md.contains("| A | B | C |"));
        assert!(md.contains("| 1 | 2 | 3 |"));
        assert!(md.contains("---"));
    }

    #[test]
    fn strips_comments_and_labels() {
        let tex = "正文 % 注释\n\\label{sec:1}\n更多正文。\n";
        let md = to_markdown(tex);
        assert!(!md.contains("注释"));
        assert!(!md.contains("\\label"));
        assert!(md.contains("更多正文"));
    }

    #[test]
    fn skips_preamble_directives() {
        let tex = "\\documentclass[11pt]{ctexart}\n\\usepackage{geometry}\n\\geometry{a4paper}\n\\hypersetup{colorlinks=true}\n\\begin{document}\n正文。\n\\end{document}\n";
        let md = to_markdown(tex);
        assert!(!md.contains("ctexart"));
        assert!(!md.contains("usepackage"));
        assert!(!md.contains("geometry"));
        assert!(md.contains("正文"));
    }

    #[test]
    fn docx_skips_markdown_separator_row() {
        // regression: the | --- | --- | separator row used to appear as a
        // data row inside the DOCX table
        let md = "# 标题\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
        let docx = to_docx(md).expect("docx should build");
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(docx)).expect("valid zip");
        let mut xml = String::new();
        use std::io::Read;
        zip.by_name("word/document.xml")
            .expect("document.xml")
            .read_to_string(&mut xml)
            .unwrap();
        assert!(!xml.contains("---"), "separator row must not be written");
        assert!(xml.contains("<w:t xml:space=\"preserve\">A</w:t>"));
        assert!(xml.contains("<w:t xml:space=\"preserve\">2</w:t>"));
    }

    #[test]
    fn docx_roundtrip_is_valid_zip() {
        let md = "# 标题\n\n正文段落。\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
        let docx = to_docx(md).expect("docx should build");
        assert!(docx.len() > 500);
        // starts with the PK zip magic
        assert_eq!(&docx[..2], b"PK");
        // can be opened as a zip
        let reader = std::io::Cursor::new(docx);
        let mut zip = zip::ZipArchive::new(reader).expect("valid zip");
        assert!(zip.by_name("word/document.xml").is_ok());
        assert!(zip.by_name("[Content_Types].xml").is_ok());
    }

    #[test]
    fn inline_styling_converts() {
        let tex = "\\textbf{加粗} 与 \\textit{斜体} 和 \\texttt{代码}。\n";
        let md = to_markdown(tex);
        assert!(md.contains("**加粗**"));
        assert!(md.contains("*斜体*"));
        assert!(md.contains("`代码`"));
    }

    #[test]
    fn spaced_command_argument_keeps_position() {
        // `\textbf {x}` (space before the brace) must render and not
        // desync the cursor (offset bug)
        let tex = "前文\\textbf {加粗}后文。\n";
        let md = to_markdown(tex);
        assert!(md.contains("前文**加粗**后文"), "got: {md}");
    }

    #[test]
    fn optional_cite_argument_does_not_panic() {
        // \cite[p. 5]{key} — legal LaTeX optional arg; the offset math
        // must not over-count `open` (panic before the fix)
        let tex = "详见 \\cite[p. 5]{knuth84} 的讨论。\n";
        let md = to_markdown(tex);
        assert!(md.contains("[knuth84]"), "got: {md}");
    }

    #[test]
    fn trailing_backslash_does_not_panic() {
        // a lone `\` at the end of a line must not panic (bounds bug)
        let tex = "文本以反斜杠结尾\\\n下一行。\n";
        let md = to_markdown(tex);
        assert!(md.contains("下一行"));
    }

    #[test]
    fn command_at_line_end_does_not_panic() {
        let tex = "\\textbf{加粗}\n\\texttt{code}\n";
        let md = to_markdown(tex);
        assert!(md.contains("**加粗**"));
        assert!(md.contains("`code`"));
    }
}
