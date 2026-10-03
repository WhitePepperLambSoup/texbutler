// AI end-to-end suite — uses the user's saved provider config (never edited).
import { connect, runner, assert, sleep, MOD } from "./lib.mjs";
import { makeFixture, PROJ_FWD } from "./fixture.mjs";

await makeFixture();
const c = await connect();
const { js, waitFor, typeText, shot } = c;
const r = runner("ai");
const P = JSON.stringify(PROJ_FWD);
const AI_TIMEOUT = 240000;

await c.send("Page.reload");
await waitFor("return Boolean(window.__tb && document.querySelector('.toolbar'))", { timeout: 30000 });
await js(`if (T.project.getState().root) await T.project.getState().closeProject(); await T.project.getState().openProject(${P}); T.ui.getState().setPanel('ai', true); return true`);
await waitFor("return Boolean(T.bridge.activeEditor())");

const disk = (path) => js(`return await invoke('tb_read_file', { path: ${JSON.stringify(path)} })`);
const lastAssistant = () => js("const m = T.ai.getState().messages.filter(m => m.role !== 'user'); const x = m[m.length - 1]; return x ? { kind: x.kind, text: x.text, applied: !!x.applied, diff: !!x.diff } : null");
const idle = () => waitFor("return !T.ai.getState().busy", { timeout: AI_TIMEOUT, interval: 500 });

await r.test("provider configured + test connection", async () => {
  const s = await js("return await invoke('tb_ai_get_settings')");
  assert(s.provider && s.model, "no settings");
  const res = await js("return await invoke('tb_ai_test_connection')", AI_TIMEOUT);
  return `${s.provider.kind} / ${s.model} → ${String(res).slice(0, 120)}`;
});

await r.test("chat: streamed answer about the current file", async () => {
  await js("T.ai.getState().newSession(); return true");
  await js("$('.ai-generate-input').focus(); return true");
  await typeText("用一句话说明当前文件是什么文档、有哪些章节？只回答，不要修改文件。");
  await js("$('.ai-send-action').click(); return true");
  await waitFor("return T.ai.getState().busy");
  // streaming: some text should appear before completion
  const sawPartial = await waitFor("const m = T.ai.getState().messages.at(-1); return m.role === 'assistant' && m.text.length > 0", { timeout: AI_TIMEOUT });
  await idle();
  const m = await lastAssistant();
  assert(m && m.kind === "plain" && m.text.length > 10, JSON.stringify(m));
  assert(!m.applied, "plain question must not edit files");
  await shot("ai-chat");
  return `${sawPartial ? "streamed" : ""} ${m.text.slice(0, 120)}`;
});

await r.test("chat edit: AI edits the file, editor reloads, rollback restores", async () => {
  await js("await T.project.getState().openFile('chapters/intro.tex'); return true");
  const before = await disk("chapters/intro.tex");
  await js("$('.ai-generate-input').focus(); return true");
  await typeText("请修改当前文件 chapters/intro.tex：把句子 “It has two sentences.” 改成 “It has exactly two sentences.”，其他内容保持不变。");
  await js("$('.ai-send-action').click(); return true");
  await waitFor("return T.ai.getState().busy");
  await idle();
  const after = await disk("chapters/intro.tex");
  const m = await lastAssistant();
  assert(after.includes("exactly two sentences"), `file not edited; reply=${m?.text?.slice(0, 200)}`);
  const tab = await js("return T.project.getState().tabs.find(t => t.path === 'chapters/intro.tex').content");
  assert(tab.includes("exactly two sentences"), "editor tab not reloaded");
  await waitFor("return $$('.ai-msg-actions .btn-danger').length > 0");
  await shot("ai-edit");
  await js("$$('.ai-msg-actions .btn-danger')[0].click(); return true");
  await idle();
  await waitFor(`return (await invoke('tb_read_file', { path: 'chapters/intro.tex' })) === ${JSON.stringify(before)}`, { timeout: 15000 });
  await waitFor("return !T.project.getState().tabs.find(t => t.path === 'chapters/intro.tex').content.includes('exactly')");
  return m.text.slice(0, 100);
});

await r.test("explain a compile error from the problems panel", async () => {
  // the rollback in the previous test triggers a rebuild: let it finish
  await waitFor("return !T.compile.getState().running", { timeout: 120000, interval: 500 });
  await js("await T.project.getState().openFile('broken.tex'); T.compile.getState().compile('current'); return true");
  await waitFor("return T.compile.getState().running");
  await waitFor("return !T.compile.getState().running", { timeout: 120000 });
  const idx = await js("return T.compile.getState().compileIssues.findIndex(i => i.severity === 'error')");
  assert(idx >= 0, "no compile error");
  const issue = await js(`return T.compile.getState().compileIssues[${idx}]`);
  await js(`$$('.problem-row')[${idx}].querySelector('.problem-actions .btn:not(.btn-primary)').click(); return true`);
  await waitFor("return T.ai.getState().busy");
  await idle();
  const m = await lastAssistant();
  assert(m.kind === "diagnosis", JSON.stringify(m).slice(0, 300));
  return `${issue.file}:${issue.line} → ${m.text.slice(0, 120)}`;
});

await r.test("AI fix: writes + compiles, keep/undo bar, undo restores", async () => {
  const before = await disk("broken.tex");
  const idx = await js("return T.compile.getState().compileIssues.findIndex(i => i.severity === 'error')");
  await js(`$$('.problem-row')[${idx}].querySelector('.problem-actions .btn-primary').click(); return true`);
  await waitFor("return T.ai.getState().busy");
  await idle();
  const st = await js("return { pending: Boolean(T.ai.getState().diffPending), ok: T.ai.getState().diffPending?.ok, last: T.ai.getState().messages.at(-1)?.text?.slice(0, 200) }");
  const after = await disk("broken.tex");
  await shot("ai-fix");
  assert(st.pending && st.ok, JSON.stringify(st));
  assert(after !== before, "file not changed by fix");
  // the UI must reflect the fix: editor reloaded + rebuilt without errors
  await waitFor("return T.project.getState().tabs.find(t => t.path === 'broken.tex')?.content === undefined || !T.project.getState().tabs.find(t => t.path === 'broken.tex').content.includes('undefinedmacro')", { timeout: 15000 });
  await waitFor("return !T.compile.getState().running && T.compile.getState().lastResult?.ok === true", { timeout: 120000, interval: 500 });
  const noteRows = await js("return $$('.ai-msg .diff-line.note').length");
  await js("$$('.ai-diff-bar .btn').at(-1).click(); return true"); // 撤销修改
  await waitFor(`return (await invoke('tb_read_file', { path: 'broken.tex' })) === ${JSON.stringify(before)}`, { timeout: 15000 });
  // and after undo the UI shows the error again
  await waitFor("return !T.compile.getState().running && T.compile.getState().lastResult?.ok === false", { timeout: 120000, interval: 500 });
  return `${st.last} (explanation rows rendered as notes: ${noteRows})`;
});

await r.test("suggest mode: fix proposes hunks without touching disk; apply hunk edits", async () => {
  await js("if (!T.ai.getState().suggestMode) $('.ai-suggest-toggle').click(); return true");
  const before = await disk("broken.tex");
  const idx = await js("return T.compile.getState().compileIssues.findIndex(i => i.severity === 'error')");
  await js(`$$('.problem-row')[${idx}].querySelector('.problem-actions .btn-primary').click(); return true`);
  await waitFor("return T.ai.getState().busy");
  await idle();
  const st = await js("return { suggested: T.ai.getState().diffPending?.suggested, hunks: T.ai.getState().diffPending?.hunks?.length ?? 0, last: T.ai.getState().messages.at(-1)?.text?.slice(0, 160) }");
  assert((await disk("broken.tex")) === before, "suggest mode changed the file");
  assert(st.suggested && st.hunks > 0, JSON.stringify(st));
  await js("$$('.ai-hunk .btn-primary')[0].click(); return true");
  await waitFor(`return (await invoke('tb_read_file', { path: 'broken.tex' })) !== ${JSON.stringify(before)}`, { timeout: 30000 });
  await js("$('.ai-suggest-toggle').click(); T.ai.getState().rejectDiff(); return true");
  await js(`await invoke('tb_write_file', { path: 'broken.tex', content: ${JSON.stringify(before)} }); await T.project.getState().reloadTab('broken.tex'); return true`);
  return JSON.stringify(st);
});

await r.test("AI snapshots timeline lists fixes", async () => {
  await js("$('.ai-menu-anchor > button').click(); return true");
  await waitFor("return Boolean($('.ai-menu'))");
  await js("$$('.ai-menu .ai-menu-item').find(b => b.textContent.includes('时间线')).click(); return true");
  await waitFor("return $$('.ai-hunks .ai-hunk').length > 0 || $$('.ai-hunks .ai-hunk-why').length > 0", { timeout: 10000 });
  const n = await js("return $$('.ai-hunks .ai-hunk').length");
  assert(n > 0, "no snapshots");
  return `${n} snapshots`;
});

await r.test("sessions: per-file binding, rename + delete via in-app dialogs", async () => {
  const s1 = await js("return T.ai.getState().sessionId");
  await js("await T.project.getState().openFile('notes.tex'); return true");
  await sleep(300);
  const s2 = await js("return T.ai.getState().sessionId");
  await js("T.ai.getState().newSession(); return true");
  const s3 = await js("return T.ai.getState().sessionId");
  await js("$('.ai-menu-anchor > button').click(); return true");
  await waitFor("return Boolean($('.ai-menu'))");
  await js("$$('.ai-menu .ai-menu-item').find(b => b.textContent.includes('重命名')).click(); return true");
  await waitFor("return Boolean($('.dialog-input'))");
  await js(`const i = $('.dialog-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'E2E 会话'); i.dispatchEvent(new Event('input', { bubbles: true })); return true`);
  await js("$('.dialog-modal .btn-primary').click(); return true");
  await waitFor("return T.ai.getState().sessions.find(s => s.id === T.ai.getState().sessionId)?.name === 'E2E 会话'");
  await js("await T.project.getState().openFile('broken.tex'); return true");
  await sleep(300);
  const back = await js("return T.ai.getState().sessionId");
  await js("await T.project.getState().openFile('notes.tex'); return true");
  await sleep(300);
  const notesAgain = await js("return T.ai.getState().sessionId");
  await js("$('.ai-menu-anchor > button').click(); return true");
  await waitFor("return Boolean($('.ai-menu'))");
  await js("$$('.ai-menu .ai-menu-item').find(b => b.textContent.includes('删除')).click(); return true");
  await waitFor("return Boolean($('.dialog-modal .btn-danger'))");
  await js("$('.dialog-modal .btn-danger').click(); return true");
  await waitFor(`return !T.ai.getState().sessions.some(s => s.id === ${JSON.stringify(s3)})`);
  assert(notesAgain === s3, `notes binding lost: ${notesAgain} vs ${s3}`);
  return JSON.stringify({ s1, s2, s3, back });
});

await r.test("translate selection to English (format bar)", async () => {
  await js("await T.project.getState().openFile('rules-sample.tex'); return true");
  await waitFor("return T.bridge.activeEditor()?.getModel()?.getLineContent(3)?.includes('第一段')");
  await js("const ed = T.bridge.activeEditor(); const n = ed.getModel().getLineContent(3).length; ed.setSelection({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: n + 1 }); ed.focus(); return true");
  await js("$$('.format-bar button').find(b => b.title.startsWith('AI 翻译')).click(); return true");
  await waitFor("return $$('.menu .menu-item').length >= 4");
  await js("$$('.menu .menu-item').find(e => e.textContent.includes('翻译为英文')).click(); return true");
  await waitFor("return Boolean($('.ai-busy-banner'))", { timeout: 5000 });
  await waitFor("return !$('.ai-busy-banner')", { timeout: AI_TIMEOUT });
  const line = await js("return T.bridge.activeEditor().getModel().getLineContent(3)");
  assert(/[a-z]/i.test(line) && !line.includes("第一段"), line);
  return line;
});

await r.test("polish selection (academic)", async () => {
  await js("const ed = T.bridge.activeEditor(); const n = ed.getModel().getLineContent(4).length; ed.setSelection({ startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: n + 1 }); ed.focus(); return true");
  const before = await js("return T.bridge.activeEditor().getModel().getLineContent(4)");
  await js("$$('.format-bar button').find(b => b.title.startsWith('AI 润色')).click(); return true");
  await waitFor("return $$('.menu .menu-item').length >= 3");
  await js("$$('.menu .menu-item').find(e => e.textContent.includes('学术化')).click(); return true");
  await waitFor("return Boolean($('.ai-busy-banner'))", { timeout: 5000 });
  await waitFor("return !$('.ai-busy-banner')", { timeout: AI_TIMEOUT });
  const after = await js("return T.bridge.activeEditor().getModel().getValue()");
  assert(!after.split("\n").includes(before) || after.split("\n").length !== 5, "unchanged");
  return after.split("\n").slice(3, 6).join(" ⏎ ").slice(0, 160);
});

await r.test("ask AI about a selection: chip + scoped answer", async () => {
  await js("await T.project.getState().openFile('main.tex'); return true");
  await waitFor("return T.bridge.activeEditor()?.getModel()?.getLineCount() > 10");
  await js("const ed = T.bridge.activeEditor(); ed.setSelection({ startLineNumber: 12, startColumn: 1, endLineNumber: 15, endColumn: 15 }); ed.focus(); return true");
  await js("$('.editor-ask-ai-action').click(); return true");
  await waitFor("return Boolean($('.ai-selection-chip')) && document.activeElement === $('.ai-generate-input')");
  await typeText("这段公式算的是什么？一句话。");
  await js("$('.ai-send-action').click(); return true");
  await waitFor("return T.ai.getState().busy");
  await idle();
  const m = await lastAssistant();
  assert(m.text.length > 5, JSON.stringify(m));
  return m.text.slice(0, 120);
});

await r.test("translate whole small document (notes.tex) → saves and compiles", async () => {
  await js("await T.project.getState().openFile('notes.tex'); return true");
  await waitFor("return T.bridge.activeEditor()?.getModel()?.getValue().includes('Notes document')");
  await js("$$('.format-bar button').find(b => b.title.startsWith('AI 翻译')).click(); return true");
  await waitFor("return $$('.menu .menu-item').length >= 4");
  await js("$$('.menu .menu-item').find(e => e.textContent.includes('整篇翻译为中文')).click(); return true");
  await waitFor("return Boolean($('.dialog-modal'))");
  await js("$('.dialog-modal .btn-primary').click(); return true");
  await waitFor("return !$('.ai-busy-banner') && !(T.bridge.activeEditor().getModel().getValue().includes('Notes document'))", { timeout: AI_TIMEOUT });
  const d = await disk("notes.tex");
  assert(/[一-龥]/.test(d) && d.includes("\\documentclass"), d);
  return d.replace(/\n/g, " ⏎ ").slice(0, 160);
});

await r.test("project guide generation writes AI_GUIDE.md", async () => {
  await js("$('.ai-menu-anchor > button').click(); return true");
  await waitFor("return Boolean($('.ai-menu'))");
  await js("$$('.ai-menu .ai-menu-item').find(b => b.textContent.includes('项目指南')).click(); return true");
  await waitFor("return Boolean($('.dialog-modal textarea'))");
  await js(`const i = $('.dialog-modal textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(i, '课程报告：英文正文，引用用 \\\\cite，公式用 equation 环境。'); i.dispatchEvent(new Event('input', { bubbles: true })); return true`);
  await js("$('.dialog-modal .btn-primary').click(); return true");
  await waitFor("return Boolean($('.dialog-modal .btn-primary')) && $('.dialog-modal .btn-primary').textContent.includes('AI_GUIDE')", { timeout: AI_TIMEOUT });
  await js("$('.dialog-modal .btn-primary').click(); return true");
  await waitFor("return T.feedback.getState().toasts.some(t => t.text.includes('AI_GUIDE'))", { timeout: 15000 });
  const g = await disk("AI_GUIDE.md");
  assert(g.length > 50, g);
  return `${g.length} chars`;
});

await r.test("unsaved edits are saved before the AI reads the file", async () => {
  await js("await T.project.getState().openFile('main.tex'); T.bridge.activeEditor().setPosition({ lineNumber: 22, column: 1 }); T.bridge.activeEditor().focus(); return true");
  await typeText("UNSAVED-MARKER ");
  await js("T.ai.getState().askAi('当前文件里有没有 UNSAVED-MARKER 这个词？只回答有或没有。'); return true");
  await waitFor("return T.ai.getState().busy");
  const onDisk = (await disk("main.tex")).includes("UNSAVED-MARKER");
  await idle();
  const m = await lastAssistant();
  assert(onDisk, "dirty buffer was not saved before the AI request");
  assert(m.text.includes("有") && !m.text.includes("没有"), "AI did not see the unsaved text: " + m.text);
  return m.text.slice(0, 40);
});

await r.test("token usage is reported", async () => {
  const u = await js("return await invoke('tb_token_usage')");
  assert(u.requests > 0, JSON.stringify(u));
  return JSON.stringify(u);
});

console.log("\nconsole errors:", c.consoleErrors.length);
for (const e of c.consoleErrors.slice(0, 20)) console.log("  ", String(e).slice(0, 300));
await r.save();
c.close();
process.exit(0);
