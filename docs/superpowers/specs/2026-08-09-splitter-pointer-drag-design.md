# Splitter Pointer Drag Design

## Goal

Make every layout splitter follow the pointer in the visually expected direction and end every drag session reliably, including when the pointer leaves the WebView, the browser cancels the pointer, the window loses focus, or the component unmounts.

## Current Failure

`usePanelSize` applies `startSize + horizontalDelta` to every vertical splitter. That is correct only for the file tree, which sits to the left of its splitter. The PDF and AI panels sit to the right, so moving their splitter left must increase their width. `usePanelHeight` has the same sign error because the bottom panel sits below its splitter.

Both hooks use mouse listeners and clean up only on `window.mouseup`. A release outside the WebView or a cancelled pointer can leave the listeners, forced cursor, and `user-select: none` active, so later pointer motion continues the resize.

## Design

Use one pointer-drag session implementation inside `usePanelSize.ts`. Each hook accepts a growth direction of `1` or `-1`:

- File tree: horizontal delta multiplied by `1`.
- PDF panel: horizontal delta multiplied by `-1`.
- AI panel: horizontal delta multiplied by `-1`.
- Bottom panel: vertical delta multiplied by `-1`.

The splitter starts a session from `onPointerDown`, records the pointer id, start coordinate, and start size, and captures that pointer on the splitter element when supported. The session listens for `pointermove`, `pointerup`, `pointercancel`, and window `blur`. A move with `buttons === 0` also ends the session defensively. Every completion path removes listeners, releases pointer capture when held, and restores the body's cursor and text-selection styles. Starting a new drag or unmounting the hook first cleans any existing session.

The existing min/max clamping and localStorage keys remain unchanged. Mouse-only compatibility code and document-wide permanent listeners are not added.

## Testing

Extend the real WebView2 splitter regression to use pointer events and assert:

- Dragging the file-tree splitter right increases the tree width.
- Dragging the PDF splitter left increases the PDF width.
- Dragging the AI splitter left increases the AI width.
- Dragging the bottom splitter up increases the bottom height.
- After `pointerup`, `pointercancel`, blur, or a move with no pressed buttons, later pointer moves do not change the saved or rendered size.
- Cursor and `user-select` body styles are restored after each termination path.
- Sizes still persist and restore after reload.

TypeScript checking, production build, the existing v081/v084 splitter suites, and the broader v086/v087 matrices remain required verification.
