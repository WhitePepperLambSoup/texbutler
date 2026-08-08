# UI Workflow Regression Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the new-file/template workflow, make the appearance controls reliably clickable at the minimum window width, and keep the PDF pane visible before and after compilation.

**Architecture:** Keep `App` as the owner of global modal and toolbar-popover state, move the document/template workflow into a focused `NewFileModal`, and keep `NewProjectModal` deterministic. Add one project-scoped Rust import command backed by symlink-safe temporary-tree helpers, then verify the user-visible contracts with a suite-selectable WebView2 CDP regression script.

**Tech Stack:** React 18, TypeScript 5.7, Zustand 5, CSS, Tauri 2, Rust 1.77, WebView2 CDP, Node.js E2E scripts, PowerShell packaging.

## Global Constraints

- An open project is required for file creation and template import.
- `tb_import_project_template(target_dir, template_id, source)` accepts only `source = "user" | "market"` and returns `{ target_dir, main_file }` with project-relative forward-slash paths.
- Template imports reject absolute paths, traversal, existing targets, dangling or escaping symbolic links, and templates without a `.tex` document root containing `\documentclass`.
- Template import and Save as template use temporary sibling directories and remove only directories created by the current operation after failure.
- New user templates store the project tree except `.texbutler`, `.git`, `node_modules`, and `target`; legacy `<name>.tex` templates remain listable, importable, and deletable.
- New project asks only for parent directory and project name and always creates the built-in `article` starter.
- At the configured 940px minimum width, compile target, compile/cancel, New file, appearance, overflow, and settings remain reachable without toolbar horizontal scrolling.
- Appearance selection persists `tb-theme`; outside-pointer dismissal preserves the clicked target's focus; Escape restores focus to the appearance trigger.
- Whenever `root` is non-empty, the PDF pane and its divider remain visible at the persisted width, whether or not `pdfPath` exists.
- Preserve the responsive AI/editor behavior covered by `scripts/e2e-v086.mjs`.
- Do not stage or commit `src-tauri/Cargo.toml` unless its content hash differs from `HEAD:src-tauri/Cargo.toml`; its current working-tree modification is line-ending/index noise.
- Release installers stay under ignored `release/0.7.0b/` and are not committed.

## File Structure

- Create `src/components/NewFileModal.tsx`: the Basic file, My templates, and Template marketplace workflow.
- Create `scripts/e2e-v087.mjs`: independent `files`, `theme`, `pdf`, and `all` CDP suites using real pointer/keyboard input.
- Modify `src/App.tsx`: wire the new modal, responsive toolbar overflow, anchored appearance popover, and persistent PDF column.
- Modify `src/components/ProjectTree.tsx`: restore the new-file entry and delegate it through `onNewFile`.
- Modify `src/components/NewProjectModal.tsx`: retain only parent, name, and article project creation.
- Modify `src/api/index.ts`: add typed `TemplateSource`, `ImportedTemplate`, and `importProjectTemplate` bindings.
- Modify `src/i18n/index.ts`: add Chinese and English New file tabs, target/import errors, overflow, and saved-template labels.
- Modify `src/styles.css`: add modal/tab layout, toolbar priority/overflow layers, correct theme anchoring, and persistent PDF styling.
- Modify `src-tauri/src/commands/templates.rs`: add checked tree-copy, source resolution, project-scoped import, main-document detection, and focused tests.
- Modify `src-tauri/src/commands/project.rs`: save/list/delete directory templates with legacy compatibility and keep new-project creation article-only from the UI.
- Modify `src-tauri/src/lib.rs`: register `tb_import_project_template`.
- Modify `scripts/e2e-v074.mjs`: move the marketplace UI assertion from New project to New file.
- Modify `scripts/e2e-v084.mjs`: replace the obsolete zero-width PDF expectation with the persistent empty-pane contract.

---

### Task 1: Build the Checked Template-Tree Import Primitive

**Files:**
- Modify: `src-tauri/src/commands/templates.rs:6-318`
- Test: `src-tauri/src/commands/templates.rs` (`#[cfg(test)]` module appended after the helpers)

**Interfaces:**
- Consumes: `crate::core::project::Project` path guards and either a directory, single file, embedded directory, or built-in template body.
- Produces: `TemplateSource`, `ImportedTemplate`, `ResolvedTemplate`, `copy_tree_checked`, `detect_main_document`, and `import_resolved_template` for Task 2.

- [ ] **Step 1: Write failing path and cleanup tests**

Add a local test-root helper that creates unique directories only under `std::env::temp_dir()` and removes them in each test's final statements:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(1);

    fn test_root(label: &str) -> PathBuf {
        let id = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "texbutler-template-{label}-{}-{id}",
            std::process::id(),
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_fixture(path: &Path, content: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
}
```

Add these exact test names and assertions:

```rust
#[test]
fn import_rejects_absolute_traversal_and_existing_targets() {
    let root = test_root("reject-target");
    let project_root = root.join("project");
    let source_root = root.join("source");
    write_fixture(&project_root.join("main.tex"), b"\\documentclass{article}\n");
    write_fixture(&source_root.join("main.tex"), b"\\documentclass{article}\n");
    std::fs::create_dir_all(project_root.join("notes")).unwrap();
    let project = Project::open(&project_root).unwrap();

    for bad in ["D:/escape", "/escape", "../escape", "notes"] {
        assert!(import_resolved_template(
            &project,
            bad,
            ResolvedTemplate::Directory(&source_root),
        ).is_err(), "target must be rejected: {bad}");
    }

    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn import_returns_project_relative_target_and_main_file() {
    let root = test_root("relative-result");
    let project_root = root.join("project");
    let source_root = root.join("source");
    write_fixture(&project_root.join("main.tex"), b"\\documentclass{article}\n");
    write_fixture(&source_root.join("main.tex"), b"\\documentclass{report}\n");
    write_fixture(&source_root.join("chapters/a.tex"), b"chapter\n");
    let project = Project::open(&project_root).unwrap();

    let imported = import_resolved_template(
        &project,
        "thesis",
        ResolvedTemplate::Directory(&source_root),
    ).unwrap();

    assert_eq!(imported.target_dir, "thesis");
    assert_eq!(imported.main_file, "thesis/main.tex");
    assert_eq!(std::fs::read(project_root.join("thesis/chapters/a.tex")).unwrap(), b"chapter\n");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn import_rejects_tree_without_document_root_and_cleans_temp() {
    let root = test_root("cleanup");
    let project_root = root.join("project");
    let source_root = root.join("source");
    write_fixture(&project_root.join("main.tex"), b"\\documentclass{article}\n");
    write_fixture(&source_root.join("chapter.tex"), b"plain chapter\n");
    let project = Project::open(&project_root).unwrap();

    assert!(import_resolved_template(
        &project,
        "broken",
        ResolvedTemplate::Directory(&source_root),
    ).is_err());
    assert!(!project_root.join("broken").exists());
    let residue = std::fs::read_dir(&project_root).unwrap().flatten().any(|entry| {
        entry.file_name().to_string_lossy().contains("texbutler-import")
    });
    assert!(!residue, "failed import must remove its temporary sibling");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn import_preserves_project_root_and_unrelated_files() {
    let root = test_root("preserve-root");
    let project_root = root.join("project");
    let source_root = root.join("source");
    write_fixture(&project_root.join("main.tex"), b"\\documentclass{article}\n");
    write_fixture(&project_root.join("keep.txt"), b"unchanged");
    write_fixture(&source_root.join("paper.tex"), b"\\documentclass{article}\n");
    let project = Project::open(&project_root).unwrap();

    let imported = import_resolved_template(
        &project,
        "papers/demo",
        ResolvedTemplate::Directory(&source_root),
    ).unwrap();

    assert_eq!(std::fs::read(project_root.join("keep.txt")).unwrap(), b"unchanged");
    assert!(project_root.join(&imported.target_dir).starts_with(&project_root));
    assert!(project_root.join(&imported.main_file).starts_with(&project_root));
    std::fs::remove_dir_all(root).unwrap();
}
```

Use platform-gated symlink creation and skip only when Windows lacks symlink privilege:

```rust
#[test]
fn import_rejects_source_and_target_symlinks() {
    // Assert a symlink in the source tree and a dangling/escaping target
    // component both return Err without creating the final target.
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::templates::tests::import_ -- --nocapture
```

Expected: compilation fails because `ResolvedTemplate` and `import_resolved_template` do not exist.

- [ ] **Step 3: Add the typed contract and resolved-source enum**

Add the public command types near `MarketTemplateView`:

```rust
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TemplateSource {
    User,
    Market,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ImportedTemplate {
    pub target_dir: String,
    pub main_file: String,
}

enum ResolvedTemplate<'a> {
    Directory(&'a Path),
    SingleFile(&'a Path),
    Embedded(&'a Dir<'a>),
    Builtin(&'static str),
}
```

- [ ] **Step 4: Implement safe target validation and temporary naming**

Add helpers with these signatures:

```rust
fn normalize_project_relative_dir(project: &Project, raw: &str) -> Result<String, String>;
fn import_temp_sibling(target: &Path) -> Result<PathBuf, String>;
fn remove_created_dir(path: &Path);
```

`normalize_project_relative_dir` must trim input, reject `:`, absolute/root/prefix/parent components, reject empty and `.`, call `project.resolve`, call `project.canonical_inside` on the unresolved final path, and reject any path for which `symlink_metadata` already succeeds. Normalize the return value with forward slashes.

`import_temp_sibling` must use the target's existing parent and produce `.<target-name>.texbutler-import-<pid>-<counter>`; retry while `symlink_metadata` finds a collision.

- [ ] **Step 5: Implement the checked copy and main-document detector**

Add:

```rust
fn copy_tree_checked(src: &Path, dst: &Path, excluded_dirs: &[&str]) -> Result<(), String>;
fn detect_main_document(root: &Path) -> Result<String, String>;
```

For every directory entry, inspect `symlink_metadata` before `is_dir`; reject all symbolic links. Skip only names in `excluded_dirs`. Copy regular files without interpreting their content. `detect_main_document` opens the staged directory as a `Project`, uses `document_roots()`, prefers `main.tex`, otherwise returns the first sorted root, and errors when no root contains `\documentclass`.

- [ ] **Step 6: Implement staged import and cleanup**

Add:

```rust
fn import_resolved_template(
    project: &Project,
    target_dir: &str,
    source: ResolvedTemplate<'_>,
) -> Result<ImportedTemplate, String>;
```

The function must create only the temporary sibling, populate it according to the resolved variant, call `detect_main_document`, rename the temporary sibling to the final target, and return:

```rust
ImportedTemplate {
    target_dir: normalized_target.clone(),
    main_file: format!("{normalized_target}/{main_inside}"),
}
```

Wrap population/validation/rename in a closure; on `Err`, call `remove_created_dir(&temp)` and leave the final target absent.

- [ ] **Step 7: Run focused tests and verify GREEN**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::templates::tests::import_ -- --nocapture
```

Expected: all import safety, cleanup, and path-return tests pass.

- [ ] **Step 8: Commit the primitive**

```powershell
git diff --check
git add src-tauri/src/commands/templates.rs
git commit -m "feat: add safe project template import"
```

---

### Task 2: Add Saved-Template Storage and the Tauri Import Command

**Files:**
- Modify: `src-tauri/src/commands/templates.rs`
- Modify: `src-tauri/src/commands/project.rs:263-301,605-671`
- Modify: `src-tauri/src/lib.rs:137-166`
- Modify: `src/api/index.ts:150-205`
- Test: `src-tauri/src/commands/templates.rs`

**Interfaces:**
- Consumes: Task 1's `import_resolved_template` and current `user_template_dir()` / `market_download_dir()` roots.
- Produces: `tb_import_project_template`, directory-based Save as template, and frontend `api.importProjectTemplate`.

- [ ] **Step 1: Write failing saved-template compatibility tests**

Add these exact tests around helpers that accept explicit project/template roots:

```rust
#[test]
fn save_user_template_copies_assets_and_excludes_internal_dirs() {
    let root = test_root("save-tree");
    let project = root.join("project");
    let templates = root.join("templates");
    write_fixture(&project.join("main.tex"), b"\\documentclass{article}\n");
    write_fixture(&project.join("refs.bib"), b"@book{x,title={X}}\n");
    write_fixture(&project.join("figures/a.png"), b"png");
    for excluded in [".texbutler/build/out.pdf", ".git/config", "node_modules/x/index.js", "target/debug/x"] {
        write_fixture(&project.join(excluded), b"excluded");
    }

    save_user_template_at(&project, &templates, "paper").unwrap();

    assert!(templates.join("paper/main.tex").is_file());
    assert!(templates.join("paper/refs.bib").is_file());
    assert!(templates.join("paper/figures/a.png").is_file());
    for excluded in [".texbutler", ".git", "node_modules", "target"] {
        assert!(!templates.join("paper").join(excluded).exists());
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn save_user_template_rejects_existing_directory_or_legacy_file() {
    let root = test_root("save-collision");
    let project = root.join("project");
    let templates = root.join("templates");
    write_fixture(&project.join("main.tex"), b"\\documentclass{article}\n");
    write_fixture(&templates.join("legacy.tex"), b"\\documentclass{article}\n");
    std::fs::create_dir_all(templates.join("directory")).unwrap();

    assert!(save_user_template_at(&project, &templates, "legacy").is_err());
    assert!(save_user_template_at(&project, &templates, "directory").is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn list_user_templates_merges_directory_and_legacy_entries_without_duplicates() {
    let root = test_root("list-templates");
    let templates = root.join("templates");
    write_fixture(&templates.join("alpha/main.tex"), b"\\documentclass{article}\n");
    write_fixture(&templates.join("alpha.tex"), b"\\documentclass{article}\n");
    write_fixture(&templates.join("beta.tex"), b"\\documentclass{article}\n");

    let items = list_user_templates_at(&templates);
    let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(ids, vec!["alpha", "beta"]);
    assert!(items.iter().all(|item| item.source == "user"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn delete_user_template_removes_exact_resolved_entry() {
    let root = test_root("delete-template");
    let templates = root.join("templates");
    write_fixture(&templates.join("directory/main.tex"), b"\\documentclass{article}\n");
    write_fixture(&templates.join("legacy.tex"), b"\\documentclass{article}\n");
    write_fixture(&templates.join("keep.tex"), b"\\documentclass{article}\n");

    delete_user_template_at(&templates, "directory").unwrap();
    delete_user_template_at(&templates, "legacy").unwrap();

    assert!(!templates.join("directory").exists());
    assert!(!templates.join("legacy.tex").exists());
    assert!(templates.join("keep.tex").is_file());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_single_file_import_becomes_main_tex() {
    let root = test_root("legacy-import");
    let project_root = root.join("project");
    let legacy = root.join("sample.tex");
    write_fixture(&project_root.join("main.tex"), b"\\documentclass{article}\n");
    write_fixture(&legacy, b"\\documentclass{report}\n");
    let project = Project::open(&project_root).unwrap();

    let imported = import_resolved_template(
        &project,
        "sample",
        ResolvedTemplate::SingleFile(&legacy),
    ).unwrap();

    assert_eq!(imported.main_file, "sample/main.tex");
    assert_eq!(std::fs::read(project_root.join("sample/main.tex")).unwrap(), b"\\documentclass{report}\n");
    std::fs::remove_dir_all(root).unwrap();
}
```

- [ ] **Step 2: Run saved-template tests and verify RED**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::templates::tests::save_user_template -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml commands::templates::tests::legacy_single_file_import -- --nocapture
```

Expected: helper symbols are missing.

- [ ] **Step 3: Implement explicit-root saved-template helpers**

Add to `templates.rs`:

```rust
pub(crate) fn save_user_template_at(project_root: &Path, template_root: &Path, name: &str) -> Result<(), String>;
pub(crate) fn list_user_templates_at(template_root: &Path) -> Vec<crate::commands::project::TemplateInfo>;
pub(crate) fn delete_user_template_at(template_root: &Path, name: &str) -> Result<(), String>;
```

`save_user_template_at` validates the name through a `pub(crate)` `validate_template_name`, rejects both `<name>/` and `<name>.tex` collisions, copies through a temporary sibling with `copy_tree_checked(project_root, &temporary_template, &[".texbutler", ".git", "node_modules", "target"])`, validates a main document, and renames into `<name>/`.

`list_user_templates_at` lists directory templates and legacy `.tex` files, sorts by ID, deduplicates IDs with directory entries winning, and sets `source = "user"`.

`delete_user_template_at` resolves `<name>/` first and `<name>.tex` second, rejects symlink entries, and removes exactly one matching entry.

- [ ] **Step 4: Route existing project commands through the helpers**

Change `validate_template_name` visibility to `pub(crate)`. Replace the current single-file Save/List/Delete bodies with:

```rust
#[tauri::command]
pub fn tb_save_template(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let project = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    crate::commands::templates::save_user_template_at(&project.root, &user_template_dir(), &name)
}

#[tauri::command]
pub fn tb_list_templates() -> Vec<TemplateInfo> {
    crate::commands::templates::list_user_templates_at(&user_template_dir())
}

#[tauri::command]
pub fn tb_delete_template(name: String) -> Result<(), String> {
    crate::commands::templates::delete_user_template_at(&user_template_dir(), &name)
}
```

`tb_list_templates` now returns user templates only; built-in file seeds remain a frontend-owned fixed list and `tb_get_templates` remains available for compatibility.

In `tb_new_project`, remove the user-template file fallback. Accept only IDs returned by `crate::core::project::templates()`; the no-template branch continues to call `Project::create`, which is article-based. This keeps the backend consistent with the simplified New project UI and prevents the new directory-based user-template storage from leaking back into project creation.

- [ ] **Step 5: Add source resolution and the Tauri command**

Add to `templates.rs`:

```rust
#[tauri::command]
pub fn tb_import_project_template(
    state: tauri::State<'_, crate::state::AppState>,
    target_dir: String,
    template_id: String,
    source: TemplateSource,
) -> Result<ImportedTemplate, String>;
```

Resolution rules:

- User: validate ID; prefer `<user_template_dir>/<id>/`; otherwise use legacy `<id>.tex`; reject missing entries and all symlinks.
- Market: validate ID against the catalog; resolve embedded directory, downloaded directory with `.texbutler-verified`, or a legacy built-in body from `crate::core::project::templates()`.
- Hold only a read guard long enough to clone the open `Project`, then call `import_resolved_template` without mutating `AppState`.

Register `commands::templates::tb_import_project_template` in `src-tauri/src/lib.rs` directly after `tb_download_template`.

- [ ] **Step 6: Add the frontend API contract**

Add above `api` in `src/api/index.ts`:

```ts
export type TemplateSource = "user" | "market";

export interface ImportedTemplate {
  target_dir: string;
  main_file: string;
}
```

Add:

```ts
importProjectTemplate: (targetDir: string, templateId: string, source: TemplateSource) =>
  invoke<ImportedTemplate>("tb_import_project_template", {
    targetDir,
    templateId,
    source,
  }),
```

Keep `createFromMarketTemplate` temporarily so the older marketplace backend regression remains callable until `e2e-v074` is updated.

- [ ] **Step 7: Run Rust and TypeScript checks**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::templates::tests -- --nocapture
.\node_modules\.bin\tsc.cmd --noEmit
git diff --check
```

Expected: all template tests pass and TypeScript accepts the new contract.

- [ ] **Step 8: Commit the command and storage migration**

```powershell
git add src-tauri/src/commands/templates.rs src-tauri/src/commands/project.rs src-tauri/src/lib.rs src/api/index.ts
git commit -m "feat: import templates into open projects"
```

---

### Task 3: Rebuild New File as the Document and Template Center

**Files:**
- Create: `src/components/NewFileModal.tsx`
- Create: `scripts/e2e-v087.mjs`
- Modify: `src/App.tsx:1-16,640-658`
- Modify: `src/components/ProjectTree.tsx:1-225`
- Modify: `src/components/NewProjectModal.tsx:1-237`
- Modify: `src/i18n/index.ts`
- Modify: `src/styles.css:1710-1825,2361-2465`
- Modify: `scripts/e2e-v074.mjs:128-165`

**Interfaces:**
- Consumes: `api.newFile`, `api.listTemplates`, `api.deleteTemplate`, `api.listMarketTemplates`, `api.downloadTemplate`, `api.importProjectTemplate`, `useProjectStore.refresh`, and `useProjectStore.openFile`.
- Produces: `NewFileModal({ open, onClose })`, `ProjectTree({ onNewFile })`, and `node scripts/e2e-v087.mjs files`.

- [ ] **Step 1: Create the suite-selectable CDP harness**

Base the connection, `exec`, `pointerClick`, `pressEscape`, device emulation, fixture cleanup, and `try/finally` behavior on `scripts/e2e-v086.mjs`. Accept:

```js
const suite = process.argv[2] ?? "all";
if (!new Set(["files", "theme", "pdf", "all"]).has(suite)) {
  throw new Error(`unknown suite: ${suite}`);
}
```

Create `assets/e2e/v087-check/main.tex`, open it through `useProjectStore`, and remove the fixture on pass or failure.

- [ ] **Step 2: Add the failing `files` suite**

At 1280x800, use real pointer clicks and require:

```js
{
  toolbarEntryOpensNewFile: true,
  treeEntryOpensNewFile: true,
  sameModalContract: true,
  tabs: ["basic", "user", "market"],
  basicHasSixSeeds: true,
  newProjectHasNoTemplateTabs: true,
  newProjectHasParentAndNameOnly: true,
}
```

Use stable selectors added by the implementation: `.toolbar-new-file`, `.tree-new-file`, `.new-file-modal`, `[data-new-file-tab]`, and `.new-project-modal`. Run:

```powershell
node scripts/e2e-v087.mjs files
```

Expected current failure: `.tree-new-file` and `.new-file-modal` are absent and New project still renders marketplace tabs.

- [ ] **Step 3: Create the focused New file component**

Use this public interface and return `null` when `open` is false:

```tsx
interface Props {
  open: boolean;
  onClose: () => void;
}

type NewFileTab = "basic" | "user" | "market";

type NewFileModalComponent = (props: Props) => React.ReactElement | null;
```

State must include:

```tsx
const [tab, setTab] = useState<NewFileTab>("basic");
const [filePath, setFilePath] = useState("new-file.tex");
const [fileTemplate, setFileTemplate] = useState("article");
const [userTemplates, setUserTemplates] = useState<UserTemplate[]>([]);
const [marketTemplates, setMarketTemplates] = useState<MarketTemplate[]>([]);
const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
const [targetDir, setTargetDir] = useState("");
const [search, setSearch] = useState("");
const [category, setCategory] = useState(ALL_CATEGORY);
const [downloading, setDownloading] = useState<string | null>(null);
const [busy, setBusy] = useState(false);
const [error, setError] = useState<string | null>(null);
```

On open, load user and market templates. Basic creation calls `api.newFile`, then `refresh`, `openFile(filePath)`, and closes. User/market import calls:

```tsx
const result = await api.importProjectTemplate(targetDir.trim(), selectedTemplate, tab === "user" ? "user" : "market");
await useProjectStore.getState().refresh();
await useProjectStore.getState().openFile(result.main_file);
onClose();
```

On error, keep the selected tab/template/target, render `.modal-error`, and leave the modal open. Use six fixed Basic file options: `article`, `ctexart`, `report`, `beamer`, `minimal`, and empty.

- [ ] **Step 4: Delegate the project-tree entry to App**

Change the tree public contract to:

```tsx
interface ProjectTreeProps {
  onNewFile: () => void;
}

type ProjectTreeComponent = (props: ProjectTreeProps) => React.ReactElement;
```

Add a `.tree-new-file` button in `.panel-actions`, disabled when `root` is empty. Keep Open, New project, and Save as template distinct. Delete the old exported `NewFileModal` block from `ProjectTree.tsx`.

In `App.tsx`, import `NewFileModal` from its new file, render `<ProjectTree onNewFile={() => setNewFileOpen(true)} />`, add `.toolbar-new-file`, and render:

```tsx
<NewFileModal open={newFileOpen} onClose={() => setNewFileOpen(false)} />
```

- [ ] **Step 5: Simplify New project**

Remove template/marketplace imports and state from `NewProjectModal.tsx`. Keep directory browsing, validation, and busy/error handling. Its creation path is exactly:

```tsx
await createProject(parent.trim(), name.trim(), "article");
onClose();
```

Add `className="modal new-project-modal"` and ensure the body contains only parent and name fields.

- [ ] **Step 6: Add translations and modal styles**

Add parallel Chinese/English keys for:

```text
newFile.tabBasic
newFile.tabUser
newFile.tabMarket
newFile.targetDir
newFile.targetRequired
newFile.selectTemplate
newFile.import
newFile.importing
newFile.userEmpty
newFile.marketEmpty
newFile.deleteTemplate
toolbar.more
```

Add `.new-file-modal`, `.new-file-tabs`, `.new-file-tab`, `.new-file-panel`, `.modal-error`, and target-row styles. Reuse `.market-*` card styles without duplicating marketplace geometry.

- [ ] **Step 7: Update the older marketplace UI regression**

In `scripts/e2e-v074.mjs`, open `.toolbar-new-file`, select `[data-new-file-tab="market"]`, and assert marketplace cards/search there. Also assert `.new-project-modal .market-tabs` is absent.

- [ ] **Step 8: Run file workflow tests and build checks**

```powershell
node scripts/e2e-v087.mjs files
node scripts/e2e-v074.mjs
node scripts/e2e-v085.mjs
.\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run build
git diff --check
```

Expected: New file opens from both entries with three tabs, New project has only two fields, and existing basic seeding/market listing remain green.

- [ ] **Step 9: Commit the document workflow**

```powershell
git add scripts/e2e-v074.mjs scripts/e2e-v087.mjs src/App.tsx src/components/NewFileModal.tsx src/components/NewProjectModal.tsx src/components/ProjectTree.tsx src/i18n/index.ts src/styles.css
git commit -m "fix: restore new file template workflow"
```

---

### Task 4: Make the Toolbar and Appearance Popovers Reachable

**Files:**
- Modify: `src/App.tsx:1,132-255,386-510`
- Modify: `src/i18n/index.ts`
- Modify: `src/styles.css:155-220,325-380,457-514`
- Test: `scripts/e2e-v087.mjs`

**Interfaces:**
- Consumes: current theme state/effect, import/export/settings handlers, and CDP real pointer/keyboard helpers.
- Produces: `.toolbar-more`, `.toolbar-more-menu`, one anchored `.theme-picker`, and `node scripts/e2e-v087.mjs theme`.

- [ ] **Step 1: Add failing toolbar geometry and interaction assertions**

For 940x700 and 1280x800, require:

```js
{
  toolbarFits: toolbar.scrollWidth <= toolbar.clientWidth + 1,
  compileVisible: insideViewport('.toolbar-compile'),
  newFileVisible: insideViewport('.toolbar-new-file'),
  themeVisible: insideViewport('.theme-picker-btn'),
  moreVisible: insideViewport('.toolbar-more-btn'),
  settingsVisible: insideViewport('.toolbar-settings'),
}
```

At 940px, require Word import and conditional exports inside `.toolbar-more-menu`. With real `Input.dispatchMouseEvent`, select liquid, dark, and light and require `document.documentElement.dataset.theme` and `localStorage.tb-theme` to match each selection.

Open the theme menu, click `.editor-save-action` or the editor textarea, and require the menu to close while the clicked target keeps focus. Reopen, focus a theme option, send real Escape key events, and require `.theme-picker-btn` to regain focus. Require `document.elementFromPoint(menu-center)` to be inside `.theme-picker-menu`.

Run:

```powershell
node scripts/e2e-v087.mjs theme
```

Expected current failures: toolbar overflows at 940px and pointer hit testing fails for the detached theme menu.

- [ ] **Step 2: Factor secondary actions and overflow state**

Add helpers for Word import and `exportActive(format: "md" | "docx")`. Add:

```tsx
const [toolbarMoreOpen, setToolbarMoreOpen] = useState(false);
const toolbarMoreRef = useRef<HTMLDivElement>(null);
const toolbarMoreTriggerRef = useRef<HTMLButtonElement>(null);
```

Render import/export once inside `.toolbar-more-menu`; at wide widths CSS exposes `.toolbar-secondary` direct controls and hides the overflow duplicates, while at `max-width: 1180px` CSS hides `.toolbar-secondary` and shows `.toolbar-more`.

- [ ] **Step 3: Anchor the appearance trigger and menu in one wrapper**

Import `useRef`. Add:

```tsx
const themePickerRef = useRef<HTMLDivElement>(null);
const themeTriggerRef = useRef<HTMLButtonElement>(null);
```

Render:

```tsx
<div className="theme-picker" ref={themePickerRef}>
  <button
    ref={themeTriggerRef}
    className="btn theme-picker-btn"
    aria-expanded={themePickerOpen}
    onClick={() => setThemePickerOpen((value) => !value)}
  >
    <span className={`theme-swatch swatch-${theme}`} />
    {theme === "liquid" ? t("theme.liquid") : theme === "dark" ? t("theme.dark") : t("theme.light")}
  </button>
  {themePickerOpen && (
    <div className="theme-picker-menu">
      {(["liquid", "dark", "light"] as const).map((id) => (
        <button
          key={id}
          className={`theme-option ${theme === id ? "active" : ""}`}
          onClick={() => {
            setTheme(id);
            setThemePickerOpen(false);
          }}
        >
          {id === "liquid" ? t("theme.liquid") : id === "dark" ? t("theme.dark") : t("theme.light")}
        </button>
      ))}
    </div>
  )}
</div>
```

Replace selector-based dismissal with a `pointerdown` listener that checks `themePickerRef.current?.contains(event.target as Node)`. Escape closes and calls `themeTriggerRef.current?.focus()`. Outside-pointer dismissal never calls `focus()`.

- [ ] **Step 4: Add explicit toolbar and popover layers**

Apply:

```css
.toolbar {
  position: relative;
  z-index: 80;
  min-width: 0;
  overflow: visible;
}
.toolbar-root { flex: 0 1 180px; min-width: 0; }
.toolbar-spacer { min-width: 0; }
.compile-target { flex: 0 1 240px; min-width: 120px; }
.theme-picker, .toolbar-more { position: relative; flex: 0 0 auto; }
.theme-picker-menu, .toolbar-more-menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 100; }
@media (max-width: 1180px) {
  .toolbar { gap: 5px; padding-inline: 6px; }
  .toolbar .btn { padding-inline: 9px; white-space: nowrap; }
  .toolbar-root { max-width: 120px; }
  .compile-target { max-width: 190px; }
  .toolbar-secondary { display: none; }
  .toolbar-more { display: block; }
}
```

The menu backgrounds for liquid/dark/light must retain readable `var(--fg)` text and remain above `.layout`.

- [ ] **Step 5: Run theme/toolbar and preserved UI suites**

```powershell
node scripts/e2e-v087.mjs theme
node scripts/e2e-v086.mjs all
.\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run build
git diff --check
```

Expected: both widths pass toolbar geometry and all real pointer/focus checks; AI/editor regressions remain green.

- [ ] **Step 6: Commit toolbar and theme interaction repair**

```powershell
git add scripts/e2e-v087.mjs src/App.tsx src/i18n/index.ts src/styles.css
git commit -m "fix: make toolbar appearance controls usable"
```

---

### Task 5: Restore the Persistent PDF Pane

**Files:**
- Modify: `src/App.tsx:90-95,581-592`
- Modify: `src/styles.css:189-200,699-710`
- Modify: `scripts/e2e-v084.mjs:88-105`
- Test: `scripts/e2e-v087.mjs`

**Interfaces:**
- Consumes: existing `usePanelSize`, `PdfPreview`, `pdfPath`, and splitter drag behavior.
- Produces: a stable `.col-pdf` width and visible adjacent splitter for every open project.

- [ ] **Step 1: Add failing empty/populated PDF assertions**

In the `pdf` suite at 940x700 and 1280x800, open a project without `.texbutler/build/main.pdf` and require:

```js
{
  paneVisible: pdfRect.width >= 240,
  titleVisible: text('.col-pdf .panel-title').length > 0,
  emptyVisible: isVisible('.col-pdf .pdf-empty'),
  dividerVisible: dividerRect.width >= 6,
  iframeAbsent: !document.querySelector('.col-pdf iframe'),
}
```

Drag the PDF divider 40px using real CDP mouse press/move/release and require the pane width and `localStorage.tb-pdf-w` to change by approximately 40px.

Create a minimal fixture PDF at `.texbutler/build/main.pdf`, call `useProjectStore.getState().refresh()`, and require the same pane to contain `.pdf-frame` without resetting its width.

Run:

```powershell
node scripts/e2e-v087.mjs pdf
```

Expected current failure: empty pane width is zero and the divider is hidden.

- [ ] **Step 2: Keep PDF width and divider independent of `pdfPath`**

Change the default width to a narrower fixed value:

```tsx
const pdf = usePanelSize(
  "tb-pdf-w",
  360,
  240,
  Math.round((window.innerWidth || 1400) * 0.7),
);
```

Render the divider without visibility styling and render:

```tsx
<aside className={`col-pdf ${pdfPath ? "has-pdf" : "no-pdf"}`} style={{ width: pdf.size }}>
  <PdfPreview revision={pdfRev} page={pdfPage ?? undefined} />
</aside>
```

- [ ] **Step 3: Remove the zero-pane visual special case**

Keep `.no-pdf` only as a visual-state hook; remove its `border-left: none`. Preserve the liquid empty-pane translucency and populated-pane opacity. Do not change `PdfPreview.tsx`; it already owns the correct title/empty/iframe switch.

- [ ] **Step 4: Update the earlier PDF regression expectation**

In `scripts/e2e-v084.mjs`, replace `pdfW <= 2` with a visible empty PDF contract: width at least 240px, `.pdf-empty` visible, divider visible, editor still at least 150px, and narrow-window AI rail collapsed.

- [ ] **Step 5: Run PDF and full UI verification**

```powershell
node scripts/e2e-v087.mjs pdf
node scripts/e2e-v084.mjs
node scripts/e2e-v086.mjs all
node scripts/e2e-v087.mjs all
.\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run build
git diff --check
```

Expected: empty and populated PDF states share one draggable pane, and the prior responsive AI/editor suite remains green.

- [ ] **Step 6: Commit the PDF regression repair**

```powershell
git add scripts/e2e-v084.mjs scripts/e2e-v087.mjs src/App.tsx src/styles.css
git commit -m "fix: keep PDF preview pane available"
```

---

### Task 6: Full Verification, Git Review, and 0.7.0b Test Packaging

**Files:**
- Modify only if a scoped defect is exposed by verification.
- Produce ignored artifacts in: `release/0.7.0b/`

**Interfaces:**
- Consumes: all completed source commits and the existing Tauri NSIS/MSI bundle configuration.
- Produces: passing verification, a clean source diff, updated 0.7.0b installers, checksums, and build metadata.

- [ ] **Step 1: Run all required automated verification**

With a Tauri dev window running on CDP port 9336:

```powershell
node scripts/e2e-v087.mjs all
node scripts/e2e-v086.mjs all
node scripts/e2e-v085.mjs
node scripts/e2e-v084.mjs
node scripts/e2e-v074.mjs
.\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run build
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: every command exits `0`; no E2E fixture remains under `assets/e2e/v087-check`.

- [ ] **Step 2: Inspect the final source and Git state**

```powershell
$headHash = git rev-parse 'HEAD:src-tauri/Cargo.toml'
$workHash = git hash-object 'src-tauri/Cargo.toml'
git status --short --branch
git log -10 --oneline
git diff --stat HEAD~5..HEAD
```

Expected: `$headHash -eq $workHash`; the only visible Cargo modification is line-ending/index noise; all implementation files are committed; ignored `release/` artifacts do not appear.

- [ ] **Step 3: Perform focused visual QA**

Inspect 940x700 and 1280x800 in liquid, dark, and light themes. Verify the toolbar, both New file entry points, all three New file tabs, the simplified New project modal, the appearance menu pointer target, the empty PDF pane, the populated PDF iframe, and the existing AI/editor menus. Fix only defects directly covered by the approved specification, then rerun Step 1.

- [ ] **Step 4: Prepare clean release output**

Remove only the existing ignored contents of the exact validated directory `D:\reasonix program\idea\tex\release\0.7.0b`, recreate it, and do not touch other release versions.

Build NSIS with internal version `0.7.0-b` and MSI with Windows-compatible internal version `0.7.0.1`. Apply temporary version edits only to `src-tauri/tauri.conf.json`, restore the exact original `0.7.0` content immediately after each build, and verify its Git hash matches HEAD before continuing.

Copy/rename the outputs to:

```text
D:\reasonix program\idea\tex\release\0.7.0b\TeXButler_0.7.0b_x64-setup.exe
D:\reasonix program\idea\tex\release\0.7.0b\TeXButler_0.7.0b_x64_en-US.msi
```

- [ ] **Step 5: Write checksums and build metadata**

Generate SHA-256 values with `Get-FileHash` and write `SHA256SUMS.txt`. Write `BUILD-INFO.txt` containing:

```text
TeXButler 0.7.0b test build
Date: 2026-08-08
Source branch: codex/fix-ui-ai-layout
Source commit: <exact git rev-parse HEAD>
NSIS internal version: 0.7.0-b
MSI internal product version: 0.7.0.1
Both installers are unsigned test artifacts.
```

- [ ] **Step 6: Verify release artifacts and final repository cleanliness**

```powershell
Get-ChildItem 'D:\reasonix program\idea\tex\release\0.7.0b' | Select-Object Name,Length,LastWriteTime
Get-FileHash 'D:\reasonix program\idea\tex\release\0.7.0b\TeXButler_0.7.0b_x64-setup.exe' -Algorithm SHA256
Get-FileHash 'D:\reasonix program\idea\tex\release\0.7.0b\TeXButler_0.7.0b_x64_en-US.msi' -Algorithm SHA256
git diff --check
git status --short --branch
```

Expected: both installers are non-empty, checksums match `SHA256SUMS.txt`, the build-info commit matches `HEAD`, tracked version files equal HEAD, and no source change remains unstaged or uncommitted.
