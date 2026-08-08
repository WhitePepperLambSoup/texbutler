# UI Workflow Regression Repair Design

Date: 2026-08-08
Branch: `codex/fix-ui-ai-layout`
Status: Approved in conversation

## Summary

This repair restores three user-visible workflows that are currently misleading or unavailable:

1. **New file is the document/template workflow.** Built-in single-file seeds, saved user templates, and the template marketplace move out of the new-project dialog and into the new-file dialog. New project becomes a small, predictable operation that creates a normal project with an article-based `main.tex`.
2. **Appearance controls are reliably clickable.** The top toolbar must keep the appearance trigger reachable at the minimum supported window width, and the theme popover must sit above the workspace with correct pointer and keyboard dismissal behavior.
3. **The PDF panel remains present.** An open project always shows the PDF pane. Before a successful compile it shows the existing empty state; after compilation it shows the PDF viewer. The divider remains draggable in both states.

The work must preserve the responsive AI and editor-menu fixes already committed on this branch.

## Evidence and Root Causes

### New-file/template workflow

- `App.tsx` contains a top-toolbar new-file button and owns `NewFileModal`, but the project-tree header removed its earlier new-file action in commit `c870882`.
- `NewFileModal` currently offers only six built-in single-file seeds.
- `NewProjectModal` owns the basic/user template library and the entire marketplace, including download and multi-file extraction.
- Marketplace templates are often multi-file directory trees, so moving only the existing JSX would be unsafe. Importing a marketplace item into an open project needs an explicit backend operation with containment, collision, cleanup, and main-file detection guarantees.

### Appearance picker

- The global toolbar has more controls than fit reliably at the 940px minimum window width; the new-file and appearance controls can be pushed to the right edge or beyond it.
- The theme trigger and `.theme-picker` are sibling flex items. `.theme-picker` has no in-flow content because its menu is absolute, leaving a zero-sized containing block.
- In liquid mode the toolbar creates a backdrop-filter stacking context, while the workspace is painted after it. The popover has a local `z-index`, but the toolbar itself has no explicit layer above the workspace.
- Outside-click detection treats only `.theme-picker` as internal, not the trigger that controls it.

### PDF panel

- Commit `7061bd8` changed the PDF pane width to `pdfPath ? pdf.size : 0` and hides its divider when `pdfPath` is absent.
- `PdfPreview` already has a complete no-PDF empty state, but that state cannot be seen because its parent pane is zero-width.

## Goals

- Make new file unmistakably available from both the main toolbar and project tree.
- Put built-in single-file templates, saved user templates, and the marketplace in the new-file workflow.
- Import multi-file marketplace templates into the current project without switching the project root.
- Keep new-project creation simple and deterministic.
- Keep all essential top-toolbar controls reachable at 940px without page-level horizontal overflow.
- Make liquid/dark/light theme selection work with real pointer input and keyboard dismissal.
- Show an empty or populated PDF pane whenever a project is open.
- Preserve panel resizing, stored sizes, AI layout, editor overflow tools, contrast, and focus restoration behavior.

## Non-goals

- Redesigning the template catalog or download format.
- Allowing marketplace imports to overwrite existing files or directories.
- Adding a new PDF renderer, PDF collapse feature, or docking system.
- Redesigning the entire theme system or visual language.
- Changing AI behavior, compilation semantics, or editor commands unrelated to these regressions.

## Design

### 1. File creation and template marketplace

#### Entry points

- The main toolbar keeps a clearly labeled `New file` action.
- The project-tree header restores a compact, clearly labeled new-file action. It calls an `onNewFile` callback supplied by `App`, so `App` remains the single owner of modal state.
- The project-tree new-project action remains available but is labeled separately; it must never masquerade as new file.

#### Component boundaries

- Create `src/components/NewFileModal.tsx` and move the exported modal out of `ProjectTree.tsx`.
- `NewFileModal` owns file-name state, built-in template selection, saved-template state, marketplace search/filter/download state, import target state, progress, and error presentation.
- `NewProjectModal.tsx` retains only parent-directory browsing, project name, cancellation, and creation.
- `ProjectTree.tsx` renders tree controls and delegates modal opening to `App`; it does not own template state.

#### New-file modes

The modal has three explicit tabs:

1. **Basic file**
   - Input: project-relative file path, default `new-file.tex`.
   - For `.tex`, offer article, ctexart, report, beamer, minimal, and empty seeds.
   - For other extensions, create an empty file.
   - Use the existing `tb_new_file` command and open the created file.

2. **My templates**
   - Show templates previously created by Save as template.
   - Input: project-relative target directory, defaulting from the saved template name.
   - Import the complete saved template tree under that new directory.
   - Save as template now stores the complete current project tree, including source files, bibliography files, classes/styles, and referenced assets. It excludes `.texbutler`, `.git`, `node_modules`, and `target`, and rejects source trees containing symbolic links rather than following them.
   - Continue listing and importing legacy `<name>.tex` user templates by treating each as a one-file template whose main document is `main.tex`.
   - User-template deletion remains available here and is removed from New project.

3. **Template marketplace**
   - Show the existing marketplace search, category filter, metadata, verified/ready state, and download-on-demand behavior.
   - Input: project-relative target directory, defaulting from the selected template slug/name.
   - Import the complete template tree under that new directory.
   - Refresh the current project tree and open the detected main `.tex` file inside the imported directory.
   - The current project root remains unchanged.

#### Backend import contract

Add a project-scoped command with a typed result equivalent to:

```text
tb_import_project_template(target_dir, template_id, source)
  -> { target_dir: string, main_file: string }
```

Requirements:

- A project must already be open.
- `target_dir` is relative to the current project root.
- Reject absolute paths, traversal, dangling/symlink escape, empty names, existing targets, and targets outside the project.
- `source` is a closed enum equivalent to `user | market`; unknown values are rejected.
- Resolve user templates from the new directory-based storage first, with the legacy single-`.tex` format as a compatibility fallback.
- Reuse the downloaded/built-in marketplace-template resolution plus archive safety checks.
- Copy into a temporary sibling directory first, validate the extracted tree and detect its main document, then rename into place.
- On failure, remove only the command-created temporary directory and leave the project unchanged.
- Return `main_file` relative to the current project root so the existing `openFile` API can use it directly.

#### Saved-template storage

- Store a new user template as `%APPDATA%/texbutler/templates/<validated-name>/`, using a temporary sibling directory followed by rename so a failed save cannot leave a partially written template.
- Keep the existing template-name validation and reject collisions with either a legacy `<name>.tex` template or a directory template. The user can delete the existing template explicitly before saving a replacement.
- Listing merges directory templates and legacy `.tex` templates without duplicate IDs; deletion removes exactly the resolved user-template entry.
- New-project creation no longer resolves user templates, so this storage migration is isolated to Save as template and New file > My templates.

#### New project

- The dialog asks only for parent directory and project name.
- Creation uses the existing project command with the built-in `article` template.
- The created project opens normally with `main.tex` selected by the existing project-store behavior.
- No marketplace, user-template deletion, category filtering, or template download controls remain in this dialog.

### 2. Responsive top toolbar and appearance popover

#### Toolbar priorities

At the minimum supported 940px window width, the toolbar keeps these controls directly visible:

- brand/current project context;
- compile target;
- compile/cancel;
- new file;
- appearance;
- more/settings access.

Word import and conditional Markdown/Word export actions move into a compact top-toolbar overflow popover when space is constrained. They remain enabled/disabled by the same state rules and retain their existing commands.

The toolbar must have no horizontal scroll and no required control may render outside the viewport.

#### Theme popover structure

- Render the appearance trigger and menu inside one `.theme-picker` wrapper.
- Give the wrapper in-flow dimensions through its trigger; position the menu below that trigger.
- Give the toolbar an explicit positioned stacking layer above the workspace and keep overflow visible for popovers.
- Use a ref for the wrapper in outside-pointer detection rather than relying on a selector that excludes the trigger.
- Theme options remain native buttons with the existing labels and swatches.

#### Interaction rules

- Clicking the trigger opens or closes the popover.
- Clicking liquid, dark, or light applies the theme, persists `tb-theme`, updates Monaco through the existing theme event path, and closes the popover.
- An outside pointer press closes the popover without forcing focus back to the trigger.
- Escape closes the popover and restores focus to the appearance trigger.
- The menu stays inside the viewport at 940px and 1280px and receives pointer hits rather than the workspace beneath it.

### 3. Persistent PDF pane

- Whenever `root` exists, render `.col-pdf` at the persisted `pdf.size`, regardless of `pdfPath`.
- Keep the PDF divider visible and draggable in both the empty and populated states.
- `PdfPreview` continues to render its existing title and empty message when `pdfPath` is absent.
- After a successful compile, the same pane replaces the empty body with the iframe without changing ownership or resetting the stored width.
- Use a narrower fixed/default PDF width suitable for the current four-column shell instead of the previous 38% default, while retaining the existing min/max drag limits.
- At 940px the existing AI auto-collapse behavior remains in force, leaving usable editor width alongside tree and PDF panes.

## Error Handling

- New-file collision and invalid relative paths show a clear error and keep the modal open.
- Saved-template or marketplace download/import failure keeps the selected template and target name so the user can retry.
- Saving a user template fails clearly on name collision, excluded-root/symlink validation, or copy failure and does not replace an existing saved template.
- A failed saved-template or marketplace import never switches projects and never leaves a partially imported final directory.
- If a downloaded template has no detectable `.tex` main document, reject the import and remove its temporary extraction.
- Theme selection must not throw if localStorage is unavailable; it follows the existing best-effort persistence behavior.
- PDF empty state is not an error state and remains visible after failed or cancelled compilation.

## Testing Strategy

### Frontend real-interaction regression test

Add `scripts/e2e-v087.mjs` using the existing CDP harness and real `Input.dispatchMouseEvent`/keyboard events. It must first fail on the current branch and then cover:

- 940px and 1280px toolbar geometry, required control visibility, and zero horizontal toolbar overflow;
- project-tree and toolbar new-file entry points opening the same new-file modal;
- new-file modal containing Basic file, My templates, and Template marketplace tabs;
- new-project modal no longer containing marketplace controls;
- real pointer selection of liquid, dark, and light, including persisted `tb-theme`;
- outside-pointer dismissal preserving clicked-target focus;
- Escape dismissal restoring appearance-trigger focus;
- theme menu geometry and hit testing above the workspace;
- PDF pane/title/empty state and draggable divider with no PDF;
- the same PDF pane containing the iframe after a fixture PDF becomes available;
- existing AI/editor layout checks remaining green.

### Rust tests

Add focused tests for the project-scoped template import command/helper:

- rejects traversal and absolute target paths;
- rejects existing targets;
- rejects symlink/dangling-symlink escape where supported;
- imports valid saved-template and marketplace multi-file fixtures and returns project-relative main files;
- saves directory-based user templates with referenced assets, excludes internal/generated directories, and keeps legacy single-file templates listable/importable/deletable;
- cleans its temporary directory after validation/copy failure;
- leaves the current project root unchanged.

### Standard verification

- `node scripts/e2e-v087.mjs all`
- `node scripts/e2e-v086.mjs all`
- `tsc --noEmit`
- `npm run build`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `git diff --check`

## Acceptance Criteria

- A user with an open project can always find and activate New file from the toolbar and project tree.
- Saved user templates and the template marketplace are present in New file and absent from New project.
- Importing a saved or marketplace template creates a contained subdirectory, keeps the same project open, refreshes the tree, and opens its main `.tex`.
- New project creates and opens an article-based `main.tex` without showing marketplace UI.
- At 940px, New file, appearance, compile, and overflow/settings access remain visible and usable.
- Every theme option responds to a real pointer click; Escape and outside-click behavior follow the stated focus rules.
- The PDF pane remains visible before compilation, after compilation failure, and after successful compilation.
- No fix regresses the responsive AI panel, editor overflow menu, symbol picker, contrast, or focus-restoration behavior already covered by `e2e-v086`.
