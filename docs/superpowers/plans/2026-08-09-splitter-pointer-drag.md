# Reliable Splitter Pointer Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all four layout splitters resize in the visual direction of the pointer and reliably end the drag after release, cancellation, lost buttons, window blur, or component unmount.

**Architecture:** Replace the duplicated mouse-only resize logic with one internal pointer-drag dimension hook in `usePanelSize.ts`. The hook keeps the existing persistence and clamping behavior, accepts an axis and a `1 | -1` growth direction, owns one fully cleaned drag session, and remains wrapped by the existing width/height public hooks. `App.tsx` supplies the correct direction for each panel, while the real WebView2 v081 harness proves direction, cleanup, and persistence through observable layout behavior.

**Tech Stack:** React 18, TypeScript 5.7, Pointer Events, Zustand-backed application UI, Tauri 2 WebView2, Node.js CDP E2E scripts, CSS flex layout.

## Global Constraints

- File-tree width grows with positive horizontal pointer delta.
- PDF and AI widths grow with negative horizontal pointer delta.
- Bottom-panel height grows with negative vertical pointer delta.
- A drag ends on matching `pointerup`, matching `pointercancel`, window `blur`, a matching `pointermove` with `buttons === 0`, a replacement drag, or hook unmount.
- Every drag end removes all listeners, releases pointer capture when held, and restores the exact pre-drag body cursor and `user-select` values.
- Ignore non-primary mouse buttons and pointer events whose `pointerId` does not own the active drag.
- Preserve existing localStorage keys, default sizes, min/max bounds, splitter geometry, and responsive AI-collapse behavior.
- Add no dependency and do not edit, restore, stage, or commit `src-tauri/Cargo.toml`.
- Browser verification must use only the worktree debug EXE, a fresh external WebView2 user-data directory, Vite on `127.0.0.1:1420`, and CDP on `127.0.0.1:9336`; never stop or reuse `D:\program files\TeXButler\texbutler.exe`.
- Keep `.superpowers/` reports untracked and out of commits.

## File Structure

- Modify `scripts/e2e-v081.mjs`: use real pointer events and assert all four growth directions, all termination paths, style cleanup, and persisted restoration.
- Modify `src/hooks/usePanelSize.ts`: implement one pointer-session dimension hook and retain the public width/height wrappers.
- Modify `src/App.tsx`: assign correct growth directions and switch splitter bindings from `onMouseDown` to `onPointerDown`.

---

### Task 1: Implement Reliable Directional Pointer Dragging

**Files:**
- Modify: `scripts/e2e-v081.mjs:70-150`
- Modify: `src/hooks/usePanelSize.ts:1-116`
- Modify: `src/App.tsx:98-115,623-641`

**Interfaces:**
- Produces: `usePanelSize(key, defaultSize, min, max, growthDirection?)` where `growthDirection: 1 | -1` defaults to `1`.
- Produces: `usePanelHeight(key, defaultSize, min, max, growthDirection?)` where `growthDirection: 1 | -1` defaults to `1`.
- Both hooks return `startDrag: (event: React.PointerEvent<HTMLElement>) => void` and preserve `size`/`reset`.
- Consumes: existing `.layout > .splitter-v`, `.col-editor + .splitter-v`, `.col-pdf + .splitter-v`, and `.splitter-h` DOM relationships.

- [ ] **Step 1: Replace the v081 mouse helper with pointer-event test helpers**

Add these helpers inside the browser-evaluated code before the first drag assertion:

```js
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
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
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
```

Do not add a production-only test API or synthetic calls to React handlers.

- [ ] **Step 2: Add failing direction assertions for all four splitters**

Before reloading the fixture, clear the four saved sizes and force the AI rail open:

```js
localStorage.removeItem('tb-tree-w');
localStorage.removeItem('tb-pdf-w');
localStorage.removeItem('tb-ai-w');
localStorage.removeItem('tb-bottom-h');
localStorage.setItem('tb-ai-rail', '1');
```

Replace the old tree/bottom-only expectations with one browser evaluation that records these outcomes:

```js
const treeSplitter = document.querySelector('.layout > .splitter-v');
const pdfSplitter = document.querySelector('.col-editor + .splitter-v');
const aiSplitter = document.querySelector('.col-pdf + .splitter-v');
const bottomSplitter = document.querySelector('.splitter-h');
const treePanel = document.querySelector('.col-tree');
const pdfPanel = document.querySelector('.col-pdf');
const aiPanel = document.querySelector('.ai-rail');
const bottomPanel = document.querySelector('.bottom');

const cases = [
  { name: 'tree', splitter: treeSplitter, panel: treePanel, dx: 60, dy: 0, pointerId: 811 },
  { name: 'pdf', splitter: pdfSplitter, panel: pdfPanel, dx: -60, dy: 0, pointerId: 812 },
  { name: 'ai', splitter: aiSplitter, panel: aiPanel, dx: -40, dy: 0, pointerId: 813 },
  { name: 'bottom', splitter: bottomSplitter, panel: bottomPanel, dx: 0, dy: -50, pointerId: 814 },
];

const direction = {};
for (const item of cases) {
  const before = item.panel.getBoundingClientRect();
  const start = splitterPoint(item.splitter);
  startPointerDrag(item.splitter, start, item.pointerId);
  const moved = { x: start.x + item.dx, y: start.y + item.dy };
  movePointer(moved, item.pointerId, 1);
  endPointer('pointerup', moved, item.pointerId);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const after = item.panel.getBoundingClientRect();
  direction[item.name] = item.name === 'bottom'
    ? Math.round(after.height - before.height)
    : Math.round(after.width - before.width);
}
```

Require exact unclamped deltas:

```js
result.directionOk = direction.tree === 60
  && direction.pdf === 60
  && direction.ai === 40
  && direction.bottom === 50;
```

- [ ] **Step 3: Add failing cleanup assertions for every termination path**

Use separate pointer ids and panel measurements to assert these behaviors:

```js
async function assertStopped(splitter, panel, axis, move, pointerId, finish) {
  const start = splitterPoint(splitter);
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  startPointerDrag(splitter, start, pointerId);
  const first = { x: start.x + move.x, y: start.y + move.y };
  movePointer(first, pointerId, 1);
  await finish(first, pointerId);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const stopped = panel.getBoundingClientRect()[axis];
  movePointer({ x: first.x + move.x, y: first.y + move.y }, pointerId, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  return {
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
result.cleanup = { up, cancel, blur, noButtons };
```

Require every `stable`, `cursorRestored`, `selectionRestored`, and `captureReleased` field to be `true`. The `pointerup` case deliberately begins with non-empty body styles so the test proves exact restoration instead of merely clearing styles.

Add an ownership/replacement assertion:

```js
const ownershipStart = splitterPoint(treeSplitter);
const ownershipBefore = treePanel.getBoundingClientRect().width;
startPointerDrag(treeSplitter, ownershipStart, 831);
movePointer({ x: ownershipStart.x + 50, y: ownershipStart.y }, 832, 1);
await new Promise((resolve) => setTimeout(resolve, 40));
const wrongPointerIgnored = Math.round(treePanel.getBoundingClientRect().width)
  === Math.round(ownershipBefore);

movePointer({ x: ownershipStart.x + 20, y: ownershipStart.y }, 831, 1);
const replacementStart = splitterPoint(treeSplitter);
startPointerDrag(treeSplitter, replacementStart, 833);
const afterReplacementStart = treePanel.getBoundingClientRect().width;
movePointer({ x: ownershipStart.x + 80, y: ownershipStart.y }, 831, 1);
await new Promise((resolve) => setTimeout(resolve, 40));
const replacedPointerIgnored = Math.round(treePanel.getBoundingClientRect().width)
  === Math.round(afterReplacementStart);
movePointer({ x: replacementStart.x + 20, y: replacementStart.y }, 833, 1);
endPointer('pointerup', { x: replacementStart.x + 20, y: replacementStart.y }, 833);

result.pointerOwnershipOk = wrongPointerIgnored
  && replacedPointerIgnored
  && !treeSplitter.hasPointerCapture?.(831)
  && !treeSplitter.hasPointerCapture?.(833);
```

Require `pointerOwnershipOk === true` so events from another pointer and an old replaced drag session cannot resize the panel.

- [ ] **Step 4: Keep and update the persistence assertion**

After the direction and cleanup cases, read the four numeric localStorage values, reload, and assert that rendered tree/PDF/AI widths and bottom height equal the saved values within one CSS pixel:

```js
const saved = Object.fromEntries([
  ['tree', 'tb-tree-w'],
  ['pdf', 'tb-pdf-w'],
  ['ai', 'tb-ai-w'],
  ['bottom', 'tb-bottom-h'],
].map(([name, key]) => [name, Number(localStorage.getItem(key))]));
```

Require all saved values to be finite and the post-reload rendered values to satisfy `Math.abs(rendered - saved) <= 1`.

- [ ] **Step 5: Run v081 and capture RED**

With the isolated worktree Vite/debug/CDP environment running, execute:

```powershell
node --check scripts/e2e-v081.mjs
node scripts/e2e-v081.mjs
```

Expected: syntax check exits `0`; v081 exits `1`. The existing implementation must report PDF/AI/bottom direction failures and at least one cleanup failure because it listens only for mouse events.

- [ ] **Step 6: Replace duplicated mouse logic with one pointer-session hook**

In `src/hooks/usePanelSize.ts`, use these internal types and hook boundary:

```ts
import { useEffect, useRef, useState } from "react";

type GrowthDirection = 1 | -1;
type DragAxis = "x" | "y";
type DragStart = (event: React.PointerEvent<HTMLElement>) => void;

interface PanelDimension {
  size: number;
  startDrag: DragStart;
  reset: () => void;
}

function usePanelDimension(
  key: string,
  defaultSize: number,
  min: number,
  max: number,
  axis: DragAxis,
  growthDirection: GrowthDirection,
): PanelDimension {
```

Retain the current initial localStorage validation, `sizeRef`, persistence effect, and reset behavior. Add `cleanupRef` and an unmount effect:

```ts
const cleanupRef = useRef<null | (() => void)>(null);

useEffect(() => () => {
  cleanupRef.current?.();
}, []);
```

Implement `startDrag` with an idempotent cleanup session:

```ts
const startDrag: DragStart = (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  cleanupRef.current?.();

  const target = event.currentTarget;
  const pointerId = event.pointerId;
  const startPosition = axis === "x" ? event.clientX : event.clientY;
  const startSize = sizeRef.current;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);
    window.removeEventListener("blur", finish);
    try {
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    } catch {
      // Pointer capture can already be gone after a native cancellation.
    }
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    if (cleanupRef.current === finish) cleanupRef.current = null;
  }

  function onMove(moveEvent: PointerEvent) {
    if (moveEvent.pointerId !== pointerId) return;
    if (moveEvent.buttons === 0) {
      finish();
      return;
    }
    const position = axis === "x" ? moveEvent.clientX : moveEvent.clientY;
    const delta = (position - startPosition) * growthDirection;
    setSize(Math.min(max, Math.max(min, startSize + delta)));
  }

  function onEnd(endEvent: PointerEvent) {
    if (endEvent.pointerId === pointerId) finish();
  }

  cleanupRef.current = finish;
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onEnd);
  window.addEventListener("pointercancel", onEnd);
  window.addEventListener("blur", finish);
  document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
  document.body.style.userSelect = "none";
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Synthetic tests and older hosts may not expose native capture.
  }
};
```

Use the function declarations shown above so each handler can reference the others without block-scoped use-before-declaration errors. The final implementation must preserve the exact cleanup behavior shown above.

Expose the wrappers:

```ts
export function usePanelSize(
  key: string,
  defaultSize: number,
  min: number,
  max: number,
  growthDirection: GrowthDirection = 1,
): PanelDimension {
  return usePanelDimension(key, defaultSize, min, max, "x", growthDirection);
}

export function usePanelHeight(
  key: string,
  defaultSize: number,
  min: number,
  max: number,
  growthDirection: GrowthDirection = 1,
): PanelDimension {
  return usePanelDimension(key, defaultSize, min, max, "y", growthDirection);
}
```

- [ ] **Step 7: Assign panel directions and pointer handlers in App**

Use these calls in `src/App.tsx`:

```ts
const tree = usePanelSize("tb-tree-w", 220, 160, 460, 1);
const pdf = usePanelSize(
  "tb-pdf-w",
  360,
  240,
  Math.round((window.innerWidth || 1400) * 0.7),
  -1,
);
const ai = usePanelSize("tb-ai-w", 300, 240, 520, -1);
const bottom = usePanelHeight(
  "tb-bottom-h",
  220,
  140,
  Math.round((window.innerHeight || 900) * 0.55),
  -1,
);
```

Change only the four splitter bindings:

```tsx
onPointerDown={treeDrag}
onPointerDown={pdfDrag}
onPointerDown={aiDrag}
onPointerDown={bottomDrag}
```

Do not alter panel order, inline size styles, visibility rules, CSS dimensions, or z-index.

- [ ] **Step 8: Run focused GREEN verification**

Run:

```powershell
node --check scripts/e2e-v081.mjs
npx.cmd tsc --noEmit
node scripts/e2e-v081.mjs
node scripts/e2e-v084.mjs
```

Expected: every command exits `0`. v081 reports four correct positive growth deltas, all cleanup/stability/style fields true, and all four saved dimensions restored after reload. v084 retains its no-overlap and responsive-collapse assertions.

- [ ] **Step 9: Review and commit Task 1**

Run `git diff --check`, verify `git diff -- src-tauri/Cargo.toml` contains no intentional content, then stage exactly:

```powershell
git add scripts/e2e-v081.mjs src/hooks/usePanelSize.ts src/App.tsx
git commit -m "fix: make splitter dragging reliable"
```

Request independent specification and code-quality review for Task 1. Treat reversed growth, post-release movement, unreleased capture, body-style leakage, cross-pointer movement, persistence regression, or unrelated layout changes as Important. Fix every Critical/Important finding and rerun Step 8 before re-review.

---

### Task 2: Whole-Branch Verification and Release Readiness

**Files:**
- Modify only files required by concrete review findings.
- Do not modify or stage `src-tauri/Cargo.toml`.
- Keep `.superpowers/` reports untracked.

**Interfaces:**
- Consumes: the reviewed Task 1 commit plus `af79733` and earlier file/AI/layout fixes.
- Produces: a reviewed branch ready for refreshed `0.7.0b` packaging.

- [ ] **Step 1: Run syntax and non-GUI verification**

Run:

```powershell
node --check scripts/e2e-v081.mjs
node --check scripts/e2e-v086.mjs
node --check scripts/e2e-v087.mjs
npx.cmd tsc --noEmit
npm.cmd run build
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: all commands exit `0`; Rust reports no failures; only existing Vite chunk/dynamic-import warnings are allowed.

- [ ] **Step 2: Run the isolated real-browser regression matrix**

With the approved isolated Vite/debug/CDP environment, run in this order:

```powershell
node scripts/e2e-v087.mjs cleanup-fault
node scripts/e2e-v081.mjs
node scripts/e2e-v084.mjs
node scripts/e2e-v086.mjs all
node scripts/e2e-v087.mjs all
```

Expected: every parent process exits `0`; cleanup-fault reports its intentional child failure and complete restoration; v081 proves directions/cleanup/persistence; v084 reports no overlap; v086/v087 report `browserRestored: true` and empty cleanup errors.

- [ ] **Step 3: Audit residue and repository scope**

Run:

```powershell
git status --short
git diff --name-only HEAD
git diff -- src-tauri/Cargo.toml
Get-ChildItem -LiteralPath assets/e2e -Force
```

Expected: no fixture backup, synthetic project, temporary import directory, or WebView2 UDF remains. Only known unstaged `src-tauri/Cargo.toml` line-ending/index noise and untracked `.superpowers/` review material may remain.

- [ ] **Step 4: Request final whole-branch review**

Review the merge-base through `HEAD` against:

```text
docs/superpowers/specs/2026-08-09-splitter-pointer-drag-design.md
docs/superpowers/plans/2026-08-09-splitter-pointer-drag.md
docs/superpowers/specs/2026-08-09-file-scoped-ai-and-current-directory-design.md
docs/superpowers/plans/2026-08-09-file-scoped-ai-and-current-directory.md
```

The reviewer must explicitly check splitter direction, pointer ownership, every cleanup path, persistence, template exact ownership, E2E backup ownership, AI light-theme contrast, Windows scoped AI casing, and accidental Cargo/report staging.

- [ ] **Step 5: Fix findings and prepare packaging handoff**

For every Critical/Important finding, add or identify a focused RED assertion, apply the smallest fix, rerun its focused tests, rerun Tasks 2 Steps 1-2, and obtain a clean re-review. Do not create an empty fix commit.

After the branch is clean and reviewed, rebuild the already requested `release/0.7.0b` artifacts using the existing packaging contract: NSIS internal version `0.7.0-b`, MSI product version `0.7.0.1`, exact final `HEAD` in `BUILD-INFO.txt`, SHA-256 checksums, unsigned installers, and exact restoration of `src-tauri/tauri.conf.json` to tracked version `0.7.0`.
