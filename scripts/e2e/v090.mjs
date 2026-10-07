// 0.9.0 suite: key rename (F2 + labels view + cite keys), GBK → UTF-8,
// bibliography rules (GB/T 7714), Zotero (Better BibTeX JSON-RPC mock),
// AI full-document review (real model).
// node scripts/e2e/v090.mjs [--only=a,b]
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, runner, assert, sleep, MOD } from "./lib.mjs";
import { makeFixture, PROJ, PROJ_FWD } from "./fixture.mjs";

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");

// ---------------------------------------------------------------- fixture
await makeFixture();
// GBK bytes of "你好世界，中文文档。" (encoded by hand: Node has no GBK encoder)
const GBK_TEXT = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7, 0xa3, 0xac, 0xd6, 0xd0, 0xce, 0xc4, 0xce, 0xc4, 0xb5, 0xb5, 0xa1, 0xa3]);
await writeFile(
  join(PROJ, "gbk.tex"),
  Buffer.concat([Buffer.from("\\documentclass{ctexart}\n\\begin{document}\n"), GBK_TEXT, Buffer.from("\n\\end{document}\n")]),
);
await writeFile(
  join(PROJ, "refs.bib"),
  (await readFile(join(PROJ, "refs.bib"), "utf8")) +
    String.raw`@article{zhang2020,
  author = {张三, 李四},
  title = {中文文献的著录},
  journal = {计算机学报},
  year = {2020},
  doi = {https://doi.org/10.1000/xyz123}
}
@online{website,
  title = {Example Site},
  url = {https://example.org}
}
`,
  "utf8",
);
await writeFile(
  join(PROJ, "review.tex"),
  String.raw`\documentclass{article}
\begin{document}
We has shown that the the method work well in practice.
This results is important for the the community.
\end{document}
`,
  "utf8",
);

// -------------------------------------------------- Better BibTeX mock
const LIBRARY = [
  {
    citekey: "zhang2021deep", title: "Deep Learning for Typesetting", type: "article-journal",
    "container-title": "Journal of Documents", library: "My Library",
    author: [{ family: "Zhang", given: "Wei" }, { family: "Li", given: "Na" }], issued: { "date-parts": [[2021]] },
    bib: "@article{zhang2021deep,\n  title = {Deep Learning for Typesetting},\n  author = {Zhang, Wei and Li, Na},\n  journal = {Journal of Documents},\n  year = {2021},\n  volume = {3},\n  pages = {1--12}\n}",
  },
  {
    citekey: "wang2019deep", title: "深度排版研究", type: "article-journal", "container-title": "计算机学报",
    library: "My Library", author: [{ family: "王", given: "五" }], issued: { "date-parts": [[2019]] },
    bib: "@article{wang2019deep,\n  title = {深度排版研究},\n  author = {王五},\n  journal = {计算机学报},\n  year = {2019}\n}",
  },
  {
    citekey: "lamport1994", title: "LaTeX: A Document Preparation System", type: "book", library: "My Library",
    author: [{ family: "Lamport", given: "Leslie" }], issued: { "date-parts": [[1994]] }, bib: "@book{lamport1994,}",
  },
];
const rpcLog = [];
const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url !== "/better-bibtex/json-rpc" || req.method !== "POST") {
      res.writeHead(404).end("not found");
      return;
    }
    const { method, params, id } = JSON.parse(body);
    rpcLog.push(method);
    const reply = (result) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    const fail = (message) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
    if (method === "api.ready") return reply({ zotero: "7.0.11", betterbibtex: "7.0.5" });
    if (method === "item.search") {
      const q = String(params[0]).toLowerCase();
      return reply(
        LIBRARY.filter((i) => [i.title, i.citekey, ...i.author.map((a) => a.family)].join(" ").toLowerCase().includes(q)).map(({ bib, ...csl }) => csl),
      );
    }
    if (method === "item.export") {
      const [keys, translator] = params;
      if (translator !== "Better BibTeX") return fail(`unknown translator ${translator}`);
      const found = keys.map((k) => LIBRARY.find((i) => i.citekey === k));
      if (found.some((f) => !f)) return fail("not found");
      return reply(found.map((f) => f.bib).join("\n\n"));
    }
    return fail(`unknown method ${method}`);
  });
});
await new Promise((r) => mock.listen(23999, "127.0.0.1", r));
// a "Zotero without Better BibTeX": every json-rpc call is a 404
const bare = createServer((req, res) => res.writeHead(404).end());
await new Promise((r) => bare.listen(23998, "127.0.0.1", r));

// ---------------------------------------------------------------- session
const c = await connect();
const { js, waitFor, key, typeText, shot } = c;
const r = runner("v090");
const test = (name, fn) => (only && !only.some((o) => name.includes(o)) ? Promise.resolve() : r.test(name, fn));
const disk = (rel) => readFile(join(PROJ, rel), "utf8");

await c.send("Page.reload");
await waitFor("return Boolean(window.__tb && document.querySelector('.toolbar'))", { timeout: 30000 });
const savedStorage = await js("return JSON.stringify(Object.assign({}, localStorage))");
await js(`if (T.project.getState().root) await T.project.getState().closeProject(); await T.project.getState().openProject(${JSON.stringify(PROJ_FWD)}); return true`);
await waitFor("return T.project.getState().files.length > 0");
await js(`
  window.__e2e = {
    setVal(el, v) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
  };
  return true`);
const answerPrompt = async (value) => {
  await waitFor("return Boolean($('.dialog-modal .dialog-input'))");
  await js(`__e2e.setVal($('.dialog-modal .dialog-input'), ${JSON.stringify(value)}); return true`);
  await sleep(100);
  await js("$('.dialog-modal .modal-footer .btn-primary').click(); return true");
  await waitFor("return !$('.dialog-modal')");
};

// ------------------------------------------------------------ encoding
await test("GBK: opening the project offers the UTF-8 conversion", async () => {
  await waitFor("return Boolean($('.dialog-modal')) && $('.dialog-modal').textContent.includes('gbk.tex')", { timeout: 10000 });
  await shot("v090-encoding-dialog");
  await js("$('.dialog-modal .modal-footer .btn:not(.btn-primary)').click(); return true"); // not now
  await waitFor("return !$('.dialog-modal')");
});

await test("GBK: the file opens decoded and the problems list offers conversion", async () => {
  await js("await T.project.getState().openFile('gbk.tex'); return true");
  await waitFor("return T.bridge.activeEditor().getValue().includes('你好世界，中文文档。')");
  await js("await T.compile.getState().runCheck(); T.ui.getState().showProblems('rules'); return true");
  await waitFor("return T.compile.getState().ruleIssues.some(i => i.rule_id === 'encoding' && i.file === 'gbk.tex')");
  await waitFor("return Boolean($('.problem-convert-utf8'))");
  await js("$('.problem-convert-utf8').click(); return true");
  await waitFor("return !T.compile.getState().ruleIssues.some(i => i.rule_id === 'encoding')", { timeout: 15000 });
  const bytes = readFileSync(join(PROJ, "gbk.tex"));
  assert(bytes.toString("utf8").includes("你好世界，中文文档。"), "not UTF-8 on disk");
  const backups = readdirSync(join(PROJ, ".texbutler", "backup")).filter((d) => d.startsWith("encoding-"));
  const orig = readFileSync(join(PROJ, ".texbutler", "backup", backups[0], "gbk.tex"));
  assert(orig.includes(GBK_TEXT), "original GBK bytes not backed up");
  return `backup ${backups[0]}`;
});

await test("GBK: palette scan reports all files as UTF-8 afterwards", async () => {
  await js("(await import('/src/actions.ts')).scanEncodingNow(); return true");
  await waitFor("return T.feedback.getState().toasts.some(t => /UTF-8/.test(t.text))");
});

// -------------------------------------------------------------- rename
await test("rename: F2 on \\ref renames the label across files (editor edit is undoable)", async () => {
  await js("await T.project.getState().openFile('main.tex'); return true");
  await waitFor("return T.bridge.activeEditor().getValue().includes('\\\\ref{sec:intro}')");
  const pos = await js("const m = T.bridge.activeEditor().getModel(); for (let l = 1; l <= m.getLineCount(); l++) { const c = m.getLineContent(l).indexOf('\\\\ref{sec:intro}'); if (c >= 0) return { l, c: c + 8 }; } return null");
  await js(`const ed = T.bridge.activeEditor(); ed.setPosition({ lineNumber: ${pos.l}, column: ${pos.c} }); ed.focus(); ed.trigger('e2e', 'editor.action.rename', null); return true`);
  await waitFor("return Boolean(document.querySelector('.rename-box input'))", { timeout: 8000 });
  await sleep(200);
  await js("const i = document.querySelector('.rename-box input'); i.focus(); i.select(); return true");
  await typeText("sec:introduction");
  await key(0, "Enter", "Enter", 13);
  await waitFor("return T.bridge.activeEditor().getValue().includes('\\\\ref{sec:introduction}')", { timeout: 10000 });
  const intro = await disk("chapters/intro.tex");
  assert(intro.includes("\\label{sec:introduction}"), "label in the other file not renamed: " + intro.slice(0, 80));
  const hist = await js("return (await invoke('tb_history_list', { file: 'chapters/intro.tex' })).length");
  assert(hist >= 1, "no history before the rewrite");
  // the open file was edited in the editor: one Ctrl+Z restores it
  await js("T.bridge.activeEditor().trigger('e2e', 'undo', null); return true");
  await waitFor("return T.bridge.activeEditor().getValue().includes('\\\\ref{sec:intro}')");
  await js("T.bridge.activeEditor().trigger('e2e', 'redo', null); return true");
  await waitFor("return T.bridge.activeEditor().getValue().includes('\\\\ref{sec:introduction}')");
  await key(MOD.ctrl, "s", "KeyS", 83);
  await waitFor("return !T.project.getState().tabs.find(t => t.path === 'main.tex').dirty");
  return `history ${hist}`;
});

await test("rename: labels view renames a label; clashes and bad names are refused", async () => {
  await js("T.ui.getState().setSidebarTab('outline'); return true");
  await waitFor("return Boolean($('.outline-modes'))");
  await js("$$('.outline-modes button')[2].click(); return true");
  await waitFor("return $$('.labels-view .report-row-wrap').some(w => w.textContent.includes('sec:method'))");
  await js("$$('.labels-view .report-row-wrap').find(w => w.textContent.includes('sec:method')).querySelector('.label-rename').click(); return true");
  await answerPrompt("sec:approach");
  await waitFor("return T.bridge.activeEditor().getValue().includes('\\\\label{sec:approach}')", { timeout: 10000 });
  assert((await disk("main.tex")).includes("\\label{sec:approach}"), "not on disk");
  await waitFor("return $$('.labels-view .report-row-wrap').some(w => w.textContent.includes('sec:approach'))");
  const clash = await js("try { await invoke('tb_rename_key', { kind: 'label', old: 'sec:approach', new: 'eq:int', skipFile: null }); return 'accepted'; } catch (e) { return String(e); }");
  const bad = await js("try { await invoke('tb_rename_key', { kind: 'label', old: 'sec:approach', new: 'a b', skipFile: null }); return 'accepted'; } catch (e) { return String(e); }");
  assert(clash.includes("已存在") && bad !== "accepted", `${clash} | ${bad}`);
  await js("$$('.outline-modes button')[0].click(); return true");
});

await test("rename: a citation key changes in \\cite and in the .bib entry", async () => {
  const res = await js("return await invoke('tb_rename_key', { kind: 'cite', old: 'knuth1984', new: 'knuth84', skipFile: null })");
  assert(res.count === 2 && res.files.includes("refs.bib"), JSON.stringify(res));
  assert((await disk("refs.bib")).includes("@book{knuth84,"), "bib entry not renamed");
  await js("await T.project.getState().reloadTab('main.tex'); return true");
  await waitFor("return T.bridge.activeEditor().getValue().includes('\\\\cite{knuth84}')");
  const notAKey = await js("const m = await import('/src/keyRename.ts'); return [m.keyAt('See \\\\cite[p.~2]{a, knuth84}.', 22), m.keyAt('plain text', 3), m.keyAt('% \\\\ref{x}', 8)]");
  assert(notAKey[0]?.key === "knuth84" && notAKey[0]?.kind === "cite" && notAKey[1] === null && notAKey[2] === null, JSON.stringify(notAKey));
  return JSON.stringify(res);
});

// --------------------------------------------------------------- bib rules
await test("bib rules: author separators / DOI flagged and fixed deterministically", async () => {
  await js("await T.compile.getState().runCheck(); T.ui.getState().showProblems('rules'); return true");
  const st = await js("return T.compile.getState().ruleIssues.filter(i => i.rule_id?.startsWith('bib_')).map(i => i.rule_id + ':' + i.line + ':' + i.message.slice(0, 50))");
  assert(st.filter((s) => s.startsWith("bib_format")).length === 2, JSON.stringify(st));
  // missing fields (website has no urldate only under GB/T; zhang2020 is complete) are manual
  const manualHasFix = await js("return $$('.problem-row').filter(r => r.textContent.includes('缺少必备字段')).map(r => Boolean(r.querySelector('.problem-actions .btn-primary')))");
  assert(manualHasFix.every((b) => !b), "manual bib issues must not offer a fix: " + JSON.stringify(manualHasFix));
  const row = await js("return $$('.problem-row').findIndex(r => r.textContent.includes('zhang2020') && r.textContent.includes('作者'))");
  assert(row >= 0, "author separator row not listed");
  await js(`const r = $$('.problem-row')[${row}]; r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); r.querySelector('.problem-actions .btn-primary').click(); return true`);
  await waitFor("return T.ai.getState().busy", { timeout: 10000 }).catch(() => {});
  await waitFor("return !T.ai.getState().busy", { timeout: 300000, interval: 1000 });
  const bib = await disk("refs.bib");
  assert(bib.includes("author = {张三 and 李四}") && bib.includes("doi = {10.1000/xyz123}"), bib.slice(-260));
  await js("await T.compile.getState().runCheck(); return true");
  const after = await js("return T.compile.getState().ruleIssues.filter(i => i.rule_id === 'bib_format').length");
  assert(after === 0, `still ${after} bib_format issues`);
  return st.join(" | ");
});

await test("bib rules: GB/T 7714 checks switch on with the gbt7714 style", async () => {
  const before = await js("await T.compile.getState().runCheck(); return T.compile.getState().ruleIssues.filter(i => i.message.includes('GB/T 7714')).length");
  await writeFile(join(PROJ, "gb.tex"), "\\documentclass{ctexart}\n\\bibliographystyle{gbt7714-numerical}\n\\begin{document}\n\\end{document}\n", "utf8");
  // the watcher rescans the tree; the full check walks the tree
  await waitFor("await T.project.getState().refresh(); return T.project.getState().files.some(f => f.path === 'gb.tex')", { timeout: 10000 });
  await js("await T.compile.getState().runCheck(); return true");
  const gb = await js("return T.compile.getState().ruleIssues.filter(i => i.message.includes('GB/T 7714')).map(i => i.message)");
  assert(before === 0, `GB checks without the style: ${before}`);
  assert(gb.some((m) => m.includes("website") && m.includes("urldate")), JSON.stringify(gb));
  // manual issues offer no automatic fix
  const fixButtons = await js("return $$('.problem-row').filter(r => r.textContent.includes('GB/T 7714')).map(r => Boolean(r.querySelector('.problem-actions .btn-primary')))");
  assert(fixButtons.length > 0 && fixButtons.every((b) => !b), JSON.stringify(fixButtons));
  await shot("v090-bib-rules");
  return `${gb.length} GB/T findings`;
});

// ----------------------------------------------------------------- zotero
await test("zotero: settings test connection (Better BibTeX mock)", async () => {
  await js("localStorage.setItem('tb-zotero-url', 'http://127.0.0.1:23999'); T.ui.getState().openModal({ kind: 'settings', section: 'editor' }); return true");
  await waitFor("return Boolean($('.settings-zotero-test'))");
  await js("$('.settings-zotero-test').click(); return true");
  await waitFor("return $('.settings-modal .test-result')?.textContent.includes('7.0.11')");
  await js("T.ui.getState().closeModal(); return true");
});

await test("zotero: search, cite at the cursor, append the missing entry to the .bib", async () => {
  await js("await T.project.getState().openFile('main.tex'); const ed = T.bridge.activeEditor(); const m = ed.getModel(); ed.setPosition({ lineNumber: m.getLineCount() - 4, column: 1 }); ed.focus(); return true");
  await js("T.ui.getState().setSidebarTab('bib'); return true");
  await waitFor("return Boolean($('.bib-zotero'))");
  await js("$('.bib-zotero').click(); return true");
  await waitFor("return $('.zotero-status')?.textContent.includes('Better BibTeX 7.0.5')");
  await js("__e2e.setVal($('.zotero-query'), 'deep'); return true");
  await waitFor("return $$('.zotero-item').length === 2");
  await js("__e2e.setVal($('.zotero-query'), 'lamport'); return true");
  await waitFor("return $$('.zotero-item').length === 1 && Boolean($('.zotero-item .pill.ok'))");
  await js("__e2e.setVal($('.zotero-query'), 'deep'); return true");
  await waitFor("return $$('.zotero-item').length === 2");
  await js("$$('.zotero-item').find(i => i.textContent.includes('zhang2021deep')).querySelector('input').click(); return true");
  await shot("v090-zotero");
  await js("$('.zotero-cite').click(); return true");
  await waitFor("return !$('.zotero-modal')", { timeout: 10000 });
  await waitFor("return T.bridge.activeEditor().getValue().includes('\\\\cite{zhang2021deep}')");
  const bib = await disk("refs.bib");
  assert(bib.includes("@article{zhang2021deep,") && bib.trim().endsWith("}"), bib.slice(-200));
  await waitFor("return T.project.getState().refIndex.bib.some(b => b.key === 'zhang2021deep')");
  assert(rpcLog.includes("item.export"), rpcLog.join(","));
});

await test("zotero: clear errors for no Zotero, no Better BibTeX and remote addresses", async () => {
  const down = await js("try { await invoke('tb_zotero_status', { url: 'http://127.0.0.1:23997' }); return 'ok'; } catch (e) { return String(e); }");
  const nobbt = await js("try { await invoke('tb_zotero_status', { url: 'http://127.0.0.1:23998' }); return 'ok'; } catch (e) { return String(e); }");
  const remote = await js("try { await invoke('tb_zotero_status', { url: 'http://example.com:23119' }); return 'ok'; } catch (e) { return String(e); }");
  assert(down.includes("未检测到 Zotero") && nobbt.includes("Better BibTeX") && remote.includes("本机"), `${down} | ${nobbt} | ${remote}`);
});

// ---------------------------------------------------------------- AI review
const aiReady = await js("try { const s = await invoke('tb_ai_get_settings'); return Boolean(s && s.api_key && s.model); } catch { return false; }");
await test("AI review: findings listed, accept edits the editor (undoable), dismiss, accept all", async () => {
  if (!aiReady) return "skipped: no AI config";
  await js("await T.project.getState().openFile('review.tex'); T.ui.getState().setPanel('ai', true); return true");
  await waitFor("return T.ai.getState().activeFile === 'review.tex'");
  await js("T.ai.getState().reviewDocument(); return true");
  await waitFor("return T.ai.getState().busy", { timeout: 10000 });
  await waitFor("return !T.ai.getState().busy", { timeout: 300000, interval: 1000 });
  const msg = await js("const m = T.ai.getState().messages.at(-1); return { kind: m.kind, n: m.review?.length ?? 0, text: m.text, items: (m.review ?? []).map(i => [i.line, i.quote, i.suggestion]) }");
  assert(msg.kind === "review" && msg.n >= 2, JSON.stringify(msg));
  await waitFor("return $$('.review-item').length >= 2");
  await shot("v090-review");
  const before = await js("return T.bridge.activeEditor().getValue()");
  const idx = await js("return $$('.review-item').findIndex(e => e.querySelector('.review-accept'))");
  assert(idx >= 0, "no finding with a suggested edit");
  await js(`$$('.review-item')[${idx}].querySelector('.review-accept').click(); return true`);
  await waitFor(`return $$('.review-item')[${idx}].classList.contains('status-accepted')`);
  const afterOne = await js("return T.bridge.activeEditor().getValue()");
  assert(afterOne !== before, "accept did not change the editor");
  await js("T.bridge.activeEditor().trigger('e2e', 'undo', null); return true");
  await waitFor(`return T.bridge.activeEditor().getValue() === ${JSON.stringify(before)}`).catch(async (e) => {
    throw new Error(`${e.message} now=${JSON.stringify(await js("return T.bridge.activeEditor().getValue()"))}`);
  });
  await js("T.bridge.activeEditor().trigger('e2e', 'redo', null); return true");
  // dismiss the next pending one, accept the rest
  const pending = await js("return $$('.review-item.status-pending').length");
  if (pending > 0) {
    await js("$('.review-item.status-pending .review-dismiss').click(); return true");
    await waitFor("return $$('.review-item.status-dismissed').length === 1");
  }
  if (await js("return Boolean($('.review-accept-all'))")) {
    await js("$('.review-accept-all').click(); return true");
    await waitFor("return !$('.review-accept-all')");
  }
  const final = await js("return T.bridge.activeEditor().getValue()");
  const statuses = await js("return T.ai.getState().messages.at(-1).review.map(i => i.status)");
  await key(MOD.ctrl, "s", "KeyS", 83);
  return `${msg.n} findings; ${statuses.join(",")}; text now: ${final.split("\n")[2].slice(0, 70)}`;
});

// ------------------------------------------------------------ English UI
await test("English UI: Zotero dialog, review chip and settings have no Chinese", async () => {
  await js("(await import('/src/i18n/index.ts')).useI18n.getState().setLang('en'); return true");
  await sleep(300);
  await js("T.ui.getState().openModal({ kind: 'zotero' }); return true");
  await waitFor("return $('.zotero-status')?.textContent.includes('Connected')");
  await js("__e2e.setVal($('.zotero-query'), 'zzz-nothing'); return true");
  await waitFor("return Boolean($('.zotero-results .panel-empty'))");
  const zh = await js("return [...$('.zotero-modal').querySelectorAll('*')].filter(e => e.children.length === 0 && /[\\u4e00-\\u9fa5]/.test(e.textContent + (e.getAttribute('placeholder') || '') + (e.getAttribute('title') || ''))).map(e => e.textContent.slice(0, 40))");
  await js("T.ui.getState().closeModal(); T.ui.getState().openModal({ kind: 'settings', section: 'rules' }); return true");
  await waitFor("return $$('.settings-modal .settings-row').length > 10");
  const rules = await js("return $$('.settings-modal .settings-row-label').map(e => e.textContent).filter(t => /[\\u4e00-\\u9fa5]/.test(t))");
  await js("T.ui.getState().closeModal(); (await import('/src/i18n/index.ts')).useI18n.getState().setLang('zh'); return true");
  assert(zh.length === 0 && rules.length === 0, JSON.stringify({ zh, rules }));
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
mock.close();
bare.close();
await r.save();
c.close();
process.exit(0);
