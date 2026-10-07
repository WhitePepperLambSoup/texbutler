//! Zotero integration through the Better BibTeX JSON-RPC endpoint
//! (`http://127.0.0.1:23119/better-bibtex/json-rpc`): search the library,
//! then insert citations and append the missing BibTeX entries to the
//! project's `.bib`. Only loopback addresses are contacted.

use crate::commands::project::emit_project_changed;
use crate::state::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

pub const DEFAULT_URL: &str = "http://127.0.0.1:23119";
const TRANSLATOR: &str = "Better BibTeX";

/// Validate the (user-configurable) Zotero address: http on loopback only.
pub fn base_url(url: Option<&str>) -> Result<String, String> {
    let raw = url.map(str::trim).filter(|u| !u.is_empty()).unwrap_or(DEFAULT_URL).trim_end_matches('/');
    let rest = raw.strip_prefix("http://").ok_or("Zotero 地址必须以 http:// 开头")?;
    let host = rest.split(['/', ':']).next().unwrap_or("");
    if !matches!(host, "127.0.0.1" | "localhost") {
        return Err("出于安全考虑，只能连接本机的 Zotero（127.0.0.1 / localhost）".into());
    }
    Ok(raw.to_string())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .no_proxy()
        .build()
        .unwrap_or_default()
}

/// One JSON-RPC call; maps transport failures to actionable messages.
async fn rpc(base: &str, method: &str, params: Value) -> Result<Value, String> {
    let resp = client()
        .post(format!("{base}/better-bibtex/json-rpc"))
        .header("Accept", "application/json")
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "未检测到 Zotero：请先启动 Zotero（需要安装 Better BibTeX 插件）".to_string()
            } else {
                format!("连接 Zotero 失败: {e}")
            }
        })?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("已连接 Zotero，但没有安装 Better BibTeX 插件（https://retorque.re/zotero-better-bibtex/）".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Zotero 返回错误：HTTP {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("Zotero 响应无法解析: {e}"))?;
    if let Some(err) = body.get("error") {
        let msg = err.get("message").and_then(Value::as_str).unwrap_or("未知错误");
        return Err(format!("Zotero：{msg}"));
    }
    Ok(body.get("result").cloned().unwrap_or(Value::Null))
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ZoteroStatus {
    pub zotero: String,
    pub betterbibtex: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ZoteroItem {
    pub citekey: String,
    pub title: String,
    pub authors: String,
    pub year: String,
    pub container: String,
    pub item_type: String,
    pub library: String,
    /// Already present in one of the project's `.bib` files.
    pub in_project: bool,
}

/// Map one CSL-JSON search result (plus BBT's `citekey`) to an item.
pub fn item_from_csl(v: &Value) -> Option<ZoteroItem> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let citekey = v.get("citekey").or_else(|| v.get("citationKey")).and_then(Value::as_str).unwrap_or("").to_string();
    if citekey.is_empty() {
        return None;
    }
    let names: Vec<String> = v
        .get("author")
        .or_else(|| v.get("editor"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    let family = a.get("family").and_then(Value::as_str).unwrap_or("");
                    let given = a.get("given").and_then(Value::as_str).unwrap_or("");
                    let literal = a.get("literal").and_then(Value::as_str).unwrap_or("");
                    let n = if !literal.is_empty() {
                        literal.to_string()
                    } else if crate::core::rules::contains_cjk(family) {
                        format!("{family}{given}")
                    } else {
                        format!("{given} {family}").trim().to_string()
                    };
                    (!n.is_empty()).then_some(n)
                })
                .collect()
        })
        .unwrap_or_default();
    let authors = match names.len() {
        0 => String::new(),
        1..=3 => names.join(", "),
        _ => format!("{} et al.", names[..3].join(", ")),
    };
    let year = v
        .get("issued")
        .and_then(|i| i.get("date-parts"))
        .and_then(|d| d.get(0))
        .and_then(|d| d.get(0))
        .map(|y| match y {
            Value::Number(n) => n.to_string(),
            Value::String(s) => s.clone(),
            _ => String::new(),
        })
        .unwrap_or_default();
    Some(ZoteroItem {
        citekey,
        title: s("title"),
        authors,
        year,
        container: s("container-title"),
        item_type: s("type"),
        library: s("library"),
        in_project: false,
    })
}

/// `item.export` returns a string (BBT ≥ 6.7.143) or, in older versions, a
/// wrapped array whose last string element is the export body.
pub fn export_body(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => items.iter().rev().find_map(|i| i.as_str().map(str::to_string)),
        _ => None,
    }
}

fn project_bib_keys(proj: &crate::core::project::Project) -> Vec<String> {
    let mut keys = Vec::new();
    for rel in proj.bib_files() {
        if let Ok(content) = proj.read_file(&rel) {
            keys.extend(crate::core::bib::parse_bib(&content).into_iter().map(|e| e.key));
        }
    }
    keys
}

fn current_project(state: &State<'_, AppState>) -> Result<crate::core::project::Project, String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    guard.as_ref().cloned().ok_or_else(|| "尚未打开项目".to_string())
}

/// Is Zotero + Better BibTeX reachable? Returns their versions.
#[tauri::command]
pub async fn tb_zotero_status(url: Option<String>) -> Result<ZoteroStatus, String> {
    let base = base_url(url.as_deref())?;
    let r = rpc(&base, "api.ready", json!([])).await?;
    Ok(ZoteroStatus {
        zotero: r.get("zotero").and_then(Value::as_str).unwrap_or("?").to_string(),
        betterbibtex: r.get("betterbibtex").and_then(Value::as_str).unwrap_or("?").to_string(),
    })
}

/// Quick search of the Zotero library (title, creators, year, …).
#[tauri::command]
pub async fn tb_zotero_search(state: State<'_, AppState>, url: Option<String>, query: String) -> Result<Vec<ZoteroItem>, String> {
    let base = base_url(url.as_deref())?;
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let result = rpc(&base, "item.search", json!([query])).await?;
    let known = current_project(&state).map(|p| project_bib_keys(&p)).unwrap_or_default();
    let mut items: Vec<ZoteroItem> = result.as_array().map(|a| a.iter().filter_map(item_from_csl).collect()).unwrap_or_default();
    for it in &mut items {
        it.in_project = known.contains(&it.citekey);
    }
    items.truncate(100);
    Ok(items)
}

#[derive(Debug, Serialize)]
pub struct ZoteroAddResult {
    /// Keys whose entries were appended to the .bib.
    pub added: Vec<String>,
    /// Keys already present in the project.
    pub existing: Vec<String>,
    pub bib_file: String,
    /// True when the .bib file had to be created.
    pub created: bool,
}

/// Append the BibTeX of `citekeys` that are not yet in the project to
/// `bib_file` (default: the first `.bib`, or a new `refs.bib`).
#[tauri::command]
pub async fn tb_zotero_add(
    app: AppHandle,
    state: State<'_, AppState>,
    url: Option<String>,
    citekeys: Vec<String>,
    bib_file: Option<String>,
) -> Result<ZoteroAddResult, String> {
    let base = base_url(url.as_deref())?;
    let proj = current_project(&state)?;
    if citekeys.is_empty() {
        return Err("没有选择文献".into());
    }
    let known = project_bib_keys(&proj);
    let (existing, missing): (Vec<String>, Vec<String>) = citekeys.into_iter().partition(|k| known.contains(k));
    let target = match bib_file.filter(|b| !b.trim().is_empty()) {
        Some(b) => crate::commands::files::clean_rel(&proj, &b)?,
        None => proj.bib_files().into_iter().next().map(|p| p.replace('\\', "/")).unwrap_or_else(|| "refs.bib".into()),
    };
    if !target.to_ascii_lowercase().ends_with(".bib") {
        return Err("目标文件必须是 .bib".into());
    }
    let created = proj.resolve(&target).map(|p| !p.exists()).unwrap_or(true);
    if !missing.is_empty() {
        let exported = rpc(&base, "item.export", json!([missing, TRANSLATOR])).await?;
        let body = export_body(&exported).ok_or("Zotero 没有返回 BibTeX")?;
        if body.trim().is_empty() {
            return Err("Zotero 返回了空的 BibTeX".into());
        }
        let current = if created { String::new() } else { proj.read_file(&target)? };
        if !created {
            crate::core::history::record(&proj, &target, &current, true)?;
        }
        let mut next = current.trim_end().to_string();
        if !next.is_empty() {
            next.push_str("\n\n");
        }
        next.push_str(body.trim());
        next.push('\n');
        proj.write_file(&target, &next)?;
        emit_project_changed(&app);
    }
    Ok(ZoteroAddResult { added: missing, existing, bib_file: target, created })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_addresses_are_allowed() {
        assert_eq!(base_url(None).unwrap(), DEFAULT_URL);
        assert_eq!(base_url(Some("http://localhost:23119/")).unwrap(), "http://localhost:23119");
        assert!(base_url(Some("http://evil.example:23119")).is_err());
        assert!(base_url(Some("https://127.0.0.1:23119")).is_err());
        assert!(base_url(Some("http://127.0.0.1.evil.example")).is_err());
    }

    #[test]
    fn maps_csl_search_results() {
        let v = json!({
            "citekey": "zhang2020deep", "title": "深度学习", "type": "article-journal",
            "container-title": "计算机学报", "library": "My Library",
            "author": [{"family": "张", "given": "三"}, {"family": "Smith", "given": "John"}],
            "issued": {"date-parts": [[2020, 5]]}
        });
        let it = item_from_csl(&v).unwrap();
        assert_eq!(it.citekey, "zhang2020deep");
        assert_eq!(it.authors, "张三, John Smith");
        assert_eq!(it.year, "2020");
        assert_eq!(it.container, "计算机学报");
        assert!(item_from_csl(&json!({"title": "no key"})).is_none());
    }

    #[test]
    fn export_body_handles_both_response_shapes() {
        assert_eq!(export_body(&json!("@article{a,}")).unwrap(), "@article{a,}");
        assert_eq!(export_body(&json!([200, "text/plain", "@book{b,}"])).unwrap(), "@book{b,}");
        assert!(export_body(&json!(null)).is_none());
    }
}
