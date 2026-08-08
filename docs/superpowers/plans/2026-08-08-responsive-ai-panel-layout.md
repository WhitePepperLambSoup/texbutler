# Responsive AI Panel Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate editor-toolbar clipping and rebuild the AI conversation panel so its controls, messages, suggestions, and composer remain aligned and usable at every supported panel width.

**Architecture:** Keep the existing outer flex workspace and Zustand/Tauri data flow. Give `AiPanel` and `EditorPane` dedicated compact headers with local overflow-menu state, move AI supplemental content into the message scroller, and verify the DOM geometry through the repository's existing CDP E2E pattern.

**Tech Stack:** React 18, TypeScript 5.7, Zustand 5, CSS, Tauri 2/WebView2 CDP, Node.js E2E scripts, `lucide-react`.

## Global Constraints

- AI panel widths from 240px through 520px must keep every action accessible.
- Preserve all existing AI session, token, suggest-mode, snapshot, guide, diff, rollback, streaming, and file-binding behavior.
- Preserve editor insert, translation, polish, split, save, and SyncTeX command behavior.
- Do not change Zustand state contracts or Tauri command/event contracts.
- Keep AI collapsed behavior at 34px and keep `tb-ai-rail` / `tb-ai-w` persistence.
- Use `lucide-react` icons with `title` and `aria-label` on icon-only buttons.
- Do not commit screenshots, browser state, generated projects, or other E2E artifacts.

## File Structure

- Create `scripts/e2e-v086.mjs`: CDP geometry regression suite with independent `ai`, `editor`, and `all` modes.
- Modify `package.json` and `package-lock.json`: add `lucide-react` as the only new runtime dependency.
- Modify `src/App.tsx`: render the expanded AI collapse control inside `AiPanel`; retain the collapsed 34px rail entry.
- Modify `src/components/AiPanel.tsx`: add the dedicated two-row header, overflow menu, unified scroll region, and full-width composer.
- Modify `src/components/Editor.tsx`: reduce the persistent header to tabs plus three primary actions and place the remaining existing controls in a bounded menu.
- Modify `src/i18n/index.ts`: add menu and compact-status labels in Chinese and English.
- Modify `src/styles.css`: define bounded headers, menus, scroll behavior, icon buttons, message spacing, and composer/editor containment.

---

### Task 1: Add Layout Regression Coverage and Prove RED

**Files:**
- Create: `scripts/e2e-v086.mjs`
- Reference: `scripts/e2e-v084.mjs`

**Interfaces:**
- Consumes: a running Tauri development window with WebView2 CDP on port `9336`.
- Produces: `node scripts/e2e-v086.mjs ai|editor|all`, exiting `0` only when the selected geometry contract passes.

- [ ] **Step 1: Create the CDP test harness**

Implement the same explicit CDP connection used by `e2e-v084.mjs`, but wrap the generated project in `try/finally` so it is removed after both pass and failure. The script must accept a suite argument:

```js
const suite = process.argv[2] ?? "all";
if (!new Set(["ai", "editor", "all"]).has(suite)) {
  throw new Error(`unknown suite: ${suite}`);
}
```

Create `assets/e2e/v086-check/main.tex`, connect to port `9336`, enable `Runtime`, and define these helpers with exact behavior:

```js
const exec = async (expr) => {
  const r = await c.send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

async function loadCase(width, height, aiWidth, withPdf, withSuggestion) {
  await c.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await exec(`(async () => {
    localStorage.setItem('tb-ai-rail', '1');
    localStorage.setItem('tb-ai-w', ${aiWidth});
    localStorage.removeItem('tb-tree-w');
    localStorage.removeItem('tb-pdf-w');
    localStorage.removeItem('tb-bottom-h');
    location.reload();
    return true;
  })()`);
  await sleep(1800);
  await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const { useAiStore } = await import('/src/store/aiStore.ts');
    await useProjectStore.getState().openProject(${JSON.stringify(PROJ)});
    await useProjectStore.getState().openFile('main.tex');
    if (${withPdf}) {
      useProjectStore.setState({ pdfPath: ${JSON.stringify(PROJ + "/build/main.pdf")} });
    }
    const messages = [
      { id: 8601, role: 'user', kind: 'plain', text: '请检查当前论证结构并给出修改建议。' },
      { id: 8602, role: 'assistant', kind: 'plain', text: '先明确研究问题，再说明方法与证据，最后收束结论。\\n术语需要保持一致。' },
      { id: 8603, role: 'user', kind: 'plain', text: '请给出更具体的修改顺序。' },
      { id: 8604, role: 'assistant', kind: 'plain', text: '建议按背景、问题、方法、结果、贡献的顺序重组段落。' },
    ];
    useAiStore.setState({
      messages,
      activeFile: 'chapters/very-long-methodology-section.tex',
      diffPending: ${withSuggestion ? `{
        ok: true,
        rounds: 2,
        summary: '建议修改',
        issues_after: [],
        rolled_back: false,
        suggested: true,
        hunks: [
          { file: 'main.tex', line: 12, old: '旧段落', new: '新段落', why: '收紧论证' },
          { file: 'main.tex', line: 28, old: '旧术语', new: '统一术语', why: '保持一致' },
        ],
      }` : "null"},
    });
    return true;
  })()`);
  await sleep(500);
}
```

- [ ] **Step 2: Add AI geometry assertions**

For `(960, 700, 240, false, true)`, `(1280, 800, 300, false, false)`, and `(1600, 900, 520, false, false)`, evaluate this contract and require every boolean to be true:

```js
(() => {
  const q = (s) => document.querySelector(s);
  const header = q('.ai-header') ?? q('.ai-panel > .panel-header');
  const panel = q('.ai-panel');
  const body = q('.ai-body');
  const row = q('.ai-chat-row');
  const input = q('.ai-generate-input');
  const send = q('.ai-send-action') ?? row?.querySelector('button');
  const diff = q('.ai-diff-bar');
  const hunks = q('.ai-hunks');
  const pr = panel.getBoundingClientRect();
  const ir = input.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  const sr = send.getBoundingClientRect();
  return {
    headerFits: header.scrollWidth <= header.clientWidth + 1,
    panelFits: panel.scrollWidth <= panel.clientWidth + 1,
    bodyUsable: body.getBoundingClientRect().height >= 160,
    inputFillsRow: ir.width >= rr.width - sr.width - 18,
    composerInside: ir.left >= pr.left && sr.right <= pr.right,
    supplementalInBody: !diff || (body.contains(diff) && body.contains(hunks)),
  };
})()
```

- [ ] **Step 3: Add editor geometry and menu assertions**

Load `(1280, 800, 300, true, false)`, then require:

```js
(() => {
  const editor = document.querySelector('.col-editor');
  const header = document.querySelector('.editor-header') ?? editor.querySelector('.panel-header');
  const er = editor.getBoundingClientRect();
  const actions = ['.editor-save-action', '.editor-ask-ai-action', '.editor-more-action']
    .map((s) => document.querySelector(s));
  return {
    headerFits: header.scrollWidth <= header.clientWidth + 1,
    primaryVisible: actions.every((el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.left >= er.left && r.right <= er.right;
    }),
  };
})()
```

Click `.editor-more-action`, wait 100ms, and require `.editor-tools-menu` to remain within `.col-editor`, have `scrollHeight >= clientHeight`, and expose at least 12 `button, select` controls.

- [ ] **Step 4: Run the new suites and verify RED**

Start Tauri in a dedicated terminal:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9336'
npm.cmd run tauri dev
```

Run:

```powershell
node scripts/e2e-v086.mjs ai
node scripts/e2e-v086.mjs editor
```

Expected current failures:

- AI: `headerFits=false`, `inputFillsRow=false`, and the suggestion case has `bodyUsable=false` / `supplementalInBody=false`.
- Editor: `headerFits=false`, `primaryVisible=false`, and `.editor-more-action` is absent.

Do not commit the RED-only state; continue directly to Task 2.

---

### Task 2: Rebuild the AI Conversation Layout

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/App.tsx`
- Modify: `src/components/AiPanel.tsx`
- Modify: `src/i18n/index.ts`
- Modify: `src/styles.css`
- Test: `scripts/e2e-v086.mjs`

**Interfaces:**
- Consumes: existing `useAiStore`, `api`, and `AiRail` width/open state.
- Produces: `AiPanel({ onCollapse }: { onCollapse: () => void })`, `.ai-header`, `.ai-menu`, and `.ai-send-action`.

- [ ] **Step 1: Add the icon dependency**

Run:

```powershell
npm.cmd install lucide-react@^0.468.0
```

Expected: `lucide-react` appears in `dependencies`; no unrelated package upgrades are introduced.

- [ ] **Step 2: Move the expanded collapse control into `AiPanel`**

Update `AiRail` in `src/App.tsx` so the expanded state renders only the panel, while the collapsed state retains the full-height 34px entry:

```tsx
function AiRail({ aiWidth, open, onToggle }: AiRailProps) {
  const t = useT();
  return (
    <aside className={`ai-rail ${open ? "open" : "collapsed"}`} style={open ? { width: aiWidth } : undefined}>
      {open ? (
        <AiPanel onCollapse={onToggle} />
      ) : (
        <button className="ai-rail-toggle" onClick={onToggle} title={t("ai.expand")} aria-label={t("ai.expand")}>
          <Bot size={16} aria-hidden="true" />
          <span>AI</span>
        </button>
      )}
    </aside>
  );
}
```

- [ ] **Step 3: Add AI-local menu state and actions**

Change the `AiPanel` signature and imports:

```tsx
import {
  BookOpenText,
  ChevronRight,
  Eraser,
  FileDiff,
  FileText,
  History,
  MoreHorizontal,
  PanelRightClose,
  Pencil,
  Plus,
  RotateCcw,
  SendHorizontal,
  Trash2,
} from "lucide-react";

export default function AiPanel({ onCollapse }: { onCollapse: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
```

Install a `mousedown` / `Escape` effect while `menuOpen` is true. Move the existing rename, delete, timeline, guide, clear, and usage-reset handlers into `.ai-menu-item` buttons. Busy-sensitive session operations remain disabled while `busy` is true.

- [ ] **Step 4: Replace the generic header with a bounded two-row header**

Render this structure before `.ai-body`:

```tsx
<header className="ai-header">
  <div className="ai-header-main">
    <span className="ai-heading">{t("ai.title")}</span>
    <select className="session-select" value={sessionId ?? ""} disabled={busy}>
      {/* existing scratch and persisted-session options */}
    </select>
    <button className="icon-btn" title={t("ai.sessionNew")} aria-label={t("ai.sessionNew")} disabled={busy}>
      <Plus size={15} aria-hidden="true" />
    </button>
    <div className="ai-menu-anchor" ref={menuRef}>
      <button className="icon-btn" title={t("ai.more")} aria-label={t("ai.more")} aria-expanded={menuOpen}>
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {menuOpen && <div className="ai-menu" role="menu">{/* six existing actions */}</div>}
    </div>
    <button className="icon-btn" title={t("ai.collapse")} aria-label={t("ai.collapse")} onClick={onCollapse}>
      <PanelRightClose size={16} aria-hidden="true" />
    </button>
  </div>
  <div className="ai-context-row">
    <span className="ai-file-badge" title={t("ai.sessionFileTitle")}>
      <FileText size={13} aria-hidden="true" />
      <span>{activeFile ? activeFile.split("/").pop() : t("ai.sessionNoFile")}</span>
    </span>
    {usage && <span className="ai-usage-compact" title={t("ai.usageTitle")}>{t("ai.usageCompact", { n: usage.prompt_tokens + usage.completion_tokens })}</span>}
    <button className={`icon-btn ai-suggest-toggle ${suggestMode ? "active" : ""}`} title={t("ai.suggestMode")} aria-label={t("ai.suggestMode")} aria-pressed={suggestMode}>
      <FileDiff size={15} aria-hidden="true" />
    </button>
  </div>
</header>
```

- [ ] **Step 5: Put supplemental AI content in the main scroller**

Move the existing `diffPending`, suggested hunks, and `snapshots` JSX blocks so they render after `messages.map(...)` and before the closing `.ai-body`. Do not change their API calls or patch construction. The direct children of `.ai-panel` become exactly: `.ai-header`, `.ai-body`, `.ai-generate`.

- [ ] **Step 6: Make the composer fill its row**

Keep the current textarea keyboard handler and replace the send button content with a `SendHorizontal` icon. Add `className="icon-btn btn-primary ai-send-action"`, `aria-label={t("ai.askSend")}`, and keep the existing disabled and click behavior.

- [ ] **Step 7: Add i18n labels**

Add exact keys in both language maps:

```ts
// Chinese
"ai.more": "更多 AI 操作",
"ai.usageCompact": "{n} tokens",
"editor.moreTools": "更多编辑工具",

// English
"ai.more": "More AI actions",
"ai.usageCompact": "{n} tokens",
"editor.moreTools": "More editor tools",
```

- [ ] **Step 8: Add the dedicated AI CSS**

Define fixed, non-overflowing header rows and menu geometry:

```css
.ai-panel { position: relative; width: 100%; overflow: hidden; }
.ai-header { flex: 0 0 auto; min-width: 0; padding: 6px 8px; border-bottom: 1px solid var(--border); background: var(--bg2); }
.ai-header-main, .ai-context-row { display: flex; align-items: center; min-width: 0; gap: 4px; }
.ai-header-main { height: 30px; }
.ai-context-row { height: 24px; margin-top: 3px; }
.ai-heading { flex: 0 0 auto; font-size: 12px; font-weight: 600; }
.ai-header .session-select { flex: 1 1 auto; min-width: 0; max-width: none; margin-left: 2px; }
.icon-btn { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }
.ai-file-badge { flex: 1 1 auto; min-width: 0; max-width: none; display: flex; align-items: center; gap: 4px; }
.ai-file-badge > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-usage-compact { flex: 0 0 auto; font-size: 10px; color: var(--fg-dim); white-space: nowrap; }
.ai-menu-anchor { position: relative; flex: 0 0 auto; }
.ai-menu { position: absolute; top: 32px; right: 0; z-index: 60; width: min(220px, calc(100vw - 24px)); padding: 4px; background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.32); }
.ai-menu-item { width: 100%; min-height: 30px; display: flex; align-items: center; gap: 8px; border: 0; background: transparent; color: var(--fg); text-align: left; }
.ai-body { min-height: 160px; }
.ai-body > .ai-diff-bar, .ai-body > .ai-hunks { flex: 0 0 auto; max-height: none; overflow: visible; }
.ai-chat-row { min-width: 0; }
.ai-generate-input { flex: 1 1 auto; width: 100%; min-width: 0; max-height: min(180px, 35vh); }
.ai-send-action { align-self: flex-end; width: 32px; height: 32px; }
```

Remove the expanded-state assumptions from `.ai-rail-toggle`; it applies only to `.ai-rail.collapsed .ai-rail-toggle` after the JSX change.

- [ ] **Step 9: Run the AI suite and verify GREEN**

Run:

```powershell
node scripts/e2e-v086.mjs ai
```

Expected: all 240px, 300px, and 520px cases report `headerFits`, `panelFits`, `bodyUsable`, `inputFillsRow`, `composerInside`, and `supplementalInBody` as true.

- [ ] **Step 10: Run type/build checks and commit**

Run:

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run build
git diff --check
```

Stage only Task 1/2 files and commit:

```powershell
git add package.json package-lock.json scripts/e2e-v086.mjs src/App.tsx src/components/AiPanel.tsx src/i18n/index.ts src/styles.css
git commit -m "fix: rebuild AI conversation layout"
```

---

### Task 3: Contain the Editor Toolbar in an Overflow Menu

**Files:**
- Modify: `src/components/Editor.tsx`
- Modify: `src/styles.css`
- Test: `scripts/e2e-v086.mjs`

**Interfaces:**
- Consumes: current editor callbacks and `editor.moreTools` i18n key from Task 2.
- Produces: `.editor-header`, `.editor-save-action`, `.editor-ask-ai-action`, `.editor-more-action`, and `.editor-tools-menu`.

- [ ] **Step 1: Add editor-local menu state**

Import `MessageSquareText`, `MoreHorizontal`, and `Save` from `lucide-react`. Add:

```tsx
const [toolsOpen, setToolsOpen] = useState(false);
const toolsMenuRef = useRef<HTMLDivElement>(null);
```

While open, close on outside `mousedown` or `Escape`. Extract the current Ask AI inline handler into `askAboutSelection()` so the primary icon button uses the exact existing selection/store/event behavior.

- [ ] **Step 2: Replace the persistent editor header**

Render only tabs and three fixed actions:

```tsx
<div className="panel-header editor-header">
  <div className="editor-tabs">{/* existing tabs */}</div>
  <div className="panel-actions editor-primary-actions">
    <button className="icon-btn editor-save-action" title={t("editor.save")} aria-label={t("editor.save")} onClick={doSave} disabled={!active?.dirty}>
      <Save size={15} aria-hidden="true" />
    </button>
    <button className="icon-btn editor-ask-ai-action" title={t("editor.askAiTitle")} aria-label={t("editor.askAi")} onClick={askAboutSelection} disabled={!active}>
      <MessageSquareText size={15} aria-hidden="true" />
    </button>
    <button className="icon-btn editor-more-action" title={t("editor.moreTools")} aria-label={t("editor.moreTools")} aria-expanded={toolsOpen} onClick={() => setToolsOpen((v) => !v)}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
  </div>
</div>
```

- [ ] **Step 3: Render existing secondary controls in the bounded menu**

Immediately after the header, conditionally render:

```tsx
{toolsOpen && (
  <div className="editor-tools-menu" ref={toolsMenuRef} role="menu">
    <div className="format-buttons">{/* existing controls except Ask AI */}</div>
    <div className="editor-tools-footer">
      {/* existing snippet select and PDF locate button; no duplicate Save button */}
    </div>
  </div>
)}
```

Every existing action appears exactly once: Save and Ask AI remain primary; all other current header controls move into the menu.

- [ ] **Step 4: Add editor containment CSS**

```css
.col-editor, .editor-pane { min-width: 0; overflow: hidden; }
.editor-pane { position: relative; }
.editor-header { min-width: 0; overflow: hidden; }
.editor-primary-actions { flex: 0 0 auto; }
.editor-tools-menu { position: absolute; z-index: 50; top: 38px; left: 8px; right: 8px; margin-left: auto; width: auto; max-width: 420px; max-height: calc(100% - 54px); overflow: auto; padding: 8px; background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.32); }
.editor-tools-menu .format-buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.editor-tools-menu .sym-quick { flex-wrap: wrap; }
.editor-tools-footer { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
```

- [ ] **Step 5: Run editor and full UI suites**

Run:

```powershell
node scripts/e2e-v086.mjs editor
node scripts/e2e-v086.mjs all
```

Expected: the 200px editor header stays bounded, all three primary actions are visible, and the menu stays within the editor while exposing at least 12 controls. The AI cases remain green.

- [ ] **Step 6: Run type/build checks and commit**

Run:

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run build
git diff --check
```

Commit:

```powershell
git add src/components/Editor.tsx src/styles.css
git commit -m "fix: contain editor tools in overflow menu"
```

---

### Task 4: Visual QA and Full Repository Verification

**Files:**
- Modify only if visual QA exposes a scoped defect in Task 2/3 files.

**Interfaces:**
- Consumes: the completed responsive UI and E2E suite.
- Produces: verified screenshots kept outside Git and a clean, committed worktree.

- [ ] **Step 1: Inspect all required visual states**

Use Playwright against the running frontend/Tauri window and capture temporary screenshots for:

- `960 x 700`, AI 240px, suggested hunks open.
- `1280 x 800`, AI 300px, ordinary multi-turn conversation.
- `1280 x 800`, PDF open and editor at 200px, editor tools menu open.
- `1600 x 900`, AI 520px.
- liquid, dark, and light themes.

Verify text does not overlap, menus remain inside their owner panel, message bubbles wrap cleanly, the composer fills the row, and the send button does not move when status actions wrap.

- [ ] **Step 2: Run frontend and UI verification**

```powershell
node scripts/e2e-v086.mjs all
.\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run build
```

Expected: every command exits `0`.

- [ ] **Step 3: Run Rust verification**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all non-ignored unit and integration tests pass; environment-dependent ignored tests remain ignored.

- [ ] **Step 4: Review the final diff and repository state**

```powershell
git diff --check
git status --short
git log -4 --oneline
```

Expected: no unstaged implementation files, no E2E project residue, and only the approved design, plan, AI layout, and editor layout commits are ahead of the prior HEAD.

- [ ] **Step 5: Commit visual-QA refinements only when needed**

If Task 4 required a scoped CSS or accessibility correction, rerun Steps 1-4 and commit only those files:

```powershell
git add src/App.tsx src/components/AiPanel.tsx src/components/Editor.tsx src/i18n/index.ts src/styles.css scripts/e2e-v086.mjs
git commit -m "fix: polish responsive workspace controls"
```
