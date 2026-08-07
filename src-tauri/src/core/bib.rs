//! Minimal `.bib` parser shared by the reference panel, the dangling-cite
//! rule and the ref/cite autocompletion. Extracted from the old inline
//! implementation in `commands/project.rs`.

/// A parsed `.bib` entry.
#[derive(serde::Serialize, Clone, Debug)]
pub struct BibEntry {
    pub key: String,
    pub entry_type: String,
    pub title: String,
    pub author: String,
    pub year: String,
    /// Where the entry lives inside its .bib file (Ctrl+Click navigation);
    /// filled by `tb_ref_index`, None for entries without a location.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
}

/// Parse `@type{key, field = {value}, ...}` blocks from a .bib source.
pub fn parse_bib(content: &str) -> Vec<BibEntry> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(at) = rest.find('@') {
        let after = &rest[at + 1..];
        // skip comments like @comment{...}
        if after.trim_start().to_ascii_lowercase().starts_with("comment") {
            if let Some(close) = after.find('}') {
                rest = &after[close + 1..];
                continue;
            }
            break;
        }
        // entry type
        let Some(type_end) = after.find('{') else { break };
        let entry_type = after[..type_end].trim().to_string();
        let body_start = type_end + 1;
        // find the matching closing brace (first `}` at depth 0)
        let mut depth = 1usize;
        let mut end = body_start;
        let bytes = after.as_bytes();
        while end < bytes.len() && depth > 0 {
            match bytes[end] {
                b'{' => depth += 1,
                b'}' => depth -= 1,
                _ => {}
            }
            end += 1;
        }
        if depth != 0 {
            break;
        }
        let body = &after[body_start..end - 1];
        // skip @comment / @string / @preamble pseudo-entries
        let low_type = entry_type.to_ascii_lowercase();
        if !matches!(low_type.as_str(), "comment" | "string" | "preamble") {
            let key = body.split(',').next().unwrap_or("").trim().to_string();
            if !key.is_empty() {
                out.push(BibEntry {
                    key,
                    entry_type,
                    title: extract_bib_field(body, "title"),
                    author: extract_bib_field(body, "author"),
                    year: extract_bib_field(body, "year"),
                    file: None,
                    line: None,
                });
            }
        }
        rest = &after[end..];
    }
    out
}

/// Extract `name = {value}` (or `name = "value"`) from a bib entry body.
/// The field name must not be preceded by an alphanumeric (so `title` does
/// not match inside `subtitle`).
pub fn extract_bib_field(body: &str, name: &str) -> String {
    let mut rest = body;
    while !rest.is_empty() {
        // locate `name` at a field boundary (previous char not alphanumeric)
        let mut idx = None;
        let mut probe = rest;
        let mut base = 0;
        while let Some(i) = probe.find(name) {
            let prev = probe[..i].chars().next_back();
            let ok = prev.map(|c| !c.is_ascii_alphanumeric()).unwrap_or(true);
            if ok {
                idx = Some(base + i);
                break;
            }
            probe = &probe[i + name.len()..];
            base += i + name.len();
        }
        let Some(idx) = idx else { break };
        let after = &rest[idx + name.len()..];
        // the field name must be followed by `=` (whitespace allowed)
        let after_eq = after.trim_start();
        let Some(eq) = after_eq.find('=') else { break };
        let value = after_eq[eq + 1..].trim_start();
        let v = if let Some(v) = value.strip_prefix('{') {
            // match the closing brace at depth 0 (nested braces allowed)
            let mut depth = 1usize;
            let bytes = v.as_bytes();
            let mut end = 0;
            while end < bytes.len() && depth > 0 {
                match bytes[end] {
                    b'{' => depth += 1,
                    b'}' => depth -= 1,
                    _ => {}
                }
                end += 1;
            }
            let end = if depth == 0 { end - 1 } else { v.len() };
            v[..end].trim().to_string()
        } else if let Some(v) = value.strip_prefix('"') {
            let end = v.find('"').unwrap_or(v.len());
            v[..end].trim().to_string()
        } else {
            let end = value.find(|c: char| c == ',' || c == '\n').unwrap_or(value.len());
            value[..end].trim().to_string()
        };
        if !v.is_empty() {
            return v;
        }
        rest = after;
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_bib_entry() {
        let src = "@article{knuth84,\n  title = {The Art of Computer Programming},\n  author = {Knuth, Donald},\n  year = {1984}\n}\n";
        let entries = parse_bib(src);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "knuth84");
        assert_eq!(entries[0].entry_type, "article");
        assert_eq!(entries[0].title, "The Art of Computer Programming");
        assert_eq!(entries[0].author, "Knuth, Donald");
        assert_eq!(entries[0].year, "1984");
    }

    #[test]
    fn skips_string_and_preamble_entries() {
        let src = "@string{foo = \"bar\"}\n@preamble{\"x\"}\n@book{key1, title = {T}}\n";
        let entries = parse_bib(src);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "key1");
    }

    #[test]
    fn handles_string_quoted_fields_and_nested_braces() {
        let src = "@article{nested2023,\n  title = {Nested {Braces} Inside},\n  author = \"Doe, Jane\",\n  year = {2023}\n}\n";
        let entries = parse_bib(src);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Nested {Braces} Inside");
        assert_eq!(entries[0].author, "Doe, Jane");
        assert_eq!(entries[0].year, "2023");
    }

    #[test]
    fn parses_multiple_entries_and_skips_comments() {
        let src = "@comment{not an entry}\n@article{a1, title = {One}}\n@article{a2, title = {Two}}\n";
        let entries = parse_bib(src);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, "a1");
        assert_eq!(entries[1].key, "a2");
    }
}
