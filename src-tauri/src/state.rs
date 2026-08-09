//! Shared application state managed by Tauri.

use crate::core::compiler::CompileResult;
use crate::core::project::{Project, WatchHandle};
use crate::core::settings::Settings;
use crate::core::Issue;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

pub struct AppState {
    /// The currently opened project (None until one is opened).
    pub project: RwLock<Option<Project>>,
    /// Persisted settings (loaded at startup, saved on change).
    pub settings: RwLock<Settings>,
    /// Latest compile result (for diagnostics queries).
    pub last_result: RwLock<Option<CompileResult>>,
    /// Monotonic ownership token for project-scoped asynchronous work.
    pub project_generation: AtomicU64,
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
            project_generation: AtomicU64::new(0),
            rule_issues: RwLock::new(Vec::new()),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            watcher: RwLock::new(None),
        }
    }

    pub fn publish_compile_result_if_current(
        &self,
        owner_generation: u64,
        owner_root: &Path,
        result: &CompileResult,
        publish: impl FnOnce(),
    ) -> Result<bool, String> {
        let project = self.project.read().map_err(|error| error.to_string())?;
        let still_owned = self.project_generation.load(Ordering::SeqCst) == owner_generation
            && project
                .as_ref()
                .is_some_and(|current| current.root == owner_root);
        if !still_owned {
            return Ok(false);
        }
        let mut last_result = self
            .last_result
            .write()
            .map_err(|error| error.to_string())?;
        *last_result = Some(result.clone());
        publish();
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compile_result_publish_rejects_stale_same_root_generation() {
        let root =
            std::env::temp_dir().join(format!("tb-state-compile-owner-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("main.tex"), "\\documentclass{article}\n").unwrap();
        let project = Project::open(&root).unwrap();
        let state = AppState::new();
        *state.project.write().unwrap() = Some(project);
        state.project_generation.store(7, Ordering::SeqCst);
        let result = CompileResult::failed(
            root.join("main.log"),
            crate::core::compiler::EngineUsed::Tectonic,
            "owner test",
        );

        let current_published = std::cell::Cell::new(false);
        assert!(state
            .publish_compile_result_if_current(7, &root, &result, || {
                current_published.set(true)
            })
            .unwrap());
        assert!(current_published.get());
        *state.last_result.write().unwrap() = None;

        state.project_generation.store(8, Ordering::SeqCst);
        let stale_published = std::cell::Cell::new(false);
        assert!(!state
            .publish_compile_result_if_current(7, &root, &result, || { stale_published.set(true) })
            .unwrap());
        assert!(!stale_published.get());
        assert!(state.last_result.read().unwrap().is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}
