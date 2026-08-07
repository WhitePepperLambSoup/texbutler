// e2e: v0.7.0 CJK spacing rule — the rule fires in a real project, the
// deterministic fix removes the findings.
import { writeFile, readFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v075-check";
const FILE = PROJ + "/main.tex";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(1000);
  }
  throw new Error("CDP not reachable");
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close: () => ws.close(),
    });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      }
    };
  });
}

async function main() {
  const tex = [
    "\\documentclass{article}",
    "\\begin{document}",
    "这是中文English混合的段落，还有第2章编号与公式$E_p$。",
    "\\end{document}",
    "",
  ].join("\n");
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  await mkdir(PROJ, { recursive: true });
  await writeFile(FILE, tex, "utf8");

  const wsUrl = await cdp();
  const c = await connect(wsUrl);
  await c.send("Runtime.enable");
  const exec = async (expr) => {
    const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("JS: " + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    const st = useProjectStore.getState();
    await st.openProject(${JSON.stringify(PROJ)});
    await st.openFile('main.tex');
    return true;
  })()`);
  await sleep(800);

  // rule fires: 2 boundaries (文E, h混) — but NOT 第2 or $E_p$
  const before = JSON.parse(await exec(`(async () => {
    const { useCompileStore } = await import('/src/store/compileStore.ts');
    await useCompileStore.getState().refreshDiagnostics();
    const rules = useCompileStore.getState().ruleIssues || [];
    const cjk = rules.filter((r) => (r.rule_id || "").includes("cjk_spacing") || (r.message || "").includes("中英文之间"));
    return JSON.stringify({ count: cjk.length, first: cjk[0] && cjk[0].message.slice(0, 50) });
  })()`));
  console.log("CJK issues (expect 2):", before.count, "|", before.first);

  // deterministic fix via the rule-fix command
  const fixed = JSON.parse(await exec(`(async () => {
    const { api } = await import('/src/api/index.ts');
    const { useCompileStore } = await import('/src/store/compileStore.ts');
    const rules = useCompileStore.getState().ruleIssues || [];
    const cjk = rules.find((r) => (r.rule_id || "").includes("cjk_spacing"));
    if (!cjk) return JSON.stringify({ ok: false, err: 'no cjk issue', sample: JSON.stringify(rules[0]) });
    const report = await api.fixRuleIssue(cjk, 1, true);
    // rule re-check is explicit (refreshDiagnostics only reads the cache)
    await api.runCheck();
    await new Promise((r) => setTimeout(r, 500));
    await useCompileStore.getState().refreshDiagnostics();
    const after = (useCompileStore.getState().ruleIssues || []).filter((r) => (r.rule_id || "").includes("cjk_spacing"));
    return JSON.stringify({ ok: report.ok, summary: (report.summary || "").slice(0, 60), remaining: after.length });
  })()`));
  console.log("FIX result:", JSON.stringify(fixed));
  const diskAfter = await readFile(FILE, "utf8");
  console.log("DISK after fix:", JSON.stringify(diskAfter.trim()));

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = before.count === 2 && fixed.ok === true && fixed.remaining === 0;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL", "| summary:", fixed.summary);
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
