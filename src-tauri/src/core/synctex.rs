//! Minimal SyncTeX forward-search: parse the gzipped `.synctex.gz` that
//! tectonic / xelatex produce with `--synctex`, map a source (file, line)
//! to the PDF page that contains it. Backward search (PDF click) is out of
//! scope (WebView2's PDFium viewer has no click callback).

use std::io::Read;

/// Find the PDF page containing `line` of `tex_rel` inside a gzipped
/// synctex file. Returns 1-based page number.
pub fn forward_search(synctex_gz: &[u8], tex_rel: &str, line: usize) -> Option<u32> {
    let mut raw = Vec::new();
    let mut dec = flate2::read::GzDecoder::new(synctex_gz);
    dec.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    forward_search_from_text(&text, tex_rel, line)
}

/// Use the system `synctex` CLI (shipped with MiKTeX / TeX Live) for the
/// compact SyncTeX v1 format that newer engines produce. Runs
/// `synctex view -i <line>:0:<tex_rel> -o <pdf>` and parses the `Page:N`
/// line from its output.
pub fn system_forward(synctex_bin: &str, pdf: &std::path::Path, tex_rel: &str, line: usize) -> Option<u32> {
    let out = std::process::Command::new(synctex_bin)
        .args(["view", "-i", &format!("{line}:0:{tex_rel}"), "-o"])
        .arg(pdf)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for l in text.lines() {
        let t = l.trim();
        if let Some(rest) = t.strip_prefix("Page:") {
            if let Ok(n) = rest.trim().parse::<u32>() {
                return Some(n);
            }
        }
    }
    None
}

/// A location in the PDF (big points, origin top-left, y downwards).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct PdfPos {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A location in the sources.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SourcePos {
    /// As recorded by the engine (usually absolute).
    pub file: String,
    pub line: usize,
}

fn run_synctex(synctex_bin: &str, args: &[String]) -> Option<String> {
    let mut cmd = std::process::Command::new(synctex_bin);
    cmd.args(args);
    crate::core::compiler::hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// `synctex view` with the full position of the first result.
pub fn system_forward_pos(synctex_bin: &str, pdf: &std::path::Path, tex: &str, line: usize) -> Option<PdfPos> {
    let text = run_synctex(
        synctex_bin,
        &["view".into(), "-i".into(), format!("{line}:0:{tex}"), "-o".into(), pdf.to_string_lossy().to_string()],
    )?;
    parse_view_output_pos(&text)
}

/// Parse the first record of `synctex view` output (Page/x/y/W/H).
pub fn parse_view_output_pos(text: &str) -> Option<PdfPos> {
    let mut page = None;
    let (mut x, mut y, mut w, mut h) = (0.0, 0.0, 0.0, 0.0);
    for l in text.lines() {
        let t = l.trim();
        let field = |key: &str| t.strip_prefix(key).and_then(|v| v.trim().parse::<f64>().ok());
        if let Some(rest) = t.strip_prefix("Page:") {
            if page.is_some() {
                break; // only the first result block
            }
            page = rest.trim().parse::<u32>().ok();
        } else if let Some(v) = field("x:") {
            x = v;
        } else if let Some(v) = field("y:") {
            y = v;
        } else if let Some(v) = field("W:") {
            w = v;
        } else if let Some(v) = field("H:") {
            h = v;
        }
    }
    page.map(|page| PdfPos { page, x, y, w, h })
}

/// `synctex edit` (reverse search): PDF point → source file + line.
pub fn system_reverse(synctex_bin: &str, pdf: &std::path::Path, page: u32, x: f64, y: f64) -> Option<SourcePos> {
    let text = run_synctex(
        synctex_bin,
        &["edit".into(), "-o".into(), format!("{page}:{x:.2}:{y:.2}:{}", pdf.to_string_lossy())],
    )?;
    parse_edit_output(&text)
}

pub fn parse_edit_output(text: &str) -> Option<SourcePos> {
    let mut file = None;
    let mut line = None;
    for l in text.lines() {
        let t = l.trim();
        if let Some(v) = t.strip_prefix("Input:") {
            if file.is_some() {
                break;
            }
            file = Some(v.trim().to_string());
        } else if let Some(v) = t.strip_prefix("Line:") {
            line = v.trim().parse::<usize>().ok();
        }
    }
    match (file, line) {
        (Some(file), Some(line)) if line > 0 => Some(SourcePos { file, line }),
        _ => None,
    }
}

/// Built-in reverse search over an uncompressed SyncTeX file (standard
/// format: `{page` … `}page`, records `type tag,line:x,y[:W,H,D]` in scaled
/// points). Used when no `synctex` CLI is installed (Tectonic-only setups).
pub fn reverse_search_from_text(text: &str, page: u32, x_bp: f64, y_bp: f64) -> Option<SourcePos> {
    let mut inputs: std::collections::HashMap<u32, String> = std::collections::HashMap::new();
    let (mut unit, mut mag, mut x_off, mut y_off) = (1.0f64, 1000.0f64, 0.0f64, 0.0f64);
    let mut current_page: Option<u32> = None;
    // best = (score, tag, line)
    let mut best: Option<(f64, u32, usize)> = None;
    for raw in text.lines() {
        let t = raw.trim_end();
        if let Some(rest) = t.strip_prefix("Input:") {
            if let Some((tag, path)) = rest.split_once(':') {
                if let Ok(tag) = tag.parse::<u32>() {
                    inputs.insert(tag, path.to_string());
                }
            }
            continue;
        }
        if let Some(v) = t.strip_prefix("Unit:") {
            unit = v.trim().parse().unwrap_or(1.0);
            continue;
        }
        if let Some(v) = t.strip_prefix("Magnification:") {
            mag = v.trim().parse().unwrap_or(1000.0);
            continue;
        }
        if let Some(v) = t.strip_prefix("X Offset:") {
            x_off = v.trim().parse().unwrap_or(0.0);
            continue;
        }
        if let Some(v) = t.strip_prefix("Y Offset:") {
            y_off = v.trim().parse().unwrap_or(0.0);
            continue;
        }
        if let Some(n) = t.strip_prefix('{') {
            current_page = n.parse().ok();
            continue;
        }
        if t.starts_with('}') {
            current_page = None;
            continue;
        }
        if current_page != Some(page) {
            continue;
        }
        let Some(kind) = t.chars().next() else { continue };
        if !matches!(kind, '(' | '[' | 'h' | 'v' | 'k' | 'g' | '$' | 'x') {
            continue;
        }
        // tag,line:x,y[:W,H,D]
        let body = &t[1..];
        let mut parts = body.split(':');
        let (Some(tl), Some(xy)) = (parts.next(), parts.next()) else { continue };
        let Some((tag, line)) = tl.split_once(',') else { continue };
        let Some((xs, ys)) = xy.split_once(',') else { continue };
        let (Ok(tag), Ok(line), Ok(xs), Ok(ys)) = (tag.parse::<u32>(), line.parse::<usize>(), xs.parse::<f64>(), ys.parse::<f64>()) else {
            continue;
        };
        if line == 0 {
            continue;
        }
        let whd: Vec<f64> = parts.next().map(|s| s.split(',').filter_map(|n| n.parse().ok()).collect()).unwrap_or_default();
        let scale = unit * mag / 1000.0 / 65536.0 * 72.0 / 72.27;
        let bx = xs * scale + x_off * scale;
        let by = ys * scale + y_off * scale;
        let (w, h, d) = (
            whd.first().copied().unwrap_or(0.0) * scale,
            whd.get(1).copied().unwrap_or(0.0) * scale,
            whd.get(2).copied().unwrap_or(0.0) * scale,
        );
        // vertical distance to the box [by - h, by + d] (0 when inside);
        // horizontal distance only matters among lines at the same height
        let dy = if y_bp < by - h { by - h - y_bp } else if y_bp > by + d { y_bp - by - d } else { 0.0 };
        let dx = if w > 0.0 {
            if x_bp < bx { bx - x_bp } else if x_bp > bx + w { x_bp - bx - w } else { 0.0 }
        } else {
            (x_bp - bx).abs()
        };
        // vertical boxes (`[`) span many lines: only use them as a last resort
        let penalty = if kind == '[' || kind == 'v' { 1000.0 } else { 0.0 };
        let score = dy * 10.0 + dx * 0.1 + penalty;
        if best.map_or(true, |(s, _, _)| score < s) {
            best = Some((score, tag, line));
        }
    }
    let (_, tag, line) = best?;
    Some(SourcePos { file: inputs.get(&tag)?.clone(), line })
}

/// Gzip variant of `reverse_search_from_text`.
pub fn reverse_search(synctex_gz: &[u8], page: u32, x_bp: f64, y_bp: f64) -> Option<SourcePos> {
    let mut raw = Vec::new();
    let mut dec = flate2::read::GzDecoder::new(synctex_gz);
    dec.read_to_end(&mut raw).ok()?;
    reverse_search_from_text(&String::from_utf8_lossy(&raw), page, x_bp, y_bp)
}

/// Parse a `synctex view` output dump (used by tests).
pub fn parse_view_output(text: &str) -> Option<u32> {
    for l in text.lines() {
        let t = l.trim();
        if let Some(rest) = t.strip_prefix("Page:") {
            if let Ok(n) = rest.trim().parse::<u32>() {
                return Some(n);
            }
        }
    }
    None
}

/// Text (uncompressed) variant, directly testable.
pub fn forward_search_from_text(text: &str, tex_rel: &str, line: usize) -> Option<u32> {
    let needle_full = tex_rel.replace('\\', "/");
    let needle_base = needle_full
        .rsplit('/')
        .next()
        .unwrap_or(&needle_full)
        .to_string();
    let mut current_page: Option<u32> = None;
    for raw_line in text.lines() {
        let t = raw_line.trim();
        if t.starts_with("(Page:") {
            // (Page:3 [2,2,0] 0:0
            current_page = t
                .strip_prefix("(Page:")
                .and_then(|r| r.split(|c: char| !c.is_ascii_digit()).next())
                .and_then(|n| n.parse::<u32>().ok());
            continue;
        }
        if t.starts_with("(Input:") && current_page.is_some() {
            // (Input:1:./chapters/intro.tex:12:0  or  (Input:./main.tex:3:0
            let body = t
                .trim_start_matches("(Input:")
                .trim_end_matches(')');
            let parts: Vec<&str> = body.split(':').collect();
            if parts.len() < 3 {
                continue;
            }
            let line_no = match parts[parts.len() - 2].parse::<usize>() {
                Ok(n) => n,
                Err(_) => continue, // malformed Input line: skip, keep scanning
            };
            // path = everything before the last two numeric fields; a leading
            // "1:" block number may be present (newer synctex) — strip it
            let mut path = parts[..parts.len() - 2].join(":");
            if let Some(stripped) = path.strip_prefix(|c: char| c.is_ascii_digit()) {
                if stripped.starts_with(':') {
                    path = stripped[1..].to_string();
                }
            }
            let path_norm = path.replace('\\', "/");
            if line_no == line
                && (path_norm.ends_with(&needle_full) || path_norm.ends_with(&needle_base))
            {
                return current_page;
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"SyncTeX Version:1
!0
(Page:1 [1,1,0] 0:0
(Input:./main.tex:1:0
(300,600
!5
(Input:./main.tex:2:0
(300,700
!10
(Page:2 [2,1,0] 0:0
(Input:./chapters/intro.tex:1:0
(400,800
!15
(Input:./chapters/intro.tex:12:0
(400,900
"#;

    #[test]
    fn finds_page_for_line_in_main() {
        assert_eq!(forward_search_from_text(SAMPLE, "main.tex", 2), Some(1));
        assert_eq!(forward_search_from_text(SAMPLE, "main.tex", 1), Some(1));
    }

    #[test]
    fn finds_page_across_inputs() {
        assert_eq!(forward_search_from_text(SAMPLE, "chapters/intro.tex", 12), Some(2));
        assert_eq!(forward_search_from_text(SAMPLE, "chapters/intro.tex", 1), Some(2));
    }

    #[test]
    fn missing_line_returns_none() {
        assert_eq!(forward_search_from_text(SAMPLE, "main.tex", 99), None);
        assert_eq!(forward_search_from_text(SAMPLE, "ghost.tex", 1), None);
    }

    #[test]
    fn tolerates_block_number_prefix() {
        let s = "SyncTeX Version:1\n(Page:1 [1,1,0] 0:0\n(Input:1:./a.tex:5:0\n(10,20\n";
        assert_eq!(forward_search_from_text(s, "a.tex", 5), Some(1));
    }

    #[test]
    fn windows_paths_are_normalized() {
        assert_eq!(forward_search_from_text(SAMPLE, "chapters\\intro.tex", 12), Some(2));
    }

    #[test]
    fn gzip_roundtrip_works() {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(SAMPLE.as_bytes()).unwrap();
        let gz = enc.finish().unwrap();
        assert_eq!(forward_search(&gz, "chapters/intro.tex", 12), Some(2));
    }

    // standard (pdfTeX/XeTeX/Tectonic) layout: 1in = 4736286 sp
    const STANDARD: &str = "SyncTeX Version:1
Input:1:/proj/main.tex
Input:2:/proj/chapters/intro.tex
Output:pdf
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
!100
{1
[1,6:4736286,48038426:30689974,43301940,0
(2,1:4736286,6029312:30689974,655360,0
h2,1:4736286,6029312:20000000,655360,0
)
(1,9:4736286,9000000:30689974,655360,0
h1,9:4736286,9000000:20000000,655360,0
)
]
}1
{2
(1,22:4736286,6029312:30689974,655360,0
}2
";

    fn sp_to_bp(sp: f64) -> f64 {
        sp / 65536.0 * 72.0 / 72.27
    }

    #[test]
    fn reverse_search_picks_the_line_under_the_point() {
        // a point on the first text line of page 1 → intro.tex:1
        let hit = reverse_search_from_text(STANDARD, 1, sp_to_bp(6_000_000.0), sp_to_bp(6_000_000.0)).unwrap();
        assert_eq!(hit, SourcePos { file: "/proj/chapters/intro.tex".into(), line: 1 });
        // a point on the second line → main.tex:9 (not the enclosing vbox line 6)
        let hit = reverse_search_from_text(STANDARD, 1, sp_to_bp(6_000_000.0), sp_to_bp(8_900_000.0)).unwrap();
        assert_eq!(hit, SourcePos { file: "/proj/main.tex".into(), line: 9 });
        // page filtering
        let hit = reverse_search_from_text(STANDARD, 2, 100.0, sp_to_bp(6_000_000.0)).unwrap();
        assert_eq!(hit.line, 22);
        assert!(reverse_search_from_text(STANDARD, 7, 100.0, 100.0).is_none());
    }

    #[test]
    fn parses_system_edit_and_view_positions() {
        let edit = "This is SyncTeX command line utility, version 1.5\nSyncTeX result begin\nOutput:C:/p/main.pdf\nInput:C:/p/chapters/intro.tex\nLine:12\nColumn:-1\nOffset:0\nContext:\nSyncTeX result end\n";
        assert_eq!(parse_edit_output(edit), Some(SourcePos { file: "C:/p/chapters/intro.tex".into(), line: 12 }));
        assert_eq!(parse_edit_output("SyncTeX result begin\nSyncTeX result end\n"), None);
        let view = "SyncTeX result begin\nOutput:main.pdf\nPage:3\nx:123.4\ny:456.7\nh:100.0\nv:460.0\nW:300.5\nH:10.0\nbefore:\noffset:0\nmiddle:\nafter:\nOutput:main.pdf\nPage:4\nx:1\ny:2\nSyncTeX result end\n";
        assert_eq!(parse_view_output_pos(view), Some(PdfPos { page: 3, x: 123.4, y: 456.7, w: 300.5, h: 10.0 }));
    }

    #[test]
    fn parses_system_view_output() {
        let out = "This is SyncTeX command line utility, version 1.5\nSyncTeX result begin\nOutput:main.pdf\nPage:3\nx:123.4\ny:456.7\nh:10\nv:20\nW:300\nH:200\nSyncTeX result end\n";
        assert_eq!(parse_view_output(out), Some(3));
        assert_eq!(parse_view_output("Output:main.pdf\nPage:12\n"), Some(12));
        assert_eq!(parse_view_output("SyncTeX result begin\n"), None);
    }
}
