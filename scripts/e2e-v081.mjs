// e2e: v0.7.0 Windows-style splitter drag (tree/pdf/ai/bottom panels).
import { writeFile, rm, mkdir } from "node:fs/promises";

const CDP_PORT = 9336;
const PROJ = "D:/reasonix program/idea/tex/assets/e2e/v081-check";
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
    "Hello splitter test.",
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
    localStorage.removeItem('tb-tree-w');
    localStorage.removeItem('tb-pdf-w');
    localStorage.removeItem('tb-ai-w');
    localStorage.removeItem('tb-bottom-h');
    localStorage.removeItem('tb-flow');
    localStorage.setItem('tb-ai-rail', '1');
    location.reload();
    return true;
  })()`);
  await sleep(2500);
  await exec(`(async () => {
    const { useProjectStore } = await import('/src/store/projectStore.ts');
    await useProjectStore.getState().openProject(${JSON.stringify(PROJ)});
    await useProjectStore.getState().openFile('main.tex');
    return true;
  })()`);
  await sleep(800);

  // 1) splitters exist; tree width default 220
  const step1 = JSON.parse(await exec(`(() => {
    const tree = document.querySelector('.col-tree');
    const splitters = document.querySelectorAll('.splitter-v').length;
    const splitH = document.querySelectorAll('.splitter-h').length;
    return JSON.stringify({ treeW: tree && tree.getBoundingClientRect().width, splitters, splitH });
  })()`));
  console.log("STEP1 (splitters):", JSON.stringify(step1));
  const step1Ok = step1.splitters >= 3 && step1.splitH === 1 && Math.round(step1.treeW) === 220;

  // 2) pointer direction, termination, ownership and persistence contract.
  const step2 = JSON.parse(await exec(`(async () => {
    const pointer = (type, x, y, options = {}) => new PointerEvent(type, {
      bubbles: true,
      pointerId: options.pointerId ?? 81,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: x,
      clientY: y,
      button: type === 'pointerdown' ? 0 : -1,
      buttons: options.buttons ?? (type === 'pointerup' || type === 'pointercancel' ? 0 : 1),
    });
    const splitterPoint = (splitter) => {
      const rect = splitter.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const startPointerDrag = (splitter, point, pointerId) => {
      splitter.dispatchEvent(pointer('pointerdown', point.x, point.y, { pointerId, buttons: 1 }));
    };
    const movePointer = (point, pointerId, buttons = 1) => {
      window.dispatchEvent(pointer('pointermove', point.x, point.y, { pointerId, buttons }));
    };
    const endPointer = (type, point, pointerId) => {
      window.dispatchEvent(pointer(type, point.x, point.y, { pointerId, buttons: 0 }));
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

    const treeSplitter = document.querySelector('.layout > .splitter-v');
    const pdfSplitter = document.querySelector('.col-editor + .splitter-v');
    const aiSplitter = document.querySelector('.col-pdf + .splitter-v');
    const bottomSplitter = document.querySelector('.splitter-h');
    const treePanel = document.querySelector('.col-tree');
    const pdfPanel = document.querySelector('.col-pdf');
    const aiPanel = document.querySelector('.ai-rail');
    const bottomPanel = document.querySelector('.bottom');
    if (!treeSplitter || !pdfSplitter || !aiSplitter || !bottomSplitter
      || !treePanel || !pdfPanel || !aiPanel || !bottomPanel) {
      return JSON.stringify({ elementsPresent: false });
    }

    const cases = [
      { name: 'tree', splitter: treeSplitter, panel: treePanel, axis: 'width', dx: 60, dy: 0, pointerId: 811 },
      { name: 'pdf', splitter: pdfSplitter, panel: pdfPanel, axis: 'width', dx: -60, dy: 0, pointerId: 812 },
      { name: 'ai', splitter: aiSplitter, panel: aiPanel, axis: 'width', dx: -40, dy: 0, pointerId: 813 },
      { name: 'bottom', splitter: bottomSplitter, panel: bottomPanel, axis: 'height', dx: 0, dy: -50, pointerId: 814 },
    ];
    const direction = {};
    for (const item of cases) {
      const before = item.panel.getBoundingClientRect()[item.axis];
      const start = splitterPoint(item.splitter);
      startPointerDrag(item.splitter, start, item.pointerId);
      const moved = { x: start.x + item.dx, y: start.y + item.dy };
      movePointer(moved, item.pointerId, 1);
      endPointer('pointerup', moved, item.pointerId);
      await settle();
      const after = item.panel.getBoundingClientRect()[item.axis];
      direction[item.name] = Math.round(after - before);

      const restoreStart = splitterPoint(item.splitter);
      startPointerDrag(item.splitter, restoreStart, item.pointerId + 10);
      const restored = { x: restoreStart.x - item.dx, y: restoreStart.y - item.dy };
      movePointer(restored, item.pointerId + 10, 1);
      endPointer('pointerup', restored, item.pointerId + 10);
      await settle();
    }

    async function assertStopped(splitter, panel, axis, move, pointerId, finish) {
      const start = splitterPoint(splitter);
      const before = panel.getBoundingClientRect()[axis];
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      startPointerDrag(splitter, start, pointerId);
      const first = { x: start.x + move.x, y: start.y + move.y };
      movePointer(first, pointerId, 1);
      await settle();
      const stopped = panel.getBoundingClientRect()[axis];
      await finish(first, pointerId);
      await settle();
      movePointer({ x: first.x + move.x, y: first.y + move.y }, pointerId, 1);
      await settle();
      return {
        moved: Math.round(stopped) !== Math.round(before),
        stable: Math.round(panel.getBoundingClientRect()[axis]) === Math.round(stopped),
        cursorRestored: document.body.style.cursor === previousCursor,
        selectionRestored: document.body.style.userSelect === previousUserSelect,
        captureReleased: !splitter.hasPointerCapture?.(pointerId),
      };
    }

    document.body.style.cursor = 'crosshair';
    document.body.style.userSelect = 'text';
    const up = await assertStopped(treeSplitter, treePanel, 'width', { x: 20, y: 0 }, 821, async (point, id) => {
      endPointer('pointerup', point, id);
    });
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const cancel = await assertStopped(pdfSplitter, pdfPanel, 'width', { x: -20, y: 0 }, 822, async (point, id) => {
      endPointer('pointercancel', point, id);
    });
    const blur = await assertStopped(aiSplitter, aiPanel, 'width', { x: -20, y: 0 }, 823, async () => {
      window.dispatchEvent(new Event('blur'));
    });
    const noButtons = await assertStopped(bottomSplitter, bottomPanel, 'height', { x: 0, y: -20 }, 824, async (point, id) => {
      movePointer(point, id, 0);
    });

    const ownershipStart = splitterPoint(treeSplitter);
    const ownershipBefore = treePanel.getBoundingClientRect().width;
    startPointerDrag(treeSplitter, ownershipStart, 831);
    movePointer({ x: ownershipStart.x + 50, y: ownershipStart.y }, 832, 1);
    await settle();
    const wrongPointerIgnored = Math.round(treePanel.getBoundingClientRect().width)
      === Math.round(ownershipBefore);
    movePointer({ x: ownershipStart.x + 20, y: ownershipStart.y }, 831, 1);
    await settle();
    const ownerMoved = Math.round(treePanel.getBoundingClientRect().width)
      !== Math.round(ownershipBefore);
    const replacementStart = splitterPoint(treeSplitter);
    startPointerDrag(treeSplitter, replacementStart, 833);
    const afterReplacementStart = treePanel.getBoundingClientRect().width;
    movePointer({ x: ownershipStart.x + 80, y: ownershipStart.y }, 831, 1);
    await settle();
    const replacedPointerIgnored = Math.round(treePanel.getBoundingClientRect().width)
      === Math.round(afterReplacementStart);
    movePointer({ x: replacementStart.x + 20, y: replacementStart.y }, 833, 1);
    await settle();
    const replacementMoved = Math.round(treePanel.getBoundingClientRect().width)
      !== Math.round(afterReplacementStart);
    endPointer('pointerup', { x: replacementStart.x + 20, y: replacementStart.y }, 833);
    await settle();

    const saved = Object.fromEntries([
      ['tree', 'tb-tree-w'],
      ['pdf', 'tb-pdf-w'],
      ['ai', 'tb-ai-w'],
      ['bottom', 'tb-bottom-h'],
    ].map(([name, key]) => [name, Number(localStorage.getItem(key))]));
    return JSON.stringify({
      elementsPresent: true,
      direction,
      cleanup: { up, cancel, blur, noButtons },
      pointerOwnershipOk: wrongPointerIgnored
        && ownerMoved
        && replacedPointerIgnored
        && replacementMoved
        && !treeSplitter.hasPointerCapture?.(831)
        && !treeSplitter.hasPointerCapture?.(833),
      saved,
    });
  })()`));
  console.log("STEP2 (pointer contract):", JSON.stringify(step2));
  const cleanupOk = step2.elementsPresent
    && Object.values(step2.cleanup).every((item) => Object.values(item).every(Boolean));
  const step2Ok = step2.elementsPresent
    && step2.direction.tree === 60
    && step2.direction.pdf === 60
    && step2.direction.ai === 40
    && step2.direction.bottom === 50
    && cleanupOk
    && step2.pointerOwnershipOk
    && Object.values(step2.saved).every(Number.isFinite);

  // 3) reload → all four sizes restore from localStorage.
  await exec(`(async () => {
    location.reload();
    return true;
  })()`);
  await sleep(2500);
  const step3 = JSON.parse(await exec(`(() => {
    const tree = document.querySelector('.col-tree');
    const pdf = document.querySelector('.col-pdf');
    const ai = document.querySelector('.ai-rail');
    const bottom = document.querySelector('.bottom');
    return JSON.stringify({
      tree: tree?.getBoundingClientRect().width ?? null,
      pdf: pdf?.getBoundingClientRect().width ?? null,
      ai: ai?.getBoundingClientRect().width ?? null,
      bottom: bottom?.getBoundingClientRect().height ?? null,
    });
  })()`));
  console.log("STEP3 (restore):", JSON.stringify(step3));
  const step3Ok = Object.entries(step2.saved).every(([name, saved]) => (
    Number.isFinite(step3[name]) && Math.abs(step3[name] - saved) <= 1
  ));

  c.close();
  await rm(PROJ, { recursive: true, force: true }).catch(() => {});
  const pass = step1Ok && step2Ok && step3Ok;
  console.log("E2E-DONE", pass ? "PASS" : "FAIL", { step1Ok, step2Ok, step3Ok });
  if (!pass) process.exitCode = 1;
}

main().catch((e) => { console.error("E2E-FAIL", e); process.exit(1); });
