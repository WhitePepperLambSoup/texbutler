//! TeXButler Tauri application: builder, state registration, commands.

pub mod commands;
pub mod core;
pub mod state;

use state::AppState;

/// Run the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
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
            commands::project::tb_recent_projects,
            commands::project::tb_get_templates,
            commands::project::tb_set_main_file,
            commands::project::tb_import_image,
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
