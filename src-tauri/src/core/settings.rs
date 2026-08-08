//! Persisted application settings (JSON at `$APPDATA/texbutler/settings.json`).
//! Holds AI provider config, engine preference and per-rule toggles.

use crate::core::ai::provider::AiSettings;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnginePreference {
    /// tectonic first, fall back to system texlive on failure.
    Auto,
    /// Always tectonic.
    Tectonic,
    /// Always system texlive (xelatex/lualatex).
    SystemTexlive,
}

impl Default for EnginePreference {
    fn default() -> Self {
        EnginePreference::Auto
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub ai: AiSettings,
    pub engine: EnginePreference,
    /// Rule id -> enabled. Missing entries use the rule default.
    pub rules: std::collections::HashMap<String, bool>,
    /// Number of passes for the system texlive driver.
    pub texlive_passes: u32,
    /// Check GitHub releases for updates on startup.
    #[serde(default = "default_true")]
    pub check_updates: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            ai: AiSettings::default(),
            engine: EnginePreference::Auto,
            rules: std::collections::HashMap::new(),
            texlive_passes: 2,
            check_updates: true,
        }
    }
}

impl Settings {
    pub fn config_dir() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("texbutler")
    }

    pub fn config_path() -> PathBuf {
        Self::config_dir().join("settings.json")
    }

    /// Load settings from disk; returns defaults when missing/corrupt.
    pub fn load() -> Settings {
        let path = Self::config_path();
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => Settings::default(),
        }
    }

    /// Save settings to disk (best-effort, never fatal).
    pub fn save(&self) -> Result<(), String> {
        let dir = Self::config_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(Self::config_path(), json).map_err(|e| e.to_string())
    }

    /// Whether a rule is enabled (falls back to the rule default).
    pub fn rule_enabled(&self, id: &str, default: bool) -> bool {
        self.rules.get(id).copied().unwrap_or(default)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_via_temp_file() {
        let mut s = Settings::default();
        s.engine = EnginePreference::Tectonic;
        s.rules.insert("percent".to_string(), false);
        // serialize/deserialize cycle (no disk write to user config)
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.engine, EnginePreference::Tectonic);
        assert!(!back.rule_enabled("percent", true));
        assert!(back.rule_enabled("italic", true));
    }
}
