import { Bot } from "lucide-react";
import TopBar from "./components/TopBar";
import StatusBar from "./components/StatusBar";
import Sidebar from "./components/Sidebar";
import EditorPane from "./components/Editor";
import SplitPane from "./components/SplitPane";
import PdfPreview from "./components/PdfPreview";
import ProblemsPanel from "./components/ProblemsPanel";
import AiPanel from "./components/AiPanel";
import WelcomePanel from "./components/WelcomePanel";
import SettingsModal from "./components/SettingsModal";
import NewProjectModal from "./components/NewProjectModal";
import NewFileModal from "./components/NewFileModal";
import CommandPalette from "./components/CommandPalette";
import { DialogHost, Toasts } from "./components/ui/Feedback";
import { useProjectStore } from "./store/projectStore";
import { useAiStore } from "./store/aiStore";
import { useUiStore, type PanelId } from "./store/uiStore";
import { usePanelHeight, usePanelSize } from "./hooks/usePanelSize";
import { useLayoutFit } from "./hooks/useWorkbenchLayout";
import { useAppLifecycle } from "./hooks/useAppLifecycle";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useT } from "./i18n";

export type { ThemeId } from "./store/uiStore";

export default function App() {
  const t = useT();
  useAppLifecycle();
  useGlobalShortcuts();

  // narrow selectors only: App must not re-render on every keystroke
  const root = useProjectStore((s) => s.root);
  const hasPdf = useProjectStore((s) => Boolean(s.pdfPath));
  const aiBusy = useAiStore((s) => s.busy);
  const theme = useUiStore((s) => s.theme);
  const bottomOpen = useUiStore((s) => s.panels.bottom);
  const splitFile = useUiStore((s) => s.splitFile);
  const modal = useUiStore((s) => s.modal);
  const palette = useUiStore((s) => s.palette);
  const closeModal = useUiStore((s) => s.closeModal);

  // draggable, persisted pane sizes (Windows-style splitter bars)
  const tree = usePanelSize("tb-tree-w", 240, 180, 460, 1);
  const pdf = usePanelSize("tb-pdf-w", 420, 260, 1400, -1);
  const ai = usePanelSize("tb-ai-w", 320, 260, 560, -1);
  const bottom = usePanelHeight("tb-bottom-h", 220, 120, 640, -1);

  // fit the preferred sizes into the window: the editor always keeps room
  const fit = useLayoutFit({ tree: tree.size, pdf: pdf.size, ai: ai.size });
  const visible = { sidebar: fit.showTree, pdf: fit.showPdf, ai: fit.showAi, bottom: bottomOpen };

  const togglePanel = (panel: PanelId) => {
    // a pane the layout auto-hid is brought back rather than "closed"
    useUiStore.getState().setPanel(panel, !visible[panel]);
  };

  return (
    <div className="app">
      {theme === "liquid" && (
        <div className={`glass-blobs ${hasPdf && fit.showPdf ? "has-pdf" : ""}`} aria-hidden="true">
          <div className="blob blob-1" />
          <div className="blob blob-2" />
          <div className="blob blob-3" />
        </div>
      )}
      <TopBar visible={visible} onTogglePanel={togglePanel} />

      {!root ? (
        <WelcomePanel />
      ) : (
        <div className="layout">
          {fit.showTree && (
            <>
              <aside className="col-tree pane" style={{ width: fit.tree }}>
                <Sidebar />
              </aside>
              <div className="splitter-v" onPointerDown={tree.startDrag} onDoubleClick={tree.reset} title={t("ui.resizeTree")} />
            </>
          )}
          <div className="col-center">
            <main className={`col-editor pane ${splitFile ? "is-split" : ""}`}>
              <EditorPane />
              {splitFile && <SplitPane file={splitFile} />}
            </main>
            {bottomOpen && (
              <div className="splitter-h" onPointerDown={bottom.startDrag} onDoubleClick={bottom.reset} title={t("ui.resizeBottom")} />
            )}
            <section className={`bottom pane ${bottomOpen ? "" : "collapsed"}`} style={{ height: bottomOpen ? bottom.size : undefined }}>
              <ProblemsPanel />
            </section>
          </div>
          {fit.showPdf && (
            <>
              <div className="splitter-v" onPointerDown={pdf.startDrag} onDoubleClick={pdf.reset} title={t("ui.resizePdf")} />
              <aside className={`col-pdf pane ${hasPdf ? "has-pdf" : "no-pdf"}`} style={{ width: fit.pdf }}>
                <PdfPreview />
              </aside>
            </>
          )}
          {fit.showAi ? (
            <>
              <div className="splitter-v" onPointerDown={ai.startDrag} onDoubleClick={ai.reset} title={t("ui.resizeAi")} />
              <aside className="ai-rail open pane" style={{ width: fit.ai }}>
                <AiPanel onCollapse={() => useUiStore.getState().setPanel("ai", false)} />
              </aside>
            </>
          ) : (
            <aside className="ai-rail collapsed pane">
              <button
                className="ai-rail-toggle"
                onClick={() => useUiStore.getState().setPanel("ai", true)}
                title={t("ai.expand")}
                aria-label={t("ai.expand")}
              >
                <Bot size={17} aria-hidden="true" />
                <span>{t("ai.railLabel")}</span>
                {aiBusy && <span className="ai-rail-dot" />}
              </button>
            </aside>
          )}
        </div>
      )}

      <StatusBar />

      {modal?.kind === "settings" && <SettingsModal initialSection={modal.section} onClose={closeModal} />}
      {modal?.kind === "newProject" && <NewProjectModal onClose={closeModal} />}
      {modal?.kind === "newFile" && root && <NewFileModal onClose={closeModal} />}
      {palette && <CommandPalette mode={palette} />}
      <DialogHost />
      <Toasts />
    </div>
  );
}
