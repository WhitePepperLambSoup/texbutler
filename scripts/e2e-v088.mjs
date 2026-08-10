// e2e: issue actions must use the persistent conversation for the reported TeX file.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = `D:/reasonix program/idea/tex/.worktrees/codex-fix-compile-ai-repair/assets/e2e/v088-issue-session-scope-${process.pid}-${randomUUID()}`;
const suite = process.argv[2] === "--case" ? process.argv[3] : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (suite !== "issue-session-scope") {
  throw new Error("usage: node scripts/e2e-v088.mjs --case issue-session-scope");
}

async function cdp() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const page = (await response.json()).find((target) => target.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // The Tauri window may still be starting.
    }
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
          const messageId = ++id;
          pending.set(messageId, { res, rej });
          ws.send(JSON.stringify({ id: messageId, method, params }));
        });
      },
      close: () => ws.close(),
    });
    ws.onerror = reject;
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      message.error ? waiter.rej(new Error(JSON.stringify(message.error))) : waiter.res(message.result);
    };
  });
}

async function main() {
  let client;
  let originalDiagnose;
  try {
    await mkdir(`${PROJ}/contents`, { recursive: true });
    await writeFile(`${PROJ}/main.tex`, "\\documentclass{article}\n\\begin{document}\nMain fixture.\n\\end{document}\n", "utf8");
    await writeFile(`${PROJ}/contents/q2_en.tex`, "Q2 fixture.\n", "utf8");

    client = await connect(await cdp());
    await client.send("Runtime.enable");
    const exec = async (expression) => {
      const result = await client.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(`JS: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result.value;
    };
    const callAi = async (body) => exec(`(async () => {
      const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
      const aiUrl = [...resources].reverse().find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
        ?? '/src/store/aiStore.ts';
      const { useAiStore } = await import(aiUrl);
      return (${body});
    })()`);

    await client.send("Page.reload", { ignoreCache: true });
    await sleep(1200);
    await exec(`(async () => {
      const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
      const projectUrl = [...resources].reverse().find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
        ?? '/src/store/projectStore.ts';
      const apiUrl = [...resources].reverse().find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
        ?? '/src/api/index.ts';
      const { useProjectStore } = await import(projectUrl);
      const { api } = await import(apiUrl);
      window.__v088OriginalDiagnose = api.aiDiagnose;
      api.aiDiagnose = async () => ({
        ok: true,
        explanation: 'q2-en-diagnosis',
        suggestion: 'q2-en-suggestion',
        confidence: 'high',
        raw: 'q2-en-raw',
      });
      await useProjectStore.getState().openProject(${JSON.stringify(PROJ)});
      return true;
    })()`);
    originalDiagnose = true;

    const issueForQ2 = {
      severity: "error",
      file: "contents/q2_en.tex",
      line: 1,
      message: "Q2 session scope fixture",
      kind: "compile_error",
    };
    const root = PROJ;
    await callAi(`useAiStore.getState().attachFile(${JSON.stringify(root)}, 'main.tex')`);
    await callAi(`await useAiStore.getState().diagnoseIssue(${JSON.stringify(issueForQ2)}, 0)`);
    const active = await callAi(`useAiStore.getState().activeFile`);
    const messages = await callAi(`useAiStore.getState().messages.map(m => m.text).join('\\n')`);
    assert.equal(active, "contents/q2_en.tex");
    assert(messages.includes("q2-en-diagnosis"));

    await callAi(`useAiStore.getState().attachFile(${JSON.stringify(root)}, 'main.tex')`);
    const mainMessages = await callAi(`useAiStore.getState().messages.map(m => m.text).join('\\n')`);
    assert(!mainMessages.includes("q2-en-diagnosis"));

    const issueForMain = {
      severity: "error",
      file: "main.tex",
      line: 1,
      message: "Main session race fixture",
      kind: "compile_error",
    };
    const race = JSON.parse(await exec(`(async () => {
      const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
      const aiUrl = [...resources].reverse().find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
        ?? '/src/store/aiStore.ts';
      const projectUrl = [...resources].reverse().find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
        ?? '/src/store/projectStore.ts';
      const apiUrl = [...resources].reverse().find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
        ?? '/src/api/index.ts';
      const { useAiStore } = await import(aiUrl);
      const { useProjectStore } = await import(projectUrl);
      const { api } = await import(apiUrl);
      const originalOpenFile = useProjectStore.getState().openFile;
      const originalDiagnose = api.aiDiagnose;
      const originalFix = api.aiFix;
      let releaseOpenFile;
      let diagnoseCalls = 0;
      let fixCalls = 0;
      useProjectStore.setState({
        openFile: async (file) => {
          if (file === 'contents/q2_en.tex') {
            await new Promise((resolve) => { releaseOpenFile = resolve; });
          }
          return originalOpenFile(file);
        },
      });
      api.aiDiagnose = async () => {
        diagnoseCalls += 1;
        return { ok: true, explanation: 'race-q2-diagnosis', suggestion: '', confidence: 'high', raw: '' };
      };
      api.aiFix = async () => {
        fixCalls += 1;
        return { ok: true, rounds: 1, summary: 'race-main-fix', diff: null, issues_after: [], rolled_back: false, hunks: [], suggested: false };
      };
      try {
        useAiStore.getState().attachFile(${JSON.stringify(root)}, 'main.tex');
        const diagnose = useAiStore.getState().diagnoseIssue(${JSON.stringify(issueForQ2)}, 1);
        await Promise.resolve();
        const fix = useAiStore.getState().fixIssue(${JSON.stringify(issueForMain)}, 2);
        await Promise.resolve();
        releaseOpenFile();
        await Promise.all([diagnose, fix]);
        const ai = useAiStore.getState();
        return JSON.stringify({
          diagnoseCalls,
          fixCalls,
          activeFile: ai.activeFile,
          messages: ai.messages.map((message) => message.text),
        });
      } finally {
        useProjectStore.setState({ openFile: originalOpenFile });
        api.aiDiagnose = originalDiagnose;
        api.aiFix = originalFix;
      }
    })()`));
    assert.equal(race.diagnoseCalls, 1);
    assert.equal(race.fixCalls, 0);
    assert.equal(race.activeFile, "contents/q2_en.tex");
    assert(race.messages.some((message) => message.includes("race-q2-diagnosis")));

    const openFileFailure = JSON.parse(await exec(`(async () => {
      const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
      const aiUrl = [...resources].reverse().find((name) => new URL(name).pathname.endsWith('/src/store/aiStore.ts') && new URL(name).search)
        ?? '/src/store/aiStore.ts';
      const projectUrl = [...resources].reverse().find((name) => new URL(name).pathname.endsWith('/src/store/projectStore.ts') && new URL(name).search)
        ?? '/src/store/projectStore.ts';
      const apiUrl = [...resources].reverse().find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
        ?? '/src/api/index.ts';
      const { useAiStore } = await import(aiUrl);
      const { useProjectStore } = await import(projectUrl);
      const { api } = await import(apiUrl);
      const originalOpenFile = useProjectStore.getState().openFile;
      const originalDiagnose = api.aiDiagnose;
      let diagnoseCalls = 0;
      useProjectStore.setState({
        openFile: async (file) => {
          if (file === 'contents/q2_en.tex') throw new Error('fixture openFile failure');
          return originalOpenFile(file);
        },
      });
      api.aiDiagnose = async () => {
        diagnoseCalls += 1;
        return { ok: true, explanation: 'openfile-failure-diagnosis', suggestion: '', confidence: 'high', raw: '' };
      };
      try {
        useAiStore.getState().attachFile(${JSON.stringify(root)}, 'main.tex');
        await useAiStore.getState().diagnoseIssue(${JSON.stringify(issueForQ2)}, 3);
        const ai = useAiStore.getState();
        return JSON.stringify({
          diagnoseCalls,
          activeFile: ai.activeFile,
          messages: ai.messages.map((message) => message.text),
        });
      } finally {
        useProjectStore.setState({ openFile: originalOpenFile });
        api.aiDiagnose = originalDiagnose;
      }
    })()`));
    assert.equal(openFileFailure.diagnoseCalls, 1);
    assert.equal(openFileFailure.activeFile, "main.tex");
    assert(openFileFailure.messages.some((message) => message.includes("openfile-failure-diagnosis")));

    console.log("E2E-DONE PASS", { suite, active });
  } finally {
    if (originalDiagnose && client) {
      await client.send("Runtime.evaluate", {
        expression: `(async () => {
          const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
          const apiUrl = [...resources].reverse().find((name) => new URL(name).pathname.endsWith('/src/api/index.ts') && new URL(name).search)
            ?? '/src/api/index.ts';
          const { api } = await import(apiUrl);
          if (window.__v088OriginalDiagnose) api.aiDiagnose = window.__v088OriginalDiagnose;
          delete window.__v088OriginalDiagnose;
        })()`,
        awaitPromise: true,
      }).catch(() => {});
    }
    client?.close();
    await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error("E2E-FAIL", error);
  process.exit(1);
});
