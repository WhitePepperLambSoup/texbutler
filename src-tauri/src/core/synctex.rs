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

    #[test]
    fn parses_system_view_output() {
        let out = "This is SyncTeX command line utility, version 1.5\nSyncTeX result begin\nOutput:main.pdf\nPage:3\nx:123.4\ny:456.7\nh:10\nv:20\nW:300\nH:200\nSyncTeX result end\n";
        assert_eq!(parse_view_output(out), Some(3));
        assert_eq!(parse_view_output("Output:main.pdf\nPage:12\n"), Some(12));
        assert_eq!(parse_view_output("SyncTeX result begin\n"), None);
    }
}
