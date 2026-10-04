// 0.8.0 feature suite: file operations, project search/replace, pdf.js
// viewer + SyncTeX, local history, Git status, references report, spell
// checking, editor preferences, engine setup, updater, AI batch fixes.
// node scripts/e2e/features.mjs [--skip-network]
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect, runner, assert, sleep, MOD } from "./lib.mjs";
import { makeFixture, PROJ, PROJ_FWD } from "./fixture.mjs";

const SKIP_NETWORK = process.argv.includes("--skip-network");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");

await makeFixture();
await writeFile(
  join(PROJ, "chapters", "refs-test.tex"),
  String.raw`\section{Extra}\label{sec:intro}
See Figure~\ref{fig:missing} and \cite{nobody2020}.
\label{sec:unused}
`,
  "utf8",
);
await writeFile(
  join(PROJ, "spell.tex"),
  String.raw`\documentclass{article}
\begin{document}
This sentense has a mistake and a Zorblax word.
\begin{figure}[htbp]
\end{figure}
\end{document}
`,
  "utf8",
);

const c = await connect();
const { js, waitFor, key, typeText, shot } = c;
const r = runner("features");
const P = JSON.stringify(PROJ_FWD);
const test = (name, fn) => (only && !only.some((o) => name.includes(o)) ? Promise.resolve() : r.test(name, fn));

await c.send("Page.reload");
await waitFor("return Boolean(window.__tb && document.querySelector('.toolbar'))", { timeout: 30000 });
// keep the user's preferences: snapshot localStorage + engine, restore at the end
const savedStorage = await js("return JSON.stringify(Object.assign({}, localStorage))");
const savedEngine = await js("return await invoke('tb_get_engine')");
await js(`if (T.project.getState().root) await T.project.getState().closeProject(); await T.project.getState().openProject(${P}); return true`);
await waitFor("return T.project.getState().files.length > 0");
await js("await T.project.getState().openFile('main.tex'); return true");
await waitFor("return Boolean(T.bridge.activeEditor())");

// page helpers
await js(`
  window.__e2e = {
    setVal(el, v) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    ctx(path) {
      const el = document.querySelector('.tree-body [data-path="' + path + '"]');
      if (!el) throw new Error('no tree node ' + path);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
    },
    ctxItem(icon) {
      const b = [...document.querySelectorAll('.ctx-menu .ctx-item')].find((x) => x.querySelector('[class*="lucide-' + icon + '"]'));
      if (!b) throw new Error('no ctx item ' + icon + ': ' + [...document.querySelectorAll('.ctx-menu .ctx-item')].map(x => x.textContent).join('|'));
      b.click();
    },
    drag(from, toDir) {
      const src = document.querySelector('.tree-body [data-path="' + from + '"]');
      const dst = toDir ? document.querySelector('.tree-body [data-path="' + toDir + '"]') : document.querySelector('.tree-body');
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
  };
  return true`);

const answerPrompt = async (value) => {
  await waitFor("return Boolean($('.dialog-modal'))");
  if (value !== undefined) await js(`__e2e.setVal($('.dialog-modal .dialog-input'), ${JSON.stringify(value)}); return true`);
  await sleep(100);
  await js("$('.dialog-modal .modal-footer .btn:last-child').click(); return true");
  await waitFor("return !$('.dialog-modal')");
};
const exists = (rel) => existsSync(join(PROJ, rel));
/** Node-side wait (waitFor evaluates in the page). */
const poll = async (fn, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
};
const tree = () => js("return $$('.tree-body [data-path]').map(e => e.dataset.path)");

// ------------------------------------------------------------------ files
await test("files: new folder from the sidebar header", async () => {
  await js("T.ui.getState().setSidebarTab('files'); return true");
  await js("$('.tree-new-folder').click(); return true");
  await answerPrompt("drafts");
  await waitFor("return $$('.tree-body [data-path]').some(e => e.dataset.path === 'drafts')");
  assert(exists("drafts"), "folder not on disk");
});

await test("files: rename an open file via the context menu (tab follows)", async () => {
  await js("await T.project.getState().openFile('notes.tex'); return true");
  await js("__e2e.ctx('notes.tex'); return true");
  await waitFor("return Boolean($('.ctx-menu'))");
  await js("__e2e.ctxItem('pencil'); return true");
  await answerPrompt("memo.tex");
  await waitFor("return T.project.getState().tabs.some(t => t.path === 'memo.tex')");
  assert(exists("memo.tex") && !exists("notes.tex"), "rename not on disk");
  const tabs = await js("return T.project.getState().tabs.map(t => t.path)");
  assert(!tabs.includes("notes.tex"), "old tab still open: " + tabs);
});

await test("files: drag & drop a file into a folder", async () => {
  await js("__e2e.drag('memo.tex', 'drafts'); return true");
  await waitFor("return T.project.getState().tabs.some(t => t.path === 'drafts/memo.tex')", { timeout: 8000 });
  assert(exists("drafts/memo.tex"), "not moved on disk");
});

await test("files: move via prompt back to the root", async () => {
  await js("__e2e.ctx('drafts/memo.tex'); return true").catch(async () => {
    // folder collapsed: expand it first
    await js("$('.tree-body [data-path=\"drafts\"]').click(); return true");
    await sleep(200);
    await js("__e2e.ctx('drafts/memo.tex'); return true");
  });
  await waitFor("return Boolean($('.ctx-menu'))");
  await js("__e2e.ctxItem('folder-input'); return true");
  await answerPrompt("");
  await poll(() => exists("memo.tex"));
  await waitFor("return T.project.getState().tabs.some(t => t.path === 'memo.tex')", { timeout: 8000 });
  assert(exists("memo.tex"), "not moved to root");
});

await test("files: delete goes to the trash and Undo restores it", async () => {
  await js("__e2e.ctx('memo.tex'); return true");
  await waitFor("return Boolean($('.ctx-menu'))");
  await js("__e2e.ctxItem('trash'); return true");
  await waitFor("return Boolean($('.dialog-modal .btn-danger'))");
  await js("$('.dialog-modal .btn-danger').click(); return true");
  await waitFor("return !T.project.getState().tabs.some(t => t.path === 'memo.tex') && !$$('.tree-body [data-path]').some(e => e.dataset.path === 'memo.tex')");
  assert(!exists("memo.tex"), "file still on disk");
  await waitFor("return Boolean($('.toast-action'))");
  await js("$('.toast-action').click(); return true");
  await waitFor("return $$('.tree-body [data-path]').some(e => e.dataset.path === 'memo.tex')", { timeout: 8000 });
  assert(exists("memo.tex"), "not restored");
});

await test("files: illegal paths are rejected (traversal, .texbutler)", async () => {
  const errs = await js(`
    const out = [];
    for (const p of ['../evil', '.texbutler/x', 'a/../../b', 'con:x']) {
      try { await invoke('tb_create_dir', { path: p }); out.push('ACCEPTED ' + p); } catch (e) { out.push('ok'); }
    }
    return out`);
  assert(errs.every((e) => e === "ok"), errs.join(", "));
});

await test("files: reveal in Explorer / output folder targets (dry run)", async () => {
  const a = await js("return await invoke('tb_reveal_path', { path: 'main.tex', output: false, dryRun: true })");
  const b = await js("return await invoke('tb_reveal_path', { path: null, output: true, dryRun: true })");
  assert(a.replaceAll("\\", "/").endsWith("proj/main.tex"), a);
  assert(b && existsSync(b), "output folder: " + b);
  return `${a} | ${b}`;
});

// ----------------------------------------------------------------- search
await test("search: Ctrl+Shift+F seeds the selection and lists hits", async () => {
  await js("await T.project.getState().openFile('main.tex'); const ed = T.bridge.activeEditor(); ed.setSelection({ startLineNumber: 9, startColumn: 10, endLineNumber: 9, endColumn: 16 }); ed.focus(); return true");
  await key(MOD.ctrl | MOD.shift, "F", "KeyF", 70);
  await waitFor("return T.ui.getState().sidebarTab === 'search' && $('.search-input')?.value === 'Method'");
  await waitFor("return $$('.search-hit').length > 0");
  const st = await js("return { files: $$('.search-file-name').map(e => e.textContent), hits: $$('.search-hit').length }");
  assert(st.files.includes("main.tex"), JSON.stringify(st));
  return JSON.stringify(st);
});

await test("search: case / whole word / regex toggles", async () => {
  const count = async () => {
    await sleep(500);
    await waitFor("return !$('.search-meta')?.textContent.includes('…') ");
    return js("return $$('.search-hit').length");
  };
  await js("__e2e.setVal($('.search-input'), 'section'); return true");
  const plain = await count();
  await js("$$('.search-toggles .icon-btn')[0].click(); return true"); // case
  await js("__e2e.setVal($('.search-input'), 'Section'); return true");
  const cased = await count();
  await js("$$('.search-toggles .icon-btn')[0].click(); $$('.search-toggles .icon-btn')[1].click(); return true"); // word
  await js("__e2e.setVal($('.search-input'), 'sectio'); return true");
  const word = await count();
  await js("$$('.search-toggles .icon-btn')[1].click(); $$('.search-toggles .icon-btn')[2].click(); return true"); // regex
  await js("__e2e.setVal($('.search-input'), '\\\\\\\\(sub)?section\\\\{'); return true");
  const rx = await count();
  await js("$$('.search-toggles .icon-btn')[2].click(); return true");
  assert(plain > cased && cased >= 1 && word === 0 && rx >= 3, JSON.stringify({ plain, cased, word, rx }));
  return JSON.stringify({ plain, cased, word, rx });
});

await test("search: clicking a hit opens the file at the line", async () => {
  await js("__e2e.setVal($('.search-input'), 'two sentences'); return true");
  await waitFor("return $$('.search-hit').length === 1");
  await js("$('.search-hit').click(); return true");
  await waitFor("return T.project.getState().activeTab === 'chapters/intro.tex' && T.bridge.activeEditor().getPosition().lineNumber === 3");
});

await test("search: replace in one file, then replace all (history recorded)", async () => {
  await js("__e2e.setVal($('.search-input'), 'Results'); return true");
  await waitFor("return $$('.search-hit').length >= 2");
  await js("$('[aria-label]', document).blur?.(); $$('.search-row .icon-btn-sm')[0].click(); return true"); // show replace
  await waitFor("return Boolean($('.search-replace-input'))");
  await js("__e2e.setVal($('.search-replace-input'), 'Findings'); return true");
  await sleep(300);
  await js("$('.search-replace-file').click(); return true");
  await waitFor("return Boolean($('.dialog-modal'))");
  await js("$('.dialog-modal .modal-footer .btn-primary').click(); return true");
  await poll(async () => (await readFile(join(PROJ, "main.tex"), "utf8")).includes("\\section{Findings}"));
  const main = await readFile(join(PROJ, "main.tex"), "utf8");
  assert(main.includes("\\section{Findings}") && !main.includes("Results go"), "replace failed");
  const hist = await js("return (await invoke('tb_history_list', { file: 'main.tex' })).length");
  assert(hist >= 1, "no history version recorded");
  // the editor tab follows the disk
  await js("await T.project.getState().openFile('main.tex'); return true");
  await waitFor("return T.bridge.activeEditor().getValue().includes('Findings go here')");
  // now replace all back
  await js("__e2e.setVal($('.search-input'), 'Findings'); __e2e.setVal($('.search-replace-input'), 'Results'); return true");
  await waitFor("return $$('.search-hit').length >= 2");
  await js("$('.search-replace-all').click(); return true");
  await waitFor("return Boolean($('.dialog-modal'))");
  await js("$('.dialog-modal .modal-footer .btn-primary').click(); return true");
  await waitFor("return $$('.search-hit').length === 0", { timeout: 8000 });
  const back = await readFile(join(PROJ, "main.tex"), "utf8");
  assert(back.includes("\\section{Results}"), "replace all failed");
  await shot("search-panel");
  return `versions: ${hist}`;
});

// --------------------------------------------------------------- history
await test("history: versions, diff and restore (restore is undoable)", async () => {
  await js("await T.project.getState().openFile('chapters/intro.tex'); const ed = T.bridge.activeEditor(); ed.setPosition({ lineNumber: 3, column: 1 }); ed.focus(); return true");
  await typeText("History line one. ");
  await key(MOD.ctrl, "s", "KeyS", 83);
  await waitFor("return !T.project.getState().tabs.find(t => t.path === 'chapters/intro.tex').dirty");
  await js("await invoke('tb_history_snapshot', { file: 'chapters/intro.tex' }); return true");
  await js("T.bridge.activeEditor().setPosition({ lineNumber: 3, column: 1 }); T.bridge.activeEditor().focus(); return true");
  await typeText("History line two. ");
  await key(MOD.ctrl, "s", "KeyS", 83);
  await waitFor("return !T.project.getState().tabs.find(t => t.path === 'chapters/intro.tex').dirty");
  const n = await js("return (await invoke('tb_history_list', { file: 'chapters/intro.tex' })).length");
  assert(n >= 2, `only ${n} versions`);
  await js("T.ui.getState().openModal({ kind: 'history', file: 'chapters/intro.tex' }); return true");
  await waitFor("return $$('.history-item').length >= 2");
  // newest version = before "two" was saved? pick the oldest to see a diff
  await js("$$('.history-item').at(-1).click(); return true");
  await waitFor("return $$('.history-diff .diff-line.add, .history-diff .diff-line.del').length > 0");
  await shot("history-modal");
  await js("$('.history-restore').click(); return true");
  await waitFor("return Boolean($('.dialog-modal'))");
  await js("$('.dialog-modal .modal-footer .btn-primary').click(); return true");
  await waitFor("return !T.bridge.activeEditor().getValue().includes('History line two')", { timeout: 8000 });
  const after = await js("return (await invoke('tb_history_list', { file: 'chapters/intro.tex' })).length");
  assert(after > n, "restore did not snapshot the current state first");
  await js("T.ui.getState().closeModal(); return true");
  return `${n} → ${after} versions`;
});

// --------------------------------------------------------------- outline
await test("outline: project outline follows \\input across files", async () => {
  await js("await T.project.getState().openFile('main.tex'); T.ui.getState().setSidebarTab('outline'); return true");
  await waitFor("return Boolean($('.outline-modes'))");
  await js("$$('.outline-modes button')[1].click(); return true");
  await waitFor("return $$('.outline-item').length >= 3", { timeout: 8000 });
  const titles = await js("return $$('.outline-item .outline-title').map(e => e.textContent)");
  assert(titles[0] === "Introduction" && titles.includes("Method"), JSON.stringify(titles));
  await js("$$('.outline-item')[0].click(); return true");
  await waitFor("return T.project.getState().activeTab === 'chapters/intro.tex'");
  return titles.join(" / ");
});

await test("outline: labels report (unused / undefined / duplicate)", async () => {
  await js("$$('.outline-modes button')[2].click(); return true");
  await waitFor("return Boolean($('.labels-view')) && $$('.labels-view .report-row').length > 0", { timeout: 8000 });
  const rep = await js("return await invoke('tb_reference_report')");
  const undef = rep.undefined_refs.map((u) => u.key);
  const dup = rep.duplicate_labels.map((u) => u.key);
  const unused = rep.labels.filter((l) => l.refs === 0).map((l) => l.key);
  assert(undef.includes("fig:missing"), "undefined: " + undef);
  assert(dup.includes("sec:intro"), "duplicate: " + dup);
  assert(unused.includes("sec:unused") && !unused.includes("eq:int"), "unused: " + unused);
  const ui = await js("return { warn: $$('.labels-view .report-section.warn').length, pills: $$('.labels-view .pill.warn').length }");
  assert(ui.warn === 2 && ui.pills >= 1, JSON.stringify(ui));
  await shot("labels-report");
  await js("$$('.outline-modes button')[0].click(); return true");
  return JSON.stringify({ undef, dup, unused });
});

await test("bibliography: cite counts, missing citations, uncited filter", async () => {
  await js("T.ui.getState().setSidebarTab('bib'); return true");
  await waitFor("return $$('.bib-item').length >= 2");
  const rep = await js("return await invoke('tb_reference_report')");
  const cites = Object.fromEntries(rep.bib.map((b) => [b.key, b.cites]));
  assert(cites.knuth1984 === 1 && cites.lamport1994 === 0, JSON.stringify(cites));
  assert(rep.missing_cites.some((m) => m.key === "nobody2020"), "missing cites: " + JSON.stringify(rep.missing_cites));
  await waitFor("return $('.bib-panel .report-section.warn, .report-section.warn')?.textContent.includes('nobody2020')");
  await js("$('.bib-unused-toggle input').click(); return true");
  await waitFor("return $$('.bib-item').length === 1");
  const only = await js("return $('.bib-item .bib-key').textContent");
  await js("$('.bib-unused-toggle input').click(); return true");
  assert(only === "lamport1994", only);
});

// ------------------------------------------------------------------ spell
await test("spell check: markers on prose only, quick fix, add to dictionary", async () => {
  await js("T.ui.getState().setEditorPrefs({ spellcheck: true }); await T.project.getState().openFile('spell.tex'); return true");
  await waitFor("const m = window.__tbMonaco.editor.getModelMarkers({ owner: 'spell', resource: T.bridge.activeEditor().getModel().uri }); return m.length >= 2", { timeout: 15000 });
  const words = await js("return window.__tbMonaco.editor.getModelMarkers({ owner: 'spell', resource: T.bridge.activeEditor().getModel().uri }).map(m => m.code)");
  assert(words.includes("sentense") && words.includes("Zorblax"), JSON.stringify(words));
  assert(!words.some((w) => ["documentclass", "htbp", "figure", "article"].includes(w)), "LaTeX syntax flagged: " + words);
  // quick fix: preferred suggestion at the cursor
  await js("const ed = T.bridge.activeEditor(); ed.setPosition({ lineNumber: 3, column: 8 }); ed.focus(); return true");
  await sleep(200);
  await js("T.bridge.activeEditor().trigger('e2e', 'editor.action.quickFix', null); return true");
  await waitFor("return $$('.action-widget .monaco-list-row').some(e => e.textContent.includes('→ sentence'))", { timeout: 8000 });
  await key(0, "Enter", "Enter", 13); // first entry = best suggestion
  await waitFor("return T.bridge.activeEditor().getModel().getLineContent(3).includes('This sentence has')", { timeout: 8000 });
  // add to dictionary through the code-action command
  await js("T.bridge.activeEditor().trigger('e2e', 'texbutler.spell.add', 'Zorblax'); return true");
  await waitFor("return !window.__tbMonaco.editor.getModelMarkers({ owner: 'spell', resource: T.bridge.activeEditor().getModel().uri }).some(m => m.code === 'Zorblax')", { timeout: 8000 });
  const dict = await js("return JSON.parse(localStorage.getItem('tb-spell-words') || '[]')");
  assert(dict.includes("Zorblax"), "not persisted");
  // toggle off clears markers
  await js("T.ui.getState().setEditorPrefs({ spellcheck: false }); return true");
  await waitFor("return window.__tbMonaco.editor.getModelMarkers({ owner: 'spell', resource: T.bridge.activeEditor().getModel().uri }).length === 0", { timeout: 8000 });
  await js("T.bridge.activeEditor().getModel().undo?.(); await T.project.getState().reloadTab('spell.tex'); return true");
  return words.join(", ");
});

// ---------------------------------------------------------- editor prefs
await test("editor prefs: Ctrl+= / Ctrl+- / Ctrl+0 font size, wrap, line numbers", async () => {
  await js("await T.project.getState().openFile('main.tex'); T.bridge.activeEditor().focus(); return true");
  const fs = () => js("return T.bridge.activeEditor().getRawOptions().fontSize");
  const base = await fs();
  await key(MOD.ctrl, "=", "Equal", 187);
  await waitFor(`return T.bridge.activeEditor().getRawOptions().fontSize === ${base + 1}`);
  await key(MOD.ctrl, "-", "Minus", 189);
  await key(MOD.ctrl, "-", "Minus", 189);
  await waitFor(`return T.bridge.activeEditor().getRawOptions().fontSize === ${base - 1}`);
  await key(MOD.ctrl, "0", "Digit0", 48);
  await waitFor("return T.bridge.activeEditor().getRawOptions().fontSize === 14");
  await js("T.ui.getState().setEditorPrefs({ wordWrap: false, lineNumbers: false }); return true");
  await waitFor("const o = T.bridge.activeEditor().getRawOptions(); return o.wordWrap === 'off' && o.lineNumbers === 'off'");
  await js("T.ui.getState().setEditorPrefs({ wordWrap: true, lineNumbers: true }); return true");
  await waitFor("const o = T.bridge.activeEditor().getRawOptions(); return o.wordWrap !== 'off' && o.lineNumbers !== 'off'");
  // settings UI exposes them
  await js("T.ui.getState().openModal({ kind: 'settings', section: 'editor' }); return true");
  await waitFor("return Boolean($('.settings-spell')) && $$('.settings-modal .ios-switch').length >= 3");
  await shot("settings-editor");
  await js("T.ui.getState().closeModal(); return true");
  return `base ${base}`;
});

// ------------------------------------------------------------- pdf + sync
await test("pdf viewer: compile renders pages with pdf.js and a text layer", async () => {
  await js("T.ui.getState().setPanel('pdf', true); T.compile.getState().compile('main'); return true");
  await waitFor("return T.compile.getState().running");
  await waitFor("return !T.compile.getState().running", { timeout: 180000 });
  await waitFor("return $$('.pdf-page .pdf-canvas').length >= 1", { timeout: 20000 });
  await waitFor("return $$('.pdf-page .textLayer span').length > 5", { timeout: 10000 });
  const st = await js("return { pages: Number($('.pdf-viewer').dataset.pages), total: $('.pdf-page-total').textContent, text: $('.pdf-page .textLayer').textContent.slice(0, 80) }");
  assert(st.pages >= 1 && st.text.includes("E2E Demo"), JSON.stringify(st));
  return JSON.stringify(st);
});

await test("pdf viewer: zoom buttons, Ctrl+wheel, fit width", async () => {
  const scale = () => js("return Number($('.pdf-viewer').dataset.scale)");
  const s0 = await scale();
  await js("$('.pdf-zoom .icon-btn:last-of-type').click(); return true"); // fit (last in group)
  await js("$$('.pdf-zoom .icon-btn')[1].click(); return true"); // zoom in
  await sleep(300);
  const s1 = await scale();
  await js("const v = $('.pdf-viewer'); const r = v.getBoundingClientRect(); v.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true, clientX: r.left + 50, clientY: r.top + 50 })); return true");
  await sleep(300);
  const s2 = await scale();
  await js("$$('.pdf-zoom .icon-btn')[2].click(); return true"); // fit width
  await sleep(300);
  const s3 = await scale();
  assert(s1 > s2 && s2 > 0, JSON.stringify({ s0, s1, s2, s3 }));
  await waitFor("return $$('.pdf-page .pdf-canvas').length >= 1");
  return JSON.stringify({ s0, s1, s2, s3 });
});

await test("pdf viewer: forward search marks the line; position kept after recompile", async () => {
  const pos = await js("return await invoke('tb_synctex_forward_pos', { file: 'main.tex', line: 13 })");
  assert(pos && pos.page === 1 && pos.y > 0, "forward pos: " + JSON.stringify(pos));
  await js(`T.ui.getState().showPdfPage(${pos.page}, ${pos.y}, ${pos.h}); return true`);
  await waitFor("return Boolean($('.pdf-sync-marker'))");
  // zoom in so there is something to scroll, scroll down, recompile
  for (let i = 0; i < 8; i++) {
    await js("$$('.pdf-zoom .icon-btn')[1].click(); return true");
    await sleep(80);
  }
  await waitFor("const v = $('.pdf-viewer'); return v.scrollHeight > v.clientHeight + 600");
  await js("$('.pdf-viewer').scrollTop = 400; $('.pdf-viewer').dispatchEvent(new Event('scroll')); return true");
  await sleep(300);
  const before = await js("return $('.pdf-viewer').scrollTop");
  await js("T.compile.getState().compile('main'); return true");
  await waitFor("return T.compile.getState().running");
  await waitFor("return !T.compile.getState().running", { timeout: 180000 });
  await sleep(1500);
  const after = await js("return $('.pdf-viewer').scrollTop");
  assert(before > 100 && Math.abs(after - before) < 60, JSON.stringify({ before, after }));
  await js("$$('.pdf-zoom .icon-btn')[2].click(); return true");
  return JSON.stringify({ pos, before, after });
});

await test("pdf viewer: page jump input", async () => {
  // a two-page document: add a page break temporarily
  const pages = await js("return Number($('.pdf-viewer').dataset.pages)");
  await js("const i = $('.pdf-page-input'); __e2e.setVal(i, '1'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true");
  await sleep(300);
  const top = await js("return $('.pdf-viewer').scrollTop");
  assert(top < 20, "page 1 not at top: " + top);
  return `pages=${pages}`;
});

await test("pdf viewer: double-click reverse search jumps to the source line", async () => {
  await js("await T.project.getState().openFile('chapters/intro.tex'); return true");
  const pos = await js("return await invoke('tb_synctex_forward_pos', { file: 'main.tex', line: 13 })");
  await js(`
    const page = $('.pdf-page[data-page="${pos.page}"]');
    const scale = Number($('.pdf-viewer').dataset.scale);
    page.scrollIntoView();
    const r = page.getBoundingClientRect();
    const x = r.left + (${pos.x} + ${pos.w || 20} / 2) * scale, y = r.top + (${pos.y} - ${pos.h || 8} / 2) * scale;
    page.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
    return true`);
  await waitFor("return T.project.getState().activeTab === 'main.tex'", { timeout: 8000 });
  const line = await js("return T.bridge.activeEditor().getPosition().lineNumber");
  assert(line >= 12 && line <= 15, "line " + line);
  await shot("pdf-viewer");
  return `line ${line}`;
});

await test("pdf: save as copies the PDF; output folder exists", async () => {
  const dest = join(tmpdir(), "texbutler-e2e-saved.pdf");
  const out = await js(`return await invoke('tb_save_pdf_as', { dest: ${JSON.stringify(dest)} })`);
  assert(existsSync(dest) && statSync(dest).size > 1000, "saved " + out);
  const bad = await js("try { await invoke('tb_save_pdf_as', { dest: 'C:/Windows/evil.txt' }); return 'accepted'; } catch (e) { return String(e); }");
  assert(bad !== "accepted", "non-pdf destination accepted");
  return out;
});

// -------------------------------------------------------------------- git
await test("git: status badges in the tree and branch in the status bar", async () => {
  const git = (...a) => execFileSync("git", a, { cwd: PROJ, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "-m", "init", "--no-gpg-sign");
  await writeFile(join(PROJ, "chapters", "intro.tex"), (await readFile(join(PROJ, "chapters", "intro.tex"), "utf8")) + "\nGit change.\n", "utf8");
  await writeFile(join(PROJ, "newfile.tex"), "% untracked\n", "utf8");
  await js("await T.project.getState().refresh(); window.dispatchEvent(new Event('focus')); return true");
  await waitFor("return $('.status-git')?.textContent.includes('main')", { timeout: 10000 });
  await js("T.ui.getState().setSidebarTab('files'); return true");
  await waitFor("return Boolean($('.tree-body [data-path=\"newfile.tex\"] .git-badge'))", { timeout: 20000 }).catch(async (e) => {
    const st = await js("return JSON.stringify({ api: (await invoke('tb_git_status')).files.map(f => f.path + ':' + f.status), tree: $$('.tree-body [data-path]').map(n => n.dataset.path) })");
    throw new Error(`${e.message} ${st}`);
  });
  const badges = await js("return $$('.tree-body .tree-node').filter(n => n.querySelector('.git-badge')).map(n => n.dataset.path + '=' + n.querySelector('.git-badge').textContent)");
  const dot = await js("return Boolean($('.tree-body [data-path=\"chapters\"] .git-dot'))");
  assert(badges.some((b) => b.startsWith("newfile.tex=U")), "badges: " + badges);
  assert(dot, "folder dot missing");
  await shot("git-tree");
  return badges.join(", ");
});

// ---------------------------------------------------------------- engine
await test("engine: setup dialog shows the detected engines", async () => {
  await js("T.ui.getState().openModal({ kind: 'engine' }); return true");
  await waitFor("return Boolean($('.engine-modal')) && $$('.engine-modal .ok-icon, .engine-modal .bad-icon').length === 2");
  const st = await js("return await invoke('tb_engine_status')");
  assert(st.can_compile, JSON.stringify(st));
  await shot("engine-modal");
  return JSON.stringify(st);
});

if (!SKIP_NETWORK) {
  await test("engine: one-click Tectonic install, then compile with Tectonic", async () => {
    await js("$('.engine-install').click(); return true");
    await waitFor("return $('.engine-modal .progress') !== null || !$('.engine-install').disabled", { timeout: 20000 });
    await waitFor("return !$('.engine-install').disabled", { timeout: 600000, interval: 1000 });
    const err = await js("return $('.engine-modal .modal-error')?.textContent ?? null");
    assert(!err, "install error: " + err);
    const st = await js("return await invoke('tb_engine_status')");
    assert(st.tectonic, "tectonic not detected: " + JSON.stringify(st));
    await js("T.ui.getState().closeModal(); await invoke('tb_set_engine', { preference: 'tectonic' }); return true");
    await js("T.compile.getState().compile('main'); return true");
    await waitFor("return T.compile.getState().running");
    await waitFor("return !T.compile.getState().running", { timeout: 900000, interval: 2000 });
    const res = await js("const r = T.compile.getState().lastResult; return { ok: r?.ok, engine: r?.engine, fell: r?.fell_back }");
    assert(res.ok && res.engine === "tectonic" && !res.fell, JSON.stringify(res));
    return `${st.tectonic} → ${JSON.stringify(res)}`;
  });
}
await js(`await invoke('tb_set_engine', { preference: ${JSON.stringify(savedEngine)} }); T.ui.getState().closeModal(); return true`);

// --------------------------------------------------------------- updater
await test("updater: an older version sees the release in the update sheet", async () => {
  const info = await js("return await invoke('tb_check_updates', { pretendCurrent: '0.6.0' })");
  assert(info && info.asset_url && info.asset_url.endsWith("-setup.exe") && info.asset_size > 1e6, JSON.stringify(info));
  await js(`T.ui.getState().openModal({ kind: 'update', info: ${JSON.stringify(info)} }); return true`);
  await waitFor("return Boolean($('.update-modal .update-download'))");
  await shot("update-modal");
  return `${info.version} ${info.asset_name} ${info.asset_size}`;
});

if (!SKIP_NETWORK) {
  await test("updater: download verifies the installer size (no install)", async () => {
    await js("$('.update-download').click(); return true");
    await waitFor("return Boolean($('.update-install')) || Boolean($('.update-modal .modal-error'))", { timeout: 900000, interval: 1000 });
    const err = await js("return $('.update-modal .modal-error')?.textContent ?? null");
    assert(!err, err);
    const info = await js("return await invoke('tb_check_updates', { pretendCurrent: '0.6.0' })");
    const file = join(tmpdir(), "texbutler-update", info.asset_name);
    assert(existsSync(file) && statSync(file).size === info.asset_size, `size ${existsSync(file) ? statSync(file).size : "missing"} != ${info.asset_size}`);
    return file;
  });
}

await test("updater: refuses foreign URLs and installers outside the update folder", async () => {
  const a = await js("try { await invoke('tb_download_update', { url: 'https://evil.example/x-setup.exe', size: null }); return 'accepted'; } catch (e) { return String(e); }");
  const b = await js("try { await invoke('tb_install_update', { path: 'C:/Windows/notepad.exe' }); return 'accepted'; } catch (e) { return String(e); }");
  await js("T.ui.getState().closeModal(); return true");
  assert(a !== "accepted" && b !== "accepted", `${a} | ${b}`);
  return `${a.slice(0, 40)} | ${b.slice(0, 40)}`;
});

// -------------------------------------------------------------------- AI
const aiReady = await js("try { const s = await invoke('tb_ai_get_settings'); return Boolean(s && s.api_key && s.model); } catch { return false; }");
await test("AI: image → LaTeX formula answers (formula or a clear not-supported message)", async () => {
  if (!aiReady) return "skipped: no AI config";
  const png = join(PROJ, "figures", "dot.png").replaceAll("\\", "/");
  const res = await js(`try { return { ok: await invoke('tb_ai_image_to_latex', { path: ${JSON.stringify(png)} }) }; } catch (e) { return { err: String(e) }; }`);
  assert(res.ok !== undefined || /图片|image|vision/i.test(res.err), JSON.stringify(res));
  return JSON.stringify(res).slice(0, 160);
});

await test("AI: fix all compile errors in one go", async () => {
  if (!aiReady) return "skipped: no AI config";
  await writeFile(
    join(PROJ, "twoerr.tex"),
    String.raw`\documentclass{article}
\begin{document}
First \textbf{bold text.

Second \undefinedcommandxyz{here}.
\end{document}
`,
    "utf8",
  );
  await js("await T.project.getState().refresh(); await T.project.getState().openFile('twoerr.tex'); T.compile.getState().compile('current'); return true");
  await waitFor("return T.compile.getState().running");
  await waitFor("return !T.compile.getState().running", { timeout: 180000 });
  const before = await js("return T.compile.getState().compileIssues.filter(i => i.severity === 'error').length");
  assert(before >= 1, "fixture compiled without errors");
  await js("T.ui.getState().showProblems('compile'); return true");
  await waitFor("return Boolean($('.problems-fix-all'))");
  await js("$('.problems-fix-all').click(); return true");
  await waitFor("return T.ai.getState().busy", { timeout: 10000 });
  await waitFor("return !T.ai.getState().busy && !T.compile.getState().running", { timeout: 600000, interval: 1000 });
  const after = await js("return { errors: T.compile.getState().compileIssues.filter(i => i.severity === 'error').length, ok: T.compile.getState().lastResult?.ok }");
  await shot("ai-fix-all");
  assert(after.errors === 0 && after.ok, `before=${before} after=${JSON.stringify(after)}`);
  return `errors ${before} → 0`;
});

// ---------------------------------------------------------------- cleanup
console.log("\nconsole errors:", c.consoleErrors.length);
for (const e of c.consoleErrors.slice(0, 10)) console.log("  ", String(e).slice(0, 400));
await js(`if (T.project.getState().root) await T.project.getState().closeProject();
  const saved = ${savedStorage};
  localStorage.clear();
  for (const [k, v] of Object.entries(saved)) localStorage.setItem(k, v);
  return true`);
await c.send("Page.reload");
await r.save();
c.close();
process.exit(0);
