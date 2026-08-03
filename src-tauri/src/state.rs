//! Shared application state managed by Tauri.

use crate::core::compiler::CompileResult;
use crate::core::project::{Project, WatchHandle};
use crate::core::settings::Settings;
use crate::core::Issue;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};

pub struct AppState {
    /// The currently opened project (None until one is opened).
    pub project: RwLock<Option<Project>>,
    /// Persisted settings (loaded at startup, saved on change).
    pub settings: RwLock<Settings>,
    /// Latest compile result (for diagnostics queries).
    pub last_result: RwLock<Option<CompileResult>>,
    /// Issues from the last rule check run.
    pub rule_issues: RwLock<Vec<Issue>>,
    /// Cancellation flag for the in-flight compile job (Arc for sharing).
    pub cancel_flag: Arc<AtomicBool>,
    /// Keeps the file watcher alive.
    pub watcher: RwLock<Option<WatchHandle>>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            project: RwLock::new(None),
            settings: RwLock::new(Settings::load()),
            last_result: RwLock::new(None),
            rule_issues: RwLock::new(Vec::new()),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            watcher: RwLock::new(None),
        }
    }
}
