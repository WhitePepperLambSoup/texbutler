import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, runner, assert, sleep, MOD } from "./lib.mjs";
import { makeFixture, PROJ, PROJ_FWD, NEWPROJ_PARENT } from "./fixture.mjs";

await makeFixture();
const c = await connect();
const { js, waitFor, key, typeText, shot } = c;
const r = runner("extra");
const P = JSON.stringify(PROJ_FWD);

await c.send("Page.reload");
await waitFor("return Boolean(window.__tb && document.querySelector('.toolbar'))", { timeout: 30000 });
await js(`if (T.project.getState().root) await T.project.getState().closeProject(); await T.project.getState().openProject(${P}); return true`);
await waitFor("return Boolean(T.bridge.activeEditor())");
const disk = (path) => js(`return await invoke('tb_read_file', { path: ${JSON.stringify(path)} })`);

await r.test("Chinese project (ctexart template) compiles to PDF", async () => {
  await js(`await T.project.getState().createProject(${JSON.stringify(NEWPROJ_PARENT.replaceAll("\\", "/"))}, 'zh-proj', 'article'); return true`);
  await waitFor("return T.project.getState().root.includes('zh-proj')");
  const src = await disk("main.tex");
  await js("T.compile.getState().compile('main'); return true");
  await waitFor("return T.compile.getState().running");
  await waitFor("return !T.compile.getState().running", { timeout: 300000 });
  const st = await js("const r = T.compile.getState().lastResult; return { ok: r?.ok, engine: r?.engine, fell: r?.fell_back, pdf: T.project.getState().pdfPath, errors: T.compile.getState().compileIssues.filter(i => i.severity === 'error').map(i => i.message.slice(0, 120)) }");
  await shot("zh-compiled");
  assert(st.ok && st.pdf, JSON.stringify(st) + " src=" + src.slice(0, 120));
  return `${st.engine}${st.fell ? " (fallback)" : ""}; ${src.split("\n")[0]}`;
});

await r.test("import a ready marketplace template into the open project", async () => {
  const list = await js("return (await invoke('tb_list_market_templates')).filter(t => t.ready).map(t => t.id)");
  assert(list.length > 0, "no ready templates");
  await js("T.ui.getState().openModal({ kind: 'newFile' }); return true");
  await waitFor("return Boolean($('.new-file-modal'))");
  await js("$('[data-new-file-tab=market]').click(); return true");
  await waitFor("return $$('.market-card').length > 0");
  await js(`$$('.market-card').find(b => b.dataset.templateId === ${JSON.stringify(list[0])}).click(); return true`);
  await waitFor(`return Boolean($('.market-card.template-active'))`);
  await js("$('.new-file-modal .modal-footer .btn-primary').click(); return true");
  await waitFor("return !$('.new-file-modal')", { timeout: 60000 });
  const active = await js("return T.project.getState().activeTab");
  assert(active && active.endsWith(".tex"), `active=${active}`);
  return `${list[0]} → ${active} (ready: ${list.length})`;
});

await js(`await T.project.getState().openProject(${P}); return true`);
await waitFor("return Boolean(T.bridge.activeEditor())");

await r.test("external change to an open, clean file reloads the editor", async () => {
  await js("await T.project.getState().openFile('notes.tex'); return true");
  await sleep(500);
  await writeFile(join(PROJ, "notes.tex"), "\\documentclass{article}\n\\begin{document}\nChanged outside.\n\\end{document}\n", "utf8");
  await waitFor("return T.project.getState().tabs.find(t => t.path === 'notes.tex').content.includes('Changed outside')", { timeout: 8000 });
});

await r.test("external change to a DIRTY open file is not silently overwritten", async () => {
  await js("await T.project.getState().openFile('notes.tex'); T.bridge.activeEditor().setPosition({ lineNumber: 3, column: 1 }); T.bridge.activeEditor().focus(); return true");
  await typeText("Local edit. ");
  await writeFile(join(PROJ, "notes.tex"), "\\documentclass{article}\n\\begin{document}\nSecond outside change.\n\\end{document}\n", "utf8");
  await sleep(2500);
  const st = await js("return { toasts: T.feedback.getState().toasts.map(t => t.text), dialogs: T.feedback.getState().dialogs.length, tab: T.project.getState().tabs.find(t => t.path === 'notes.tex').content }");
  assert(st.toasts.some((t) => t.includes("notes.tex")) || st.dialogs > 0, "user was not told about the conflicting external change: " + JSON.stringify(st));
  await js("await T.project.getState().reloadTab('notes.tex'); T.project.setState(s => ({ tabs: s.tabs.map(t => t.path === 'notes.tex' ? { ...t, dirty: false } : t) })); return true");
  return JSON.stringify(st.toasts);
});

await r.test("closing a dirty tab saves it first", async () => {
  await js("await T.project.getState().openFile('chapters/intro.tex'); T.bridge.activeEditor().setPosition({ lineNumber: 3, column: 1 }); T.bridge.activeEditor().focus(); return true");
  await typeText("Saved on close. ");
  await js("$$('.editor-tab').find(e => e.title === 'chapters/intro.tex').querySelector('.editor-tab-close').click(); return true");
  await waitFor("return !T.project.getState().tabs.some(t => t.path === 'chapters/intro.tex')");
  assert((await disk("chapters/intro.tex")).includes("Saved on close."), "not saved");
});

await r.test("auto-compile after save (setting on)", async () => {
  await js("const f = JSON.parse(localStorage.getItem('tb-flow') || '{}'); f.autoCompile = true; localStorage.setItem('tb-flow', JSON.stringify(f)); await T.project.getState().openFile('main.tex'); return true");
  const before = await js("return T.compile.getState().lastResult");
  await js("T.bridge.activeEditor().setPosition({ lineNumber: 22, column: 1 }); T.bridge.activeEditor().focus(); return true");
  await typeText("Auto. ");
  await key(MOD.ctrl, "s", "KeyS", 83);
  await waitFor("return T.compile.getState().running", { timeout: 8000 });
  await waitFor("return !T.compile.getState().running", { timeout: 120000 });
  await js("const f = JSON.parse(localStorage.getItem('tb-flow')); f.autoCompile = false; localStorage.setItem('tb-flow', JSON.stringify(f)); return true");
  const ok = await js("return T.compile.getState().lastResult?.ok");
  assert(ok, "auto compile failed");
  return before ? "recompiled" : "compiled";
});

await r.test("auto-save after the configured interval (10 s)", async () => {
  const prev = await js("return localStorage.getItem('tb-autosave-secs')");
  await js("localStorage.setItem('tb-autosave-secs', '10'); T.bridge.activeEditor().setPosition({ lineNumber: 22, column: 1 }); T.bridge.activeEditor().focus(); return true");
  await typeText("AutoSaved. ");
  await waitFor("return !T.project.getState().tabs.find(t => t.path === 'main.tex').dirty", { timeout: 15000 });
  await js(`localStorage.setItem('tb-autosave-secs', ${JSON.stringify(prev ?? "30")}); return true`);
  assert((await disk("main.tex")).includes("AutoSaved."), "not on disk");
});

await r.test("session restore: reload reopens project and last file", async () => {
  await js("await T.project.getState().openFile('chapters/intro.tex'); return true");
  await c.send("Page.reload");
  await waitFor("return Boolean(window.__tb) && T.project.getState().activeTab === 'chapters/intro.tex'", { timeout: 30000 });
});

await r.test("English UI has no leftover Chinese strings", async () => {
  await js("(await import('/src/i18n/index.ts')).useI18n.getState().setLang('en'); return true").catch(() => {});
  await js("localStorage.setItem('tb-lang','en'); return true");
  await c.send("Page.reload");
  await waitFor("return Boolean(window.__tb) && Boolean(T.bridge.activeEditor())", { timeout: 30000 });
  const scan = async (label) => {
    const hits = await js(`const out = []; const walk = (n) => { if (n.nodeType === 3) { const s = n.textContent.trim(); if (/[\\u4e00-\\u9fa5]/.test(s) && !n.parentElement.closest('.monaco-editor, .ai-text, .ai-msg, .tree-body, .bib-list, .problems-body, .welcome-recent, .palette-input-row, .session-select')) out.push(s.slice(0, 40)); } else if (n.nodeType === 1 && !['SCRIPT','STYLE'].includes(n.tagName)) { for (const ch of n.childNodes) walk(ch); const t = n.getAttribute && (n.getAttribute('title') || n.getAttribute('aria-label') || n.getAttribute('placeholder')); if (t && /[\\u4e00-\\u9fa5]/.test(t) && !n.closest('.monaco-editor')) out.push('@' + t.slice(0, 40)); } }; walk(document.body); return [...new Set(out)]`);
    return hits.map((h) => `${label}: ${h}`);
  };
  let all = await scan("main");
  for (const tab of ["outline", "bib", "todo"]) {
    await js(`T.ui.getState().setSidebarTab('${tab}'); return true`);
    await sleep(300);
    all = all.concat(await scan(tab));
  }
  for (const section of ["general", "editor", "compile", "ai", "rules"]) {
    await js(`T.ui.getState().openModal({ kind: 'settings', section: '${section}' }); return true`);
    await sleep(400);
    all = all.concat(await scan(`settings/${section}`));
  }
  await js("T.ui.getState().closeModal(); T.ui.getState().openModal({ kind: 'newFile' }); return true");
  await sleep(400);
  all = all.concat(await scan("newFile"));
  await js("T.ui.getState().closeModal(); T.ui.getState().openPalette('commands'); return true");
  await sleep(300);
  all = all.concat(await scan("palette"));
  await js("T.ui.getState().closePalette(); $$('.format-bar button[aria-haspopup=menu]').forEach(() => {}); return true");
  await shot("english-ui");
  await js("localStorage.setItem('tb-lang','zh'); return true");
  await c.send("Page.reload");
  await waitFor("return Boolean(window.__tb)", { timeout: 30000 });
  const real = [...new Set(all)].filter((h) => !/Language|简体中文|Switch language/.test(h)); assert(real.length === 0, real.join(" | "));
});

console.log("\nconsole errors:", c.consoleErrors.length);
for (const e of c.consoleErrors.slice(0, 10)) console.log("  ", String(e).slice(0, 400));
await r.save();
c.close();
process.exit(0);
