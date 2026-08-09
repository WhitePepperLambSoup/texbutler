# File-Scoped AI and Current-Directory Workflow Design

Date: 2026-08-09
Branch: `codex/fix-ui-ai-layout`
Status: Approved in conversation

## Summary

This repair addresses four related workflow failures:

1. AI chat can emit `read_file`, but the chat executor only recognizes edit tools and reports it as unknown.
2. A compile issue can carry a truncated Windows path such as `t/my-latex-project/contents/abstract.tex`; one-click fix then treats that string as a project-relative path and cannot read the real file.
3. New-file and template-import workflows ask the user for paths even though their destination should be the directory containing the active editor file.
4. Per-file AI sessions have a persistence skeleton, but opening an unbound file does not create a conversation and bindings are not scoped by project root.

The repair also makes the editor-tools and AI-actions menus substantially less transparent in the liquid theme. Runtime chat data remains in application-local browser storage and is not written into the LaTeX project.

This specification supersedes the target-path behavior in `2026-08-08-ui-workflow-regressions-design.md`. Its safety guarantees for template containment, collision handling, and cleanup remain required.

## Evidence and Root Causes

### AI tool execution

- `src-tauri/src/core/ai/chat.rs` advertises only `insert_before`, `insert_after`, `replace`, and `delete_line`.
- The model can still emit the common `read_file` spelling. The parser accepts the JSON object, but `compute_tool_call` rejects the unrecognized name.
- The executor is currently terminal: it parses one model reply and applies edits. It has no read-result round trip that can return file contents to the model and let it continue.

### Compile-issue paths

- `log_parser.rs` extracts file paths without project context. Windows paths containing spaces or non-ASCII prefixes can arrive as usable absolute paths, relative paths, or truncated suffixes.
- `Project::relative_path` only strips the project root from a complete project-internal absolute path.
- `ensure_project_file` accepts any lexically contained, possibly nonexistent path because `Project::resolve` is designed to support new-file writes.
- `fix_loop` then reads the uncorrected path directly and reports `无法读取文件 ...，放弃修复`.

### New-file destination

- `NewFileModal` stores a free-form `filePath` for basic files and a required `targetDir` for user/market templates.
- The project store already exposes `activeTab`, so the intended current directory can be derived without asking the user for a path.
- Template imports are staged and atomically renamed into a new directory today. Importing into an existing current directory requires a separate collision-first merge transaction.

### File-scoped sessions

- `aiStore.ts` persists conversations under `tb-ai-sessions` and file bindings under `tb-ai-file-sessions`.
- `attachFile` restores an existing binding, but it leaves a newly opened file on the previous conversation instead of creating a new one.
- Binding keys contain only the relative file path, so two projects with `main.tex` can share the wrong conversation.
- Closing an editor tab does not need to delete a conversation, but no explicit project-and-file identity currently guarantees later restoration.

### Menu transparency

- `.editor-tools-menu` and `.ai-menu` use `var(--bg3)`.
- In the liquid theme, `--bg3` is `rgba(255, 255, 255, 0.07)`, so underlying content competes with menu text.

## Goals

- Make `read_file` a real, safe project-document read operation that can feed a bounded continuation back to the model.
- Resolve compile-issue and AI-provided paths to a canonical project-relative file before reading or editing.
- Create files and import templates into the active file's directory without asking for a path.
- Automatically create one persistent AI conversation the first time a `.tex` file is opened in a project, then restore it on later visits and restarts.
- Keep older conversations available and never delete them merely because a file tab or the application closes.
- Make both overflow menus readable in liquid, dark, and light themes.
- Preserve containment, no-overwrite, rollback, focus, and cleanup guarantees.

## Non-goals

- Formal provider-specific function-calling APIs.
- Reading arbitrary operating-system files or non-document project files.
- Cloud synchronization or writing chat history into the project.
- Automatically merging or overwriting template files with the same names.
- A general project-tree directory-selection model.
- Redesigning the AI panel, editor toolbar, template catalog, or theme system beyond the requested behavior.

## Design

### 1. Canonical project-document resolution

Add one backend resolver with a narrow contract: given a model/log path and an existing open project document, return a canonical forward-slash project-relative path or a precise error.

Resolution order is deterministic:

1. An exact existing project-relative file.
2. A complete absolute path that canonicalizes inside the project root.
3. A unique component-boundary suffix match among eligible project files. This handles a truncated prefix that still contains `contents/abstract.tex`.
4. A unique basename match as the final correction.

The resolver accepts only regular `.tex`, `.bib`, `.sty`, and `.cls` files. It rejects parent traversal, external absolute paths, symlink escape, missing files, and ambiguous suffix/basename matches. It never silently picks the first match.

One-click diagnosis context, one-click fix, chat `read_file`, and chat edit calls use this resolver before file I/O. `ensure_project_file` must validate an existing readable file through the resolver rather than relying on lexical `resolve` alone. User-facing issue locations and fix reports use the canonical relative path once resolved.

### 2. Bounded `read_file` conversation tool

Keep the existing declarative JSON protocol and add `read_file` to its documented schema. A read call has this shape:

```json
{"tool":"read_file","file":"contents/abstract.tex"}
```

The chat loop separates read calls from edit calls:

- Resolve and read each requested document through the canonical resolver.
- Cap returned file content to the existing AI context budget and label truncation explicitly.
- Append the assistant's tool request and a system-owned read result to a continuation request.
- Let the model answer or emit the existing safe edit tools using the fresh content.
- Allow at most two read-continuation rounds per user request. A third read request returns a concise limit error instead of looping.

Read operations never write or snapshot files. Edit tools retain their current extension allowlist, snapshot-before-write behavior, rollback event, and compile follow-up. Unknown tool names return an error that lists the allowed names. The backend's final returned text must match the concatenated streamed text so the frontend does not replace the live message with inconsistent content.

### 3. Current-directory new-file workflow

Define `currentDirectory(activeTab)` as the normalized parent directory of the active editor path. A root-level file yields an empty relative directory; no active file also falls back to the project root.

For the Basic tab:

- Replace the free-form path with a file-name-only input.
- Reject empty names, `.`/`..`, `/`, `\\`, and invalid backend path components.
- Join the validated name to `currentDirectory` and call the existing new-file command.
- Show the resolved destination as non-editable context text so the user can see where the file will be created without typing a path.
- Refresh the project tree and open the new file after success.

For My Templates and Template Market:

- Remove the target-directory input.
- Stage the selected template outside the destination exactly as today and verify its main document and safe tree first.
- Enumerate every staged destination under `currentDirectory` before writing anything.
- Existing directories may be reused so a template can add new descendants. An existing file at a staged file path, or a file/directory type mismatch at any path, is a conflict. If any conflict exists, abort the entire import and list it; existing project content remains untouched.
- If there are no conflicts, copy the staged tree into the existing current directory while recording every created file and directory.
- If a later operation fails, remove only entries created by this import, in reverse order. Never remove or alter pre-existing entries.
- Return and open the imported main document at its new canonical relative path.

Internal template directory structure is preserved. Excluded directories and files, symlink rejection, containment checks, staging cleanup, AppData template-source isolation, and failure propagation remain unchanged.

### 4. Project-and-file-scoped AI sessions

Use a versioned binding key derived from the canonical project root and relative file path. The key is an implementation detail, but its identity is exactly `(projectRoot, relativeFile)`; separators and Windows path casing must be normalized consistently.

When the active editor file changes:

- If it is a `.tex` file with a valid scoped binding, switch to that persisted session.
- If it is a `.tex` file without a valid binding, create and persist a new empty session immediately, name it from the file basename, bind it, and select it.
- Revisiting the same file restores the same session instead of creating another.
- Opening a same-named file in a different project creates or restores a different session.
- Closing a tab, closing a project, or exiting the application does not delete its session or binding.

Manual behavior remains available:

- New conversation creates a fresh session and binds it to the current `.tex` file.
- Selecting another session explicitly rebinds the current `.tex` file.
- Deleting a session removes every binding to that session; returning to an affected file creates a fresh session.
- Clearing a conversation persists the empty message list instead of only clearing in-memory state.

Existing `tb-ai-sessions` history is retained. Legacy unscoped file bindings are not guessed into a project because doing so can cross-bind two projects; their conversations remain selectable from the session list. The new scoped binding store is written separately or under a versioned schema so corrupt/legacy data can fall back safely.

Local-storage writes remain best effort. If storage is unavailable, the current process still gets correct per-file isolation, but the UI must not claim persistence across restart.

### 5. Menu readability

Keep the existing geometry, stacking, pointer dismissal, Escape handling, and focus restoration. In liquid mode only, give `.editor-tools-menu` and `.ai-menu` a theme-aware background equivalent to approximately 94% opaque `--bg`, with a small accent/glass tint and the existing border/shadow. The panel may keep backdrop blur, but content behind it must not materially reduce text contrast.

Dark and light modes continue to use opaque theme surfaces. Normal, disabled, danger, hover, and focused menu-item text must meet the existing contrast threshold used by the UI regression suite.

## Data Flow

### AI read and edit

1. Frontend sends question, active file, selection, and recent session history.
2. Backend injects current file content and the declarative tool contract.
3. Model optionally requests `read_file`.
4. Backend resolves the path, reads a bounded document body, and issues a continuation.
5. Model answers or emits edits.
6. Backend resolves edit paths, snapshots, writes, emits rollback metadata, and returns a clean user-facing answer. Declarative tool JSON and internal read results are removed from the finalized message; the frontend may show a concise read-progress status while the continuation runs.
7. Frontend refreshes clean editor tabs and persists the finalized message in the active scoped session.

### File open and session restore

1. `projectStore` completes `openFile` and changes `activeTab`.
2. The application passes both current project root and active tab to the AI store.
3. The AI store restores a valid scoped binding or creates a new file session.
4. Messages and session selection update together, then the binding/session stores persist.

### New file or template

1. Modal derives the current directory from the active tab.
2. User supplies only a basic filename or selects a template.
3. Backend validates/stages and performs a collision-first create/import.
4. Frontend refreshes the tree and opens the returned file.
5. The active-tab transition automatically creates or restores that file's AI conversation.

## Error Handling and Safety

- Ambiguous path correction is an error and names the ambiguity; it never edits a guessed file.
- A failed `read_file` is returned to the model once as a tool error so it can answer without pretending the file was read.
- Tool read limits, content caps, editable extensions, project containment, and symlink containment are enforced by backend code, not prompts.
- A template conflict is detected before destination writes. A mid-import failure rolls back only newly created entries and preserves the original failure.
- File creation never accepts a path separator from the filename field.
- Session creation and switching are synchronous store transitions so no message can be persisted into the outgoing file's session during a tab change.
- AI conversation storage contains messages and bindings only; it does not modify the LaTeX project or add Git-tracked files at runtime.

## Testing

### Rust unit and integration coverage

- Exact relative, internal absolute, truncated unique suffix, and unique basename path resolution.
- Ambiguous basename/suffix, outside absolute path, parent traversal, missing file, unsupported extension, and symlink escape rejection.
- Compile issue with `t/my-latex-project/contents/abstract.tex` resolving to `contents/abstract.tex` before diagnosis and fix.
- `read_file` parsing, bounded continuation, content truncation, unknown-tool messaging, and read-to-edit flow.
- Current-directory template import success, nested tree preservation, conflict-before-write, partial-failure rollback, and original error propagation.

### Frontend and real-browser coverage

- Root and nested active-file directories produce the correct new-file destination with no editable path field.
- User and market template tabs expose no target-directory input and import into the active directory.
- Opening two `.tex` files creates two sessions; switching restores each file's messages; old sessions remain listed.
- Reloading the application restores the project/file binding and messages.
- Two projects containing the same relative filename never share a binding.
- Manual new/select/delete/clear operations update bindings and persisted messages correctly.
- Editor-tools and AI-actions menus retain geometry and focus behavior while meeting opacity and contrast assertions in liquid, dark, and light themes.
- E2E fixtures, localStorage, AppData template roots, browser state, and generated project content are restored even when the test fails.

### Full verification

- Focused RED tests before each production change.
- Rust test suite.
- TypeScript type check.
- Frontend production build.
- Existing `e2e-v086` and `e2e-v087` suites plus the new regressions.
- `git diff --check` and a final whole-branch review.

## Git and Delivery

Implementation commits should be small and reviewable: backend path/tool support, current-directory creation/import, scoped session behavior, menu styling, and regression tests may be separate commits where dependencies allow. Do not stage the known `src-tauri/Cargo.toml` line-ending noise. After focused reviews and a final whole-branch review pass, rebuild the requested `0.7.0b` artifacts into `D:\reasonix program\idea\tex\release\0.7.0b` only when the user asks for a refreshed package.
