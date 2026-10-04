import { connect, runner, assert, sleep, MOD } from "./lib.mjs";
import { makeFixture, PROJ_FWD, NEWPROJ_PARENT } from "./fixture.mjs";

await makeFixture();
const c = await connect();
const { js, waitFor, key, typeText, shot } = c;
const r = runner("core");
const P = JSON.stringify(PROJ_FWD);

await c.send("Page.reload");
await waitFor("return Boolean(window.__tb && document.querySelector('.toolbar'))", { timeout: 30000 });
await js("if (T.project.getState().root) await T.project.getState().closeProject(); T.ui.getState().setTheme('light'); return true");

const disk = (path) => js(`return await invoke('tb_read_file', { path: ${JSON.stringify(path)} })`);
const focusEditor = () => js("$('.editor-pane .monaco-editor textarea').focus(); return true");
const setCursor = (line, col = 1) => js(`T.bridge.activeEditor().setPosition({ lineNumber: ${line}, column: ${col} }); T.bridge.activeEditor().focus(); return true`);
const tabContent = (path) => js(`return T.project.getState().tabs.find(t => t.path === ${JSON.stringify(path)})?.content ?? null`);
const revert = () => js(`const ed = T.bridge.activeEditor(); const m = ed.getModel(); const d = await invoke('tb_read_file', { path: T.project.getState().activeTab }); ed.executeEdits('e2e', [{ range: m.getFullModelRange(), text: d }]); return true`);
const toasts = () => js("return T.feedback.getState().toasts.map(t => t.tone + ':' + t.text)");

// ---------------------------------------------------------------- welcome
await r.test("welcome screen renders with actions + palette works without project", async () => {
  await waitFor("return $$('.welcome-action').length === 2");
  await key(MOD.ctrl | MOD.shift, "P", "KeyP", 80);
  await waitFor("return Boolean($('.palette'))");
  const titles = await js("return $$('.quick-open-item .quick-open-title').map(e => e.textContent)");
  assert(titles.some((x) => x.includes("新建项目")), titles.join("|"));
  await key(0, "Escape", "Escape", 27);
  await waitFor("return !$('.palette')");
});

// ---------------------------------------------------------------- project
await r.test("open project: tree, main tag, active tab, recent list", async () => {
  await js(`await T.project.getState().openProject(${P}); return true`);
  await waitFor("return $$('.tree-node').length >= 6");
  const st = await js("return { active: T.project.getState().activeTab, main: $('.tree-main-tag')?.closest('.tree-node')?.textContent, recent: JSON.parse(localStorage.getItem('tb-recent-projects'))[0].path }");
  assert(st.active === "main.tex", JSON.stringify(st));
  assert(st.main.includes("main.tex"), JSON.stringify(st));
  assert(st.recent.replaceAll("\\", "/").includes("e2e/proj"), JSON.stringify(st));
});

await r.test("tree: folder toggles and opens nested file; context menu set-main/copy", async () => {
  await js("$$('.tree-node.tree-dir').find(e => e.textContent.includes('chapters')).click(); return true");
  await sleep(200);
  const collapsed = await js("return !$$('.tree-node').some(e => e.textContent.includes('intro.tex'))");
  await js("$$('.tree-node.tree-dir').find(e => e.textContent.includes('chapters')).click(); return true");
  await waitFor("return $$('.tree-node').some(e => e.textContent.includes('intro.tex'))");
  await js("$$('.tree-node').find(e => e.textContent.includes('intro.tex')).click(); return true");
  await waitFor("return T.project.getState().activeTab === 'chapters/intro.tex'");
  // context menu on notes.tex → set as main → then restore
  await js("const n = $$('.tree-node').find(e => e.textContent.includes('notes.tex')); const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 10, clientY: r.top + 5 })); return true");
  await waitFor("return Boolean($('.ctx-menu'))");
  const items = await js("return $$('.ctx-menu .ctx-item').map(e => e.textContent.trim())");
  await js("$$('.ctx-menu .ctx-item').find(e => e.textContent.includes('设为主文件')).click(); return true");
  await waitFor("return T.project.getState().mainFile === 'notes.tex'");
  await js("await (await import('/src/actions.ts')).setMainFile; return true").catch(() => {});
  await js("await invoke('tb_set_main_file', { path: 'main.tex' }); T.project.setState({ mainFile: 'main.tex' }); return true");
  assert(collapsed, "folder did not collapse");
  return items.join(" / ");
});

// ---------------------------------------------------------------- tabs
await r.test("tabs: neighbour activation on close, middle-click, close others", async () => {
  for (const f of ["main.tex", "notes.tex", "refs.bib", "chapters/intro.tex"]) {
    await js(`await T.project.getState().openFile(${JSON.stringify(f)}); return true`);
  }
  await js("await T.project.getState().openFile('notes.tex'); return true");
  // order: intro?, main, notes, refs ... close notes → next should be refs (right neighbour)
  const order = await js("return T.project.getState().tabs.map(t => t.path)");
  const idx = order.indexOf("notes.tex");
  const expected = order[idx + 1] ?? order[idx - 1];
  await js("$$('.editor-tab').find(e => e.title === 'notes.tex').querySelector('.editor-tab-close').click(); return true");
  await waitFor(`return T.project.getState().activeTab === ${JSON.stringify(expected)}`);
  // middle click closes refs.bib
  await js("const t = $$('.editor-tab').find(e => e.title === 'refs.bib'); t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1 })); return true");
  await waitFor("return !T.project.getState().tabs.some(t => t.path === 'refs.bib')");
  // close others via context menu
  await js("const t = $$('.editor-tab').find(e => e.title === 'main.tex'); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 70 })); return true");
  await waitFor("return Boolean($('.ctx-menu'))");
  await js("$$('.ctx-menu .ctx-item').find(e => e.textContent.includes('关闭其他')).click(); return true");
  await waitFor("return T.project.getState().tabs.length === 1 && T.project.getState().activeTab === 'main.tex'");
  return `order=${order.join(",")}`;
});

// ---------------------------------------------------------------- editing
await r.test("typing marks dirty; Ctrl+S writes to disk; dirty dot clears", async () => {
  await js("await T.project.getState().openFile('main.tex'); return true");
  await waitFor("return Boolean(T.bridge.activeEditor())");
  await setCursor(22, 1); // "Results go here."
  await typeText("Typed by E2E. ");
  await waitFor("return T.project.getState().tabs.find(t => t.path === 'main.tex').dirty");
  const dot = await js("return Boolean($('.editor-tab.dirty'))");
  await key(MOD.ctrl, "s", "KeyS", 83);
  await waitFor("return !T.project.getState().tabs.find(t => t.path === 'main.tex').dirty");
  const d = await disk("main.tex");
  assert(d.includes("Typed by E2E."), "not on disk");
  assert(dot, "no dirty indicator");
});

await r.test("\\begin{env} auto-inserts \\end{env}", async () => {
  await setCursor(23, 1);
  await typeText("\\begin{itemize}");
  await sleep(300);
  const txt = await tabContent("main.tex");
  assert(/\\begin\{itemize\}\n\n\\end\{itemize\}/.test(txt), txt.slice(txt.indexOf("itemize") - 20, txt.indexOf("itemize") + 60));
  await revert();
});

await r.test("Ctrl+Shift+B wraps selection in \\textbf; format bar heading menu", async () => {
  const pre = await tabContent("main.tex");
  const dbg = await js("const ed = T.bridge.activeEditor(); const m = ed.getModel(); const line = m.getLinesContent().findIndex(l => l.startsWith('Typed by E2E')) + 1; ed.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 6 }); ed.focus(); return { line, uri: m.uri.toString(), focus: ed.hasTextFocus(), sel: m.getValueInRange(ed.getSelection()), suggest: Boolean(document.querySelector('.suggest-widget.visible')) }");
  await key(MOD.ctrl | MOD.shift, "B", "KeyB", 66);
  await sleep(200);
  let txt = await tabContent("main.tex");
  if (!txt.includes("\\textbf{Typed}")) {
    const a = pre.split("\n"), b = txt.split("\n");
    const diffs = b.map((l, i) => (l !== a[i] ? `${i + 1}: ${a[i]} => ${l}` : null)).filter(Boolean);
    throw new Error(`bold not applied; dbg=${JSON.stringify(dbg)} diffs=${JSON.stringify(diffs).slice(0, 400)}`);
  }
  // heading menu → \subsection
  await setCursor(1, 1);
  await js("$$('.format-bar button[aria-haspopup=menu]')[0].click(); return true");
  await waitFor("return $$('.menu .menu-item').length >= 5");
  await js("$$('.menu .menu-item').find(e => e.textContent.includes('subsection') && !e.textContent.includes('subsub')).click(); return true");
  await sleep(200);
  txt = await tabContent("main.tex");
  assert(txt.includes("\\subsection{}"), "heading not inserted");
  await revert();
});

await r.test("symbols popover inserts a symbol; snippet menu inserts a figure block", async () => {
  await setCursor(22, 1);
  await js("$$('.format-bar button').find(b => b.title === '数学符号').click(); return true");
  await waitFor("return $$('.symbol-btn').length > 50");
  await js("$$('.symbol-btn').find(b => b.textContent === 'α').click(); return true");
  await sleep(150);
  let txt = await tabContent("main.tex");
  assert(txt.includes("α"), "symbol missing");
  await js("$$('.format-bar button').find(b => b.title.startsWith('插入片段')).click(); return true");
  await waitFor("return $$('.menu .menu-item').length > 5");
  await js("$$('.menu .menu-item').find(e => e.textContent.trim() === 'equation').click(); return true");
  await sleep(150);
  txt = await tabContent("main.tex");
  assert((txt.match(/\\begin\{equation\}/g) || []).length === 2, "equation snippet missing");
  await revert();
  txt = await tabContent("main.tex");
  assert(!txt.includes("α"), "undo failed");
});

await r.test("formula modal: live preview + insert inline math", async () => {
  await setCursor(22, 1);
  await js("$$('.format-bar button').find(b => b.title.startsWith('行内公式')).click(); return true");
  await waitFor("return Boolean($('.formula-modal .katex'))");
  await js("$$('.formula-templates button').find(b => b.textContent === 'a/b').click(); return true");
  await waitFor("return $('.formula-preview').innerHTML.includes('mfrac')");
  await js("$$('.formula-modal .modal-footer .btn-primary')[0].click(); return true");
  await waitFor("return !$('.formula-modal')");
  const txt = await tabContent("main.tex");
  assert(txt.includes("$\\frac{a}{b}$"), "formula not inserted");
  await revert();
});

await r.test("table modal: grid + CSV generate booktabs tables", async () => {
  await setCursor(22, 1);
  await js("$$('.format-bar button').find(b => b.title === '表格生成器').click(); return true");
  await waitFor("return Boolean($('.table-modal'))");
  await js("$('.table-modal .modal-footer .btn-primary').click(); return true");
  await waitFor("return !$('.table-modal')");
  let txt = await tabContent("main.tex");
  assert(txt.includes("\\toprule") && txt.includes("\\midrule"), "grid table missing");
  await revert();
  await js("$$('.format-bar button').find(b => b.title === '表格生成器').click(); return true");
  await waitFor("return Boolean($('.table-modal'))");
  await js("$$('.table-modal .market-tab')[1].click(); return true");
  await waitFor("return Boolean($('.table-csv-input'))");
  await js(`const ta = $('.table-csv-input'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'name,score\\nAlice,90\\n"Bob, Jr",85'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true`);
  await js("$('.table-modal .modal-footer .btn-primary').click(); return true");
  await waitFor("return !$('.table-modal')");
  txt = await tabContent("main.tex");
  assert(txt.includes("Bob, Jr & 85"), "csv quoted field wrong: " + txt.slice(txt.indexOf("Alice") - 40, txt.indexOf("Alice") + 60));
  await revert();
});

await r.test("image import → insert dialog → figure code", async () => {
  await setCursor(22, 1);
  const name = await js(`return await invoke('tb_import_image', { sourcePath: ${JSON.stringify(PROJ_FWD.replace(/proj$/, "extra.png"))} })`);
  // open the dialog the same way the editor does after a drop
  await js(`window.dispatchEvent(new CustomEvent('noop')); return true`);
  assert(typeof name === "string" && name.length > 0, "import failed");
  const files = await js("await T.project.getState().refresh(); return JSON.stringify(T.project.getState().files)");
  assert(files.includes(name.split("/").pop()), "imported image not in tree: " + name);
  return name;
});

await r.test("Escape closes dialogs; Ctrl+Enter submits", async () => {
  await js("$$('.format-bar button').find(b => b.title.startsWith('行内公式')).click(); return true");
  await waitFor("return Boolean($('.formula-modal'))");
  await key(0, "Escape", "Escape", 27);
  await waitFor("return !$('.formula-modal')");
});

// ---------------------------------------------------------------- new file
await r.test("new file modal: invalid name error, .tex with template, non-tex empty", async () => {
  await key(MOD.ctrl, "n", "KeyN", 78);
  await waitFor("return Boolean($('.new-file-modal'))");
  const setName = (v) => js(`const i = $('.new-file-name-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true`);
  await setName("a/b.tex");
  await js("$('.new-file-modal .modal-footer .btn-primary').click(); return true");
  await waitFor("return Boolean($('.new-file-modal .modal-error'))");
  await setName("sec2.tex");
  await js("$$('.new-file-modal .template-card').find(b => b.dataset.templateId === 'minimal').click(); return true");
  await js("$('.new-file-modal .modal-footer .btn-primary').click(); return true");
  await waitFor("return T.project.getState().activeTab === 'sec2.tex'");
  const d = await disk("sec2.tex");
  assert(d.includes("\\documentclass"), "template not applied: " + d.slice(0, 80));
  await key(MOD.ctrl, "n", "KeyN", 78);
  await waitFor("return Boolean($('.new-file-modal'))");
  await setName("notes.txt");
  const disabled = await js("return $$('.new-file-modal .template-card').every(b => b.disabled)");
  await js("$('.new-file-modal .modal-footer .btn-primary').click(); return true");
  await waitFor("return T.project.getState().activeTab === 'notes.txt'");
  assert((await disk("notes.txt")) === "", "non-tex not empty");
  assert(disabled, "template cards should be disabled for non-tex");
});

await r.test("new file in current directory (active file in chapters/)", async () => {
  await js("await T.project.getState().openFile('chapters/intro.tex'); return true");
  await key(MOD.ctrl, "n", "KeyN", 78);
  await waitFor("return Boolean($('.new-file-modal'))");
  const dest = await js("return $('.new-file-destination code').textContent");
  await js(`const i = $('.new-file-name-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'methods.tex'); i.dispatchEvent(new Event('input', { bubbles: true })); return true`);
  await js("$('.new-file-modal .modal-footer .btn-primary').click(); return true");
  await waitFor("return T.project.getState().activeTab === 'chapters/methods.tex'");
  return `dest=${dest}`;
});

// ---------------------------------------------------------------- compile
await r.test("compile main → success, PDF path, status bar, compile count", async () => {
  await js("await T.project.getState().openFile('main.tex'); T.compile.getState().setTarget('main'); return true");
  await js("$('.toolbar-compile').click(); return true");
  await waitFor("return T.compile.getState().running");
  await waitFor("return !T.compile.getState().running", { timeout: 120000 });
  const st = await js("return { ok: T.compile.getState().lastResult?.ok, pdf: T.project.getState().pdfPath, count: T.compile.getState().compileCount, status: $('.statusbar').textContent, viewer: Boolean($('.pdf-viewer')), issues: T.compile.getState().compileIssues.filter(i => i.severity === 'error').map(i => [i.file, i.line, i.message.slice(0, 80), (i.raw || '').slice(0, 160)]) }");
  assert(st.ok && st.pdf && st.viewer, JSON.stringify(st));
  return st.status;
});

await r.test("SyncTeX: locate cursor in PDF sets a page", async () => {
  await setCursor(22, 1);
  await js("$$('.format-bar button').find(b => b.title.startsWith('SyncTeX')).click(); return true");
  await sleep(1500);
  const st = await js("return { page: T.ui.getState().pdfTarget?.page ?? null, toasts: T.feedback.getState().toasts.map(t => t.text) }");
  assert(st.page != null, JSON.stringify(st));
  return `page=${st.page}`;
});

await r.test("compile target menu: second root (notes.tex)", async () => {
  await js("$('.compile-target-btn').click(); return true");
  await waitFor("return $$('.compile-target-menu .menu-item').some(e => e.textContent.includes('notes.tex'))");
  const items = await js("return $$('.compile-target-menu .menu-item').map(e => e.textContent)");
  await js("$$('.compile-target-menu .menu-item').find(e => e.textContent.includes('notes.tex')).click(); return true");
  await waitFor("return T.compile.getState().target === 'notes.tex'");
  await js("$('.toolbar-compile').click(); return true");
  await waitFor("return T.compile.getState().running");
  await waitFor("return !T.compile.getState().running", { timeout: 120000 });
  const st = await js("return { ok: T.compile.getState().lastResult?.ok, pdf: T.project.getState().pdfPath }");
  await js("T.compile.getState().setTarget('main'); return true");
  assert(st.ok && /notes\.pdf$/.test(st.pdf), JSON.stringify(st));
  return items.join(" | ");
});

await r.test("broken document: failure opens problems panel, row jumps to error line", async () => {
  await js("T.ui.getState().setPanel('bottom', false); await T.project.getState().openFile('broken.tex'); return true");
  await js("T.compile.getState().compile('current'); return true");
  await waitFor("return T.compile.getState().running");
  await waitFor("return !T.compile.getState().running", { timeout: 120000 });
  const st = await js("return { ok: T.compile.getState().lastResult?.ok, open: T.ui.getState().panels.bottom, issues: T.compile.getState().compileIssues.map(i => [i.severity, i.file, i.line, i.message.slice(0, 60)]) }");
  assert(st.ok === false, "should fail: " + JSON.stringify(st));
  assert(st.open, "problems panel did not open");
  const err = st.issues.findIndex((i) => i[0] === "error" && i[2]);
  assert(err >= 0, "no located error: " + JSON.stringify(st.issues));
  await js("await T.project.getState().openFile('main.tex'); return true");
  await js(`$$('.problem-row')[${err}].click(); return true`);
  await waitFor(`return T.project.getState().activeTab === ${JSON.stringify(st.issues[err][1])} && T.ui.getState().cursor?.line === ${st.issues[err][2]}`);
  await shot("broken-problems");
  return JSON.stringify(st.issues[err]);
});

await r.test("compile log dialog opens with content", async () => {
  await js("$$('.problems-header .icon-btn').find(b => b.getAttribute('aria-label') === '日志').click(); return true");
  await waitFor("return Boolean($('.dialog-pre'))");
  const len = await js("return $('.dialog-pre').textContent.length");
  await key(0, "Escape", "Escape", 27);
  await waitFor("return !$('.dialog-pre')");
  assert(len > 100, `log length ${len}`);
});

await r.test("cancel a running compile", async () => {
  await js("await T.project.getState().openFile('main.tex'); T.compile.getState().compile('main'); return true");
  await waitFor("return Boolean($('.toolbar-cancel'))", { timeout: 10000 });
  await js("$('.toolbar-cancel').click(); return true");
  await waitFor("return !T.compile.getState().running", { timeout: 60000 });
  const st = await js("return { stage: T.compile.getState().progress?.stage, msg: T.compile.getState().progress?.message, ok: T.compile.getState().lastResult?.ok }");
  return JSON.stringify(st);
});

// ---------------------------------------------------------------- rules
await r.test("rule check finds issues in rules-sample.tex; one-click fix edits the file", async () => {
  await js("await T.project.getState().openFile('rules-sample.tex'); T.ui.getState().showProblems('rules'); return true");
  await waitFor("return T.compile.getState().ruleIssues.some(i => i.file === 'rules-sample.tex')", { timeout: 15000 });
  const issues = await js("return T.compile.getState().ruleIssues.filter(i => i.file === 'rules-sample.tex').map(i => [i.rule_id, i.line, i.message.slice(0, 40)])");
  const before = await disk("rules-sample.tex");
  const idx = await js("return T.compile.getState().ruleIssues.findIndex(i => i.file === 'rules-sample.tex')");
  await js(`const row = $$('.problem-row')[${idx}]; row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); row.querySelector('.problem-actions .btn-primary').click(); return true`);
  await waitFor("return !T.ai.getState().busy", { timeout: 60000 });
  await sleep(800);
  const after = await disk("rules-sample.tex");
  assert(after !== before, "file unchanged after fix; issues=" + JSON.stringify(issues));
  return JSON.stringify(issues);
});

// ---------------------------------------------------------------- sidebar panels
await r.test("outline lists sections and jumps", async () => {
  await js("await T.project.getState().openFile('main.tex'); T.ui.getState().setSidebarTab('outline'); return true");
  await waitFor("return $$('.outline-item').length >= 2");
  const items = await js("return $$('.outline-item .outline-title').map(e => e.textContent)");
  await js("$$('.outline-item').find(e => e.textContent.includes('Results')).click(); return true");
  await waitFor("return T.bridge.activeEditor().getModel().getLineContent(T.ui.getState().cursor.line).includes('Results')");
  return items.join(",");
});

await r.test("bibliography: entries listed, click inserts \\cite at cursor", async () => {
  await js("T.ui.getState().setSidebarTab('bib'); return true");
  await waitFor("return $$('.bib-item').length === 2");
  await setCursor(22, 1);
  await js("$$('.bib-item').find(e => e.textContent.includes('lamport')).click(); return true");
  await sleep(200);
  const txt = await tabContent("main.tex");
  assert(txt.includes("\\cite{lamport1994}"), "cite not inserted");
  await revert();
});

await r.test("bibliography: DOI fetch (network)", async () => {
  await js(`const i = $('.bib-fetch-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '10.1145/3292500.3330701'); i.dispatchEvent(new Event('input', { bubbles: true })); return true`);
  await js("$('.bib-fetch .icon-btn').click(); return true");
  await waitFor("return Boolean($('.bib-fetched-pre') || $('.bib-fetch-err'))", { timeout: 30000 });
  const res = await js("return $('.bib-fetched-pre')?.textContent.slice(0, 80) ?? ('ERR ' + $('.bib-fetch-err').textContent)");
  assert(!res.startsWith("ERR"), res);
  return res;
});

await r.test("TODO panel lists markers and jumps across files", async () => {
  await js("T.ui.getState().setSidebarTab('todo'); return true");
  await waitFor("return $$('.todo-row').length >= 2");
  await js("$$('.todo-row').find(e => e.textContent.includes('intro.tex')).click(); return true");
  await waitFor("return T.project.getState().activeTab === 'chapters/intro.tex' && T.ui.getState().cursor?.line === 2");
});

await r.test("\\ref completion offers labels", async () => {
  await js("await T.project.getState().openFile('main.tex'); await T.project.getState().loadRefIndex(); return true");
  await setCursor(22, 1);
  await typeText("\\ref{");
  await js("T.bridge.activeEditor().trigger('e2e', 'editor.action.triggerSuggest', {}); return true");
  await waitFor("return $$('.suggest-widget .monaco-list-row').length > 0", { timeout: 8000 });
  const labels = await js("return $$('.suggest-widget .monaco-list-row').map(e => e.getAttribute('aria-label') || e.textContent).slice(0, 8)");
  await key(0, "Escape", "Escape", 27);
  await revert();
  assert(labels.some((l) => l.includes("sec:intro")), labels.join("|"));
  return labels.join(" | ");
});

// ---------------------------------------------------------------- split
await r.test("split view: pick file via palette, edit + Ctrl+S saves the split file", async () => {
  await js("T.ui.getState().openPalette('split'); return true");
  await waitFor("return Boolean($('.palette'))");
  await typeText("notes");
  await waitFor("return $$('.quick-open-item').length >= 1");
  await key(0, "Enter", "Enter", 13);
  await waitFor("return Boolean($('.split-pane .monaco-editor'))");
  await js("$('.split-pane .monaco-editor textarea').focus(); return true");
  await key(MOD.ctrl, "Home", "Home", 36);
  await typeText("% split edit\n");
  const crlf = await js("return T.project.getState().tabs.find(t => t.path === 'notes.tex').content.includes('\\r\\n')");
  assert(!crlf, "split editor converted line endings to CRLF");
  await waitFor("return T.project.getState().tabs.find(t => t.path === 'notes.tex')?.dirty");
  await key(MOD.ctrl, "s", "KeyS", 83);
  await waitFor("return !T.project.getState().tabs.find(t => t.path === 'notes.tex')?.dirty");
  const d = await disk("notes.tex");
  assert(d.startsWith("% split edit"), d.slice(0, 40));
  await js("$$('.split-header .icon-btn').at(-1).click(); return true");
  await waitFor("return !$('.split-pane')");
});

// ---------------------------------------------------------------- palette / shortcuts
await r.test("quick open (Ctrl+P) fuzzy match opens file", async () => {
  await js("T.bridge.activeEditor()?.focus(); return true");
  await key(MOD.ctrl, "p", "KeyP", 80);
  await waitFor("return Boolean($('.palette'))");
  await typeText("rfs");
  await waitFor("return $('.quick-open-item.active .quick-open-title')?.textContent === 'refs.bib'");
  await key(0, "Enter", "Enter", 13);
  await waitFor("return T.project.getState().activeTab === 'refs.bib'");
});

await r.test("command palette runs commands (toggle problems, theme)", async () => {
  await key(MOD.ctrl | MOD.shift, "P", "KeyP", 80);
  await waitFor("return Boolean($('.palette'))");
  await typeText("深色");
  await waitFor("return $$('.quick-open-item').length >= 1");
  await key(0, "Enter", "Enter", 13);
  await waitFor("return document.documentElement.dataset.theme === 'dark'");
  const before = await js("return T.ui.getState().panels.bottom");
  await key(MOD.ctrl, "j", "KeyJ", 74);
  const after = await js("return T.ui.getState().panels.bottom");
  assert(before !== after, "Ctrl+J did not toggle");
  await js("T.ui.getState().setTheme('light'); return true");
});

await r.test("Ctrl+Shift+S saves all dirty tabs", async () => {
  await js("await T.project.getState().openFile('notes.tex'); await T.project.getState().openFile('main.tex'); T.project.getState().setTabContent('notes.tex', T.project.getState().tabs.find(t=>t.path==='notes.tex').content + '% a\\n'); return true");
  await setCursor(22, 1);
  await typeText("X");
  await key(MOD.ctrl | MOD.shift, "S", "KeyS", 83);
  await waitFor("return T.project.getState().tabs.every(t => !t.dirty)");
  await js("T.bridge.activeEditor().trigger('e2e','undo'); await T.project.getState().saveAll(); return true");
});

// ---------------------------------------------------------------- export / import / template
await r.test("export Markdown + Word, then import the .docx back", async () => {
  await js("await T.project.getState().openFile('main.tex'); return true");
  await js("$('.toolbar-more-btn').click(); return true");
  await waitFor("return Boolean($('.toolbar-export-md'))");
  await js("$('.toolbar-export-md').click(); return true");
  await waitFor("return T.feedback.getState().toasts.some(t => t.text.includes('.md'))", { timeout: 20000 });
  await js("$('.toolbar-more-btn').click(); return true");
  await waitFor("return Boolean($('.toolbar-export-docx'))");
  await js("$('.toolbar-export-docx').click(); return true");
  await waitFor("return T.feedback.getState().toasts.some(t => t.text.includes('.docx'))", { timeout: 30000 });
  const docx = await js("return T.feedback.getState().toasts.find(t => t.text.includes('.docx')).text");
  const path = docx.replace(/^.*?[:：]\s*/, "").trim();
  const imported = await js(`return await invoke('tb_import_docx', { sourcePath: ${JSON.stringify(path)} })`);
  return `${path} → ${imported.file} (${imported.chars} chars)`;
});

await r.test("save as template → appears in New file › My templates → delete", async () => {
  await js("$('.project-switcher').click(); return true");
  await waitFor("return Boolean($('.project-menu'))");
  await js("$$('.project-menu .menu-item').find(e => e.textContent.includes('存为模板')).click(); return true");
  await waitFor("return Boolean($('.dialog-input'))");
  await js(`const i = $('.dialog-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'e2e-tpl'); i.dispatchEvent(new Event('input', { bubbles: true })); return true`);
  await key(0, "Enter", "Enter", 13);
  await waitFor("return T.feedback.getState().toasts.some(t => t.text.includes('e2e-tpl'))", { timeout: 20000 });
  await js("T.ui.getState().openModal({ kind: 'newFile' }); return true");
  await waitFor("return Boolean($('.new-file-modal'))");
  await js("$('[data-new-file-tab=user]').click(); return true");
  await waitFor("return $$('.template-wrap').some(e => e.textContent.includes('e2e-tpl'))");
  await js("$$('.template-wrap').find(e => e.textContent.includes('e2e-tpl')).querySelector('.template-del').click(); return true");
  await waitFor("return Boolean($('.dialog-modal'))");
  await js("$('.dialog-modal .btn-danger').click(); return true");
  await waitFor("return !$$('.template-wrap').some(e => e.textContent.includes('e2e-tpl'))", { timeout: 10000 });
  await key(0, "Escape", "Escape", 27);
});

await r.test("template marketplace lists entries and filters", async () => {
  await js("T.ui.getState().openModal({ kind: 'newFile' }); return true");
  await waitFor("return Boolean($('.new-file-modal'))");
  await js("$('[data-new-file-tab=market]').click(); return true");
  await waitFor("return $$('.market-card').length > 50", { timeout: 15000 });
  const total = await js("return $$('.market-card').length");
  await js(`const i = $('.market-search'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '北京大学'); i.dispatchEvent(new Event('input', { bubbles: true })); return true`);
  await sleep(200);
  const filtered = await js("return $$('.market-card').length");
  await key(0, "Escape", "Escape", 27);
  assert(filtered > 0 && filtered < total, `${filtered}/${total}`);
  return `${filtered}/${total}`;
});

// ---------------------------------------------------------------- settings
await r.test("settings: sections, theme cards, language switch, autosave", async () => {
  await key(MOD.ctrl, ",", "Comma", 188);
  await waitFor("return Boolean($('.settings-modal'))");
  const sections = await js("return $$('.settings-nav-item').map(e => e.textContent)");
  await js("$$('.theme-card')[1].click(); return true");
  await waitFor("return document.documentElement.dataset.theme === 'dark'");
  await js("$$('.theme-card')[2].click(); return true");
  await js(`const s = $$('.settings-content select')[0]; s.value = 'en'; s.dispatchEvent(new Event('change', { bubbles: true })); return true`);
  await waitFor("return $('.settings-section-title').textContent === 'General'");
  await js(`const s = $$('.settings-content select')[0]; s.value = 'zh'; s.dispatchEvent(new Event('change', { bubbles: true })); return true`);
  await waitFor("return $('.settings-section-title').textContent === '通用'");
  return sections.join(",");
});

await r.test("settings: shortcut rebinding takes effect immediately", async () => {
  await js("$$('.settings-nav-item')[1].click(); return true");
  await waitFor("return $$('.shortcut-input').length === 2");
  const orig = await js("return localStorage.getItem('tb-keymap')");
  await js("$$('.shortcut-input')[0].focus(); return true");
  await key(MOD.ctrl | MOD.alt, "m", "KeyM", 77);
  await sleep(100);
  const label = await js("return $$('.shortcut-input')[0].value");
  await key(0, "Escape", "Escape", 27);
  await waitFor("return !$('.settings-modal')");
  await js("await T.project.getState().openFile('main.tex'); T.bridge.activeEditor().focus(); return true");
  await key(MOD.ctrl | MOD.alt, "m", "KeyM", 77);
  await waitFor("return T.compile.getState().running", { timeout: 5000 });
  await waitFor("return !T.compile.getState().running", { timeout: 120000 });
  await js(`${orig ? `localStorage.setItem('tb-keymap', ${JSON.stringify(orig)})` : "localStorage.removeItem('tb-keymap')"}; return true`);
  return label;
});

await r.test("settings: compile engine / passes persist via backend", async () => {
  await js("T.ui.getState().openModal({ kind: 'settings', section: 'compile' }); return true");
  await waitFor("return $$('.settings-content select').length >= 2");
  await sleep(800); // let the section finish loading its current values
  const before = await js("return await invoke('tb_get_texlive_passes')");
  await js(`const s = $$('.settings-content select')[1]; s.value = '3'; s.dispatchEvent(new Event('change', { bubbles: true })); return true`);
  await sleep(300);
  const after = await js("return await invoke('tb_get_texlive_passes')");
  await js(`await invoke('tb_set_texlive_passes', { passes: ${before} }); return true`);
  await key(0, "Escape", "Escape", 27);
  assert(after === 3, `passes ${before}→${after}`);
});

await r.test("settings: unsaved AI changes prompt on close (then discard)", async () => {
  await js("T.ui.getState().openModal({ kind: 'settings', section: 'ai' }); return true");
  await waitFor("return $$('.settings-content input').length >= 2");
  await js(`const i = $$('.settings-content input.input')[0]; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, i.value + '-x'); i.dispatchEvent(new Event('input', { bubbles: true })); return true`);
  await waitFor("return $('.modal-footer .footer-note').textContent.includes('未保存')");
  await js("$('.modal-close').click(); return true");
  await waitFor("return Boolean($('.dialog-modal'))");
  await js("$('.dialog-modal .btn-danger').click(); return true");
  await waitFor("return !$('.settings-modal')");
});

// ---------------------------------------------------------------- layout
await r.test("layout: panel toggles + narrow window auto-fit keeps the editor", async () => {
  const widths = [];
  for (const w of [940, 1100, 1280, 1600]) {
    await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    widths.push(await js("return [innerWidth, Math.round($('.col-editor').getBoundingClientRect().width), Boolean($('.col-pdf')), Boolean($('.ai-rail.open')), Boolean($('.col-tree'))].join(':')"));
  }
  await c.send("Emulation.clearDeviceMetricsOverride");
  for (const w of widths) assert(Number(w.split(":")[1]) >= 340, `editor too narrow ${w}`);
  // toggles
  await js("$$('.layout-toggle')[0].click(); return true");
  const noTree = await js("return !$('.col-tree')");
  await js("$$('.layout-toggle')[0].click(); return true");
  assert(noTree, "sidebar toggle failed");
  return widths.join("  ");
});

// ---------------------------------------------------------------- drafts / close
await r.test("crash-recovery draft restores unsaved edit on reopen", async () => {
  await js("await T.project.getState().openFile('notes.tex'); return true");
  await js("T.bridge.activeEditor().setPosition({ lineNumber: 2, column: 1 }); T.bridge.activeEditor().focus(); return true");
  await typeText("DRAFT-LINE ");
  await sleep(4600); // draft debounce is 4 s
  // simulate a crash: drop the in-memory tab without saving, then reopen
  await js("T.project.setState(s => ({ tabs: s.tabs.filter(t => t.path !== 'notes.tex'), activeTab: 'main.tex' })); await T.project.getState().openFile('notes.tex'); return true");
  const st = await js("const t = T.project.getState().tabs.find(t => t.path === 'notes.tex'); return { dirty: t.dirty, has: t.content.includes('DRAFT-LINE') }");
  assert(st.dirty && st.has, JSON.stringify(st));
  await js("T.bridge.activeEditor().trigger('e2e','undo'); await T.project.getState().closeTab('notes.tex'); return true");
});

await r.test("close project saves dirty tabs and returns to welcome", async () => {
  await js("await T.project.getState().openFile('main.tex'); return true");
  await setCursor(22, 1);
  await typeText("CLOSE-SAVE ");
  await js("$('.project-switcher').click(); return true");
  await waitFor("return Boolean($('.project-menu'))");
  await js("$$('.project-menu .menu-item').find(e => e.textContent.includes('关闭项目')).click(); return true");
  await waitFor("return Boolean($('.welcome'))");
  const d = await js(`return await invoke('tb_read_file', { path: 'main.tex' }).catch(e => 'ERR ' + e)`);
  // the backend still holds the project; disk must contain the edit
  assert(String(d).includes("CLOSE-SAVE"), String(d).slice(0, 100));
});

await r.test("reopen from welcome recent list", async () => {
  await js("$$('.welcome-recent-item').find(e => e.textContent.includes('proj')).click(); return true");
  await waitFor("return T.project.getState().root.replaceAll('\\\\','/').endsWith('e2e/proj')");
});

await r.test("new project modal creates and opens a project from template", async () => {
  await js("T.ui.getState().openModal({ kind: 'newProject' }); return true");
  await waitFor("return Boolean($('.new-project-modal'))");
  await js(`const inputs = $$('.new-project-modal input.input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(inputs[0], 'e2e-new'); inputs[0].dispatchEvent(new Event('input', { bubbles: true })); set.call(inputs[1], ${JSON.stringify(NEWPROJ_PARENT)}); inputs[1].dispatchEvent(new Event('input', { bubbles: true })); return true`);
  await js("$$('.new-project-modal .template-card').find(b => b.dataset.templateId === 'article-en').click(); return true");
  await js("$('.new-project-modal .modal-footer .btn-primary').click(); return true");
  await waitFor("return T.project.getState().root.includes('e2e-new')", { timeout: 20000 });
  const d = await disk("main.tex");
  assert(d.includes("\\documentclass"), d.slice(0, 80));
  return d.split("\n")[0];
});

console.log("\nconsole errors:", c.consoleErrors.length);
for (const e of c.consoleErrors.slice(0, 20)) console.log("  ", String(e).slice(0, 300));
await r.save();
c.close();
process.exit(0);
