//! Minimal .docx reader: extracts a structured markdown-ish representation
//! (headings / paragraphs / lists / tables) from `word/document.xml` inside
//! the OOXML zip. No external XML parser — the document.xml layout is
//! regular enough for a small scanner.

use std::io::Read;

/// A parsed docx document as a list of blocks.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Heading { level: u32, text: String },
    Paragraph(String),
    Table(Vec<Vec<String>>),
}

/// Parse a .docx file into blocks.
pub fn parse_docx(path: &std::path::Path) -> Result<Vec<Block>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打开 docx 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("不是有效的 docx: {e}"))?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|_| "docx 中缺少 word/document.xml".to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| e.to_string())?;
    parse_document_xml(&xml)
}

/// Parse `word/document.xml` text into blocks.
pub fn parse_document_xml(xml: &str) -> Result<Vec<Block>, String> {
    let mut blocks = Vec::new();
    let mut pos = 0usize;
    while let Some(tbl_start) = find_tag(xml, pos, "<w:tbl>") {
        // flush paragraphs before the table
        if tbl_start > pos {
            parse_paragraphs(&xml[pos..tbl_start], &mut blocks);
        }
        let Some(tbl_end) = find_tag(xml, tbl_start, "</w:tbl>") else { break };
        blocks.push(parse_table(&xml[tbl_start..tbl_end + "</w:tbl>".len()]));
        pos = tbl_end + "</w:tbl>".len();
    }
    if pos < xml.len() {
        parse_paragraphs(&xml[pos..], &mut blocks);
    }
    Ok(blocks)
}

fn parse_paragraphs(segment: &str, blocks: &mut Vec<Block>) {
    let mut pos = 0usize;
    while let Some(p_start) = find_tag(segment, pos, "<w:p ") {
        let start = p_start + "<w:p ".len();
        let Some(p_end) = find_tag(segment, start, "</w:p>") else { break };
        let p = &segment[start..p_end];
        let text = extract_text(p);
        let level = heading_level(p);
        if text.trim().is_empty() {
            // skip
        } else if level > 0 {
            blocks.push(Block::Heading { level, text: text.trim().to_string() });
        } else {
            blocks.push(Block::Paragraph(text.trim().to_string()));
        }
        pos = p_end + "</w:p>".len();
    }
    // also match `<w:p>` without attributes
    let mut pos2 = 0usize;
    while let Some(p_start) = find_tag(segment, pos2, "<w:p>") {
        let start = p_start + "<w:p>".len();
        let Some(p_end) = find_tag(segment, start, "</w:p>") else { break };
        let p = &segment[start..p_end];
        let text = extract_text(p);
        let level = heading_level(p);
        if !text.trim().is_empty() {
            if level > 0 {
                blocks.push(Block::Heading { level, text: text.trim().to_string() });
            } else {
                blocks.push(Block::Paragraph(text.trim().to_string()));
            }
        }
        pos2 = p_end + "</w:p>".len();
    }
}

fn parse_table(seg: &str) -> Block {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut pos = 0usize;
    while let Some(r_start) = find_tag(seg, pos, "<w:tr ") {
        let start = r_start + "<w:tr ".len();
        let Some(r_end) = find_tag(seg, start, "</w:tr>") else { break };
        let row = &seg[start..r_end];
        let mut cells = Vec::new();
        let mut cpos = 0usize;
        while let Some(c_start) = find_tag(row, cpos, "<w:tc>") {
            let cbody = &row[c_start + "<w:tc>".len()..];
            let Some(c_end) = find_tag(row, c_start, "</w:tc>") else { break };
            let cseg = &row[c_start..c_end];
            let cell_text = extract_text(cseg);
            cells.push(cell_text.trim().to_string());
            cpos = c_end + "</w:tc>".len();
            let _ = cbody;
        }
        if !cells.is_empty() {
            rows.push(cells);
        }
        pos = r_end + "</w:tr>".len();
    }
    // also `<w:tr>` without attrs
    let mut pos2 = 0usize;
    while let Some(r_start) = find_tag(seg, pos2, "<w:tr>") {
        let start = r_start + "<w:tr>".len();
        let Some(r_end) = find_tag(seg, start, "</w:tr>") else { break };
        let row = &seg[start..r_end];
        let mut cells = Vec::new();
        let mut cpos = 0usize;
        while let Some(c_start) = find_tag(row, cpos, "<w:tc>") {
            let Some(c_end) = find_tag(row, c_start, "</w:tc>") else { break };
            let cseg = &row[c_start..c_end];
            let cell_text = extract_text(cseg);
            cells.push(cell_text.trim().to_string());
            cpos = c_end + "</w:tc>".len();
        }
        if !cells.is_empty() {
            rows.push(cells);
        }
        pos2 = r_end + "</w:tr>".len();
    }
    Block::Table(rows)
}

/// Extract the concatenated text of all `<w:t>` runs.
fn extract_text(segment: &str) -> String {
    let mut out = String::new();
    let mut pos = 0usize;
    while let Some(t_start) = find_tag(segment, pos, "<w:t>").or_else(|| find_tag(segment, pos, "<w:t ")) {
        // `<w:t>` or `<w:t xml:space="preserve">`
        let Some(tag_end) = segment[t_start..].find('>') else { break };
        let body_start = t_start + tag_end + 1;
        let Some(t_end) = find_tag(segment, body_start, "</w:t>") else { break };
        out.push_str(&segment[body_start..t_end]);
        pos = t_end + "</w:t>".len();
    }
    out
}

/// Heading level from `w:pStyle w:val="Heading1"` (0 = not a heading).
fn heading_level(p: &str) -> u32 {
    if let Some(idx) = p.find("Heading") {
        let rest = &p[idx + "Heading".len()..];
        if let Some(digit) = rest.chars().next() {
            if let Some(n) = digit.to_digit(10) {
                return n;
            }
        }
    }
    0
}

/// Find the next occurrence of `tag` at or after `from` (byte index).
fn find_tag(s: &str, from: usize, tag: &str) -> Option<usize> {
    if from > s.len() {
        return None;
    }
    s[from..].find(tag).map(|i| from + i)
}

/// Render blocks as markdown-ish text for the AI prompt.
pub fn render_markdown(blocks: &[Block]) -> String {
    let mut out = String::new();
    for b in blocks {
        match b {
            Block::Heading { level, text } => {
                out.push_str(&format!("{} {}\n\n", "#".repeat(*level as usize), text));
            }
            Block::Paragraph(t) => {
                out.push_str(t);
                out.push_str("\n\n");
            }
            Block::Table(rows) => {
                for (i, row) in rows.iter().enumerate() {
                    out.push_str(&format!("| {} |\n", row.join(" | ")));
                    if i == 0 {
                        out.push_str(&format!("| {} |\n", row.iter().map(|_| "---").collect::<Vec<_>>().join(" | ")));
                    }
                }
                out.push('\n');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_headings_paragraphs_and_tables() {
        let xml = r#"<w:document><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题一</w:t></w:r></w:p>
<w:p><w:r><w:t>这是段落。</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>"#;
        let blocks = parse_document_xml(xml).unwrap();
        assert!(blocks.iter().any(|b| matches!(b, Block::Heading { level: 1, text } if text == "标题一")));
        assert!(blocks.iter().any(|b| matches!(b, Block::Paragraph(t) if t == "这是段落。")));
        assert!(blocks.iter().any(|b| matches!(b, Block::Table(rows) if rows.len() == 1 && rows[0] == vec!["A".to_string(), "B".to_string()])));
        let md = render_markdown(&blocks);
        assert!(md.contains("# 标题一"));
        assert!(md.contains("| A | B |"));
    }

    #[test]
    fn roundtrips_a_real_zip_docx() {
        // build a minimal docx zip in memory and parse it back
        let dir = std::env::temp_dir().join(format!("tb-docx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let docx_path = dir.join("test.docx");
        let xml = r#"<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>"#;
        let file = std::fs::File::create(&docx_path).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        zw.start_file("word/document.xml", opts).unwrap();
        zw.write_all(xml.as_bytes()).unwrap();
        zw.finish().unwrap();
        let blocks = parse_docx(&docx_path).unwrap();
        assert!(blocks.iter().any(|b| matches!(b, Block::Paragraph(t) if t == "Hello")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
