import { useEffect } from "react";
import { keyCombo, loadKeymap } from "../store/keymap";
import { useProjectStore } from "../store/projectStore";
import { DEFAULT_EDITOR_PREFS, useUiStore } from "../store/uiStore";
import { selectedText } from "../editorBridge";
import * as actions from "../actions";

/** A single-line selection seeds "find in project". */
function selectedTextForSearch(): string {
  const s = selectedText();
  return s && !s.includes("\n") && s.length < 200 ? s : "";
}

/**
 * One keydown listener for every app-level shortcut. Editor-local keys
 * (bold, etc.) are Monaco commands registered in the editor itself.
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const combo = keyCombo(e);
      if (!combo) return;
      const ui = useUiStore.getState();
      const hasProject = Boolean(useProjectStore.getState().root);
      // dialogs own the keyboard while open (Escape/Enter handled there)
      const modalOpen = Boolean(ui.modal || ui.palette || document.querySelector(".modal-backdrop"));
      const keymap = loadKeymap();

      // capture phase + stopPropagation: app shortcuts win over Monaco's
      // own bindings (Ctrl+Shift+K is Monaco's "delete line" — with the
      // editor focused it used to delete the cursor line instead of compiling)
      const run = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };

      if (combo === "ctrl+shift+p") return run(() => (ui.palette ? ui.closePalette() : ui.openPalette("commands")));
      if (modalOpen) return;

      switch (combo) {
        case keymap.compileMain:
          return hasProject ? run(() => actions.compile("main")) : undefined;
        case keymap.compileCurrent:
          return hasProject ? run(() => actions.compile("current")) : undefined;
        case "ctrl+s":
          // the split editor saves its own file (Monaco command there)
          if ((e.target as Element | null)?.closest?.(".split-pane")) return undefined;
          return run(() => void actions.saveActive());
        case "ctrl+shift+s":
          return run(() => void actions.saveAll());
        case "ctrl+p":
          return hasProject ? run(() => ui.openPalette("files")) : undefined;
        case "ctrl+o":
          return run(() => void actions.openProject());
        case "ctrl+n":
          return hasProject ? run(() => ui.openModal({ kind: "newFile" })) : run(() => ui.openModal({ kind: "newProject" }));
        case "ctrl+j":
          return hasProject ? run(() => ui.togglePanel("bottom")) : undefined;
        case "ctrl+,":
          return run(() => ui.openModal({ kind: "settings" }));
        case "ctrl+shift+f":
          return hasProject ? run(() => ui.searchInProject(selectedTextForSearch())) : undefined;
        case "ctrl+=":
        case "ctrl++":
        case "ctrl+shift++":
          return run(() => ui.setEditorPrefs({ fontSize: ui.editorPrefs.fontSize + 1 }));
        case "ctrl+-":
          return run(() => ui.setEditorPrefs({ fontSize: ui.editorPrefs.fontSize - 1 }));
        case "ctrl+0":
          return run(() => ui.setEditorPrefs({ fontSize: DEFAULT_EDITOR_PREFS.fontSize }));
        default:
          return undefined;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
