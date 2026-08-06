//! AI layer: multi-provider chat client, diagnosis and fix loop.
//! All calls are async (tokio) and cancellable.

pub mod chat;
pub mod diagnose;
pub mod fix_loop;
pub mod guide;
pub mod prompt_templates;
pub mod provider;
pub mod translate;

pub use diagnose::{AiDiagnosis, diagnose};
pub use fix_loop::{fix_loop, rollback_from_backup};
pub use provider::{AiError, AiSettings, ChatMsg, ProviderKind, chat};
