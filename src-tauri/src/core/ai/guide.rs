//! Project style guide (AI_GUIDE.md): a per-project Markdown file at the
//! project root that is injected into every AI prompt (diagnose / fix /
//! chat) so the AI adapts to the author's conventions (school format
//! requirements, custom macros, typographic preferences).

use crate::core::project::Project;

/// The guide file name at the project root.
pub const GUIDE_FILE: &str = "AI_GUIDE.md";

/// Load the project guide content, if present (capped to keep the prompt bounded).
pub fn load_guide(project: &Project) -> Option<String> {
    let content = project.read_file(GUIDE_FILE).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(6000).collect())
}

/// A short system-prompt fragment describing the guide, or empty.
pub fn guide_system_fragment(project: &Project) -> String {
    match load_guide(project) {
        Some(guide) => format!(
            "\n【作者项目指南 AI_GUIDE.md（必须严格遵守）】\n{guide}\n【指南结束】\n"
        ),
        None => String::new(),
    }
}
