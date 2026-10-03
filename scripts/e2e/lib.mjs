// Minimal CDP E2E harness for the running TeXButler debug window.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 9336;
export const HERE = dirname(fileURLToPath(import.meta.url));
export const SHOTS = join(HERE, "shots");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(1000);
  }
  throw new Error("CDP not reachable");
}

export async function connect() {
  const ws = new WebSocket(await wsUrl());
  const pending = new Map();
  const listeners = [];
  let id = 0;
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const w = pending.get(m.id);
      pending.delete(m.id);
      m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
    } else if (m.method) {
      for (const l of listeners) l(m);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  await send("Runtime.enable");
  await send("Page.enable");
  const consoleErrors = [];
  listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") {
      consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });

  /** Evaluate an async function body in the page; `T` = window.__tb. */
  const js = async (body, timeoutMs = 60000) => {
    const expression = `(async () => { const T = window.__tb; const $ = (s) => document.querySelector(s); const $$ = (s) => [...document.querySelectorAll(s)]; const invoke = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a ?? {}); const sleep = (ms) => new Promise(r => setTimeout(r, ms)); ${body} })()`;
    const r = await Promise.race([
      send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => {
        throw new Error(`js timeout after ${timeoutMs}ms`);
      }),
    ]);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  };

  const waitFor = async (body, { timeout = 15000, interval = 200, label = body } = {}) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = await js(body);
        if (last) return last;
      } catch (e) {
        last = String(e);
      }
      await sleep(interval);
    }
    throw new Error(`waitFor timed out: ${label} (last=${JSON.stringify(last)?.slice(0, 200)})`);
  };

  const key = async (mods, key, code, vk) => {
    const base = { modifiers: mods, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };
  const typeText = (text) => send("Input.insertText", { text });

  const shot = async (name, w = 1440, h = 900) => {
    await mkdir(SHOTS, { recursive: true });
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const r = await send("Page.captureScreenshot", { format: "png" });
    await send("Emulation.clearDeviceMetricsOverride");
    const out = join(SHOTS, `${name}.png`);
    await writeFile(out, Buffer.from(r.data, "base64"));
    return out;
  };

  return { send, js, waitFor, key, typeText, shot, consoleErrors, close: () => ws.close() };
}

export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/** Tiny test runner: collects results, never stops on failure. */
export function runner(suite) {
  const results = [];
  return {
    results,
    async test(name, fn) {
      const t0 = Date.now();
      try {
        const note = await fn();
        results.push({ name, ok: true, ms: Date.now() - t0, note: note ?? "" });
        console.log(`  PASS ${name}${note ? ` — ${String(note).slice(0, 160)}` : ""}`);
      } catch (e) {
        results.push({ name, ok: false, ms: Date.now() - t0, note: String(e?.message ?? e) });
        console.log(`  FAIL ${name} — ${String(e?.message ?? e).slice(0, 400)}`);
      }
    },
    async save() {
      const pass = results.filter((r) => r.ok).length;
      console.log(`\n${suite}: ${pass}/${results.length} passed`);
      await mkdir(join(HERE, "results"), { recursive: true });
      await writeFile(join(HERE, "results", `${suite}.json`), JSON.stringify(results, null, 2));
    },
  };
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
