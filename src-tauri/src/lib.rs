//! TeXButler Tauri application: builder, state registration, commands.

pub mod commands;
pub mod core;
pub mod state;

use state::AppState;
use tauri::Manager;

/// Percent-decode a URL path component (`%XX`). `+` is kept literal.
fn percent_decode(s: &str) -> Result<String, ()> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|_| ())?;
                let v = u8::from_str_radix(hex, 16).map_err(|_| ())?;
                out.push(v);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

/// Restrictive file-serving scheme for PDF/images inside the OPEN PROJECT
/// only (the old `assetProtocol.scope: ["**"]` allowed any local file once
/// the frontend was injected). Extension whitelist: only preview-able
/// content types can ever be served.
const PREVIEW_EXTS: [&str; 7] = ["pdf", "png", "jpg", "jpeg", "gif", "svg", "webp"];

fn serve_project_file(app: &tauri::AppHandle, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{Response, StatusCode};
    let bad = |code: StatusCode| -> tauri::http::Response<Vec<u8>> {
        Response::builder().status(code).body(Vec::new()).unwrap()
    };
    // Defense in depth: only serve requests for the tb-file protocol.
    // wry reverts the workaround URI (`http://tb-file.localhost/...`) to
    // the original form (`tb-file://localhost/...`) before calling the
    // handler, so both hosts are legitimate. Anything else is refused.
    let host_ok = request
        .uri()
        .host()
        .map(|h| h.eq_ignore_ascii_case("tb-file.localhost") || h.eq_ignore_ascii_case("localhost"))
        .unwrap_or(false);
    if !host_ok {
        return bad(StatusCode::FORBIDDEN);
    }
    let path_and_query = request.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/");
    // `http://tb-file.localhost/<percent-encoded absolute path>` → strip leading '/'
    let encoded = path_and_query.trim_start_matches('/');
    let Ok(decoded) = percent_decode(encoded) else {
        return bad(StatusCode::BAD_REQUEST);
    };
    if decoded.is_empty() || decoded.starts_with("tb-file:") {
        return bad(StatusCode::BAD_REQUEST);
    }
    let ext = std::path::Path::new(&decoded)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !PREVIEW_EXTS.iter().any(|w| *w == ext) {
        return bad(StatusCode::FORBIDDEN);
    }
    let proj = {
        let state = app.state::<AppState>();
        let Ok(guard) = state.project.read() else {
            return bad(StatusCode::FORBIDDEN);
        };
        let Some(p) = guard.as_ref() else {
            return bad(StatusCode::FORBIDDEN);
        };
        p.clone()
    };
    // `Project::resolve` rejects any path that escapes the project root
    // (including `..` and absolute paths outside), so this cannot serve
    // files outside the opened project directory.
    let Some(resolved) = proj.resolve(&decoded) else {
        return bad(StatusCode::FORBIDDEN);
    };
    // Symlink defense: canonicalize and require the real path to stay
    // inside the project root (resolve() is lexical; a project-internal
    // symlink could otherwise point outside).
    let Ok(canon) = std::fs::canonicalize(&resolved) else {
        return bad(StatusCode::NOT_FOUND);
    };
    let root_canon = std::fs::canonicalize(proj.root.clone()).unwrap_or_else(|_| proj.root.clone());
    if !canon.starts_with(&root_canon) {
        return bad(StatusCode::FORBIDDEN);
    }
    let Ok(bytes) = std::fs::read(&canon) else {
        return bad(StatusCode::NOT_FOUND);
    };
    let content_type = match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    Response::builder()
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        // Chromium treats a custom-scheme resource in an <iframe> as
        // cross-origin; without CORP the PDF viewer is blocked and the
        // preview stays blank. nosniff keeps the served bytes honest.
        .header("cross-origin-resource-policy", "cross-origin")
        .header("x-content-type-options", "nosniff")
        .body(bytes)
        .unwrap_or_else(|_| bad(StatusCode::INTERNAL_SERVER_ERROR))
}

/// Run the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::new())
        .register_uri_scheme_protocol("tb-file", |ctx, request| {
            let app = ctx.app_handle();
            serve_project_file(app, &request)
        })
        .setup(|_app| {
            // Tectonic manages its own bundle cache; nothing to unpack here.
            // (Offline bundle dirs can be injected via TEXBUTLER_BUNDLE_DIR.)
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // project
            commands::project::tb_open_project,
            commands::project::tb_new_project,
            commands::project::tb_project_info,
            commands::project::tb_read_file,
            commands::project::tb_write_file,

            commands::project::tb_get_templates,
            commands::project::tb_set_main_file,
            commands::project::tb_import_image,
            commands::project::tb_import_clipboard_image,
            commands::project::tb_list_bib_entries,
        commands::project::tb_check_refs,
        commands::project::tb_ref_index,
        commands::project::tb_scan_todos,
        commands::project::tb_bib_from_id,
        commands::templates::tb_list_market_templates,
        commands::templates::tb_download_template,
        commands::templates::tb_create_from_market_template,
        commands::check::tb_count_words,
        commands::project::tb_list_roots,
        commands::ai::tb_ai_polish,
        commands::project::tb_synctex_forward,
        commands::project::tb_export,
        commands::ai::tb_ai_translate,
            commands::project::tb_import_docx,
            commands::project::tb_save_template,
            commands::project::tb_list_templates,
            commands::project::tb_delete_template,
            // compile
            commands::compile::tb_compile,
            commands::compile::tb_cancel_compile,
            commands::compile::tb_get_last_result,
            commands::compile::tb_read_log,
            // diagnostics
            commands::diagnostics::tb_get_diagnostics,
            // ai
            commands::ai::tb_ai_diagnose,
            commands::ai::tb_ai_fix,
            commands::ai::tb_ai_apply_patch,
            commands::ai::tb_ai_chat,
            commands::ai::tb_ai_chat_stream,
            commands::ai::tb_ai_snapshots,
            commands::ai::tb_token_usage,
    commands::ai::tb_token_usage_reset,
    commands::ai::tb_ai_create_guide,
    commands::ai::tb_ai_rollback,
    commands::ai::tb_fix_rule_issue,
            commands::ai::tb_check_updates,
            commands::ai::tb_get_update_check,
            commands::ai::tb_set_update_check,
            commands::ai::tb_ai_get_settings,
            commands::ai::tb_ai_set_settings,
            commands::ai::tb_ai_test_connection,
            commands::ai::tb_ai_generate,
            // check
            commands::check::tb_run_check,
            commands::check::tb_set_rule_enabled,
            commands::check::tb_get_rule_states,
            commands::check::tb_get_bundle_status,
            commands::check::tb_download_bundle,
            commands::check::tb_set_engine,
            commands::check::tb_get_engine,
            commands::check::tb_set_texlive_passes,
            commands::check::tb_get_texlive_passes,
            commands::check::tb_get_cjk_fonts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
