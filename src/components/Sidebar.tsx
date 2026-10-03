import { BookMarked, FilePlus2, FolderTree, ListTodo, ListTree, RefreshCw } from "lucide-react";
import { useProjectStore } from "../store/projectStore";
import { useUiStore, type SidebarTab } from "../store/uiStore";
import { toast } from "../store/feedbackStore";
import { useT } from "../i18n";
import ProjectTree from "./ProjectTree";
import OutlinePanel from "./OutlinePanel";
import BibPanel from "./BibPanel";
import TodoPanel from "./TodoPanel";

const TABS: { id: SidebarTab; icon: typeof FolderTree; label: string }[] = [
  { id: "files", icon: FolderTree, label: "tree.title" },
  { id: "outline", icon: ListTree, label: "outline.title" },
  { id: "bib", icon: BookMarked, label: "bib.title" },
  { id: "todo", icon: ListTodo, label: "todo.title" },
];

export default function Sidebar() {
  const t = useT();
  const tab = useUiStore((s) => s.sidebarTab);
  const setTab = useUiStore((s) => s.setSidebarTab);
  const openModal = useUiStore((s) => s.openModal);
  const current = TABS.find((x) => x.id === tab) ?? TABS[0];

  return (
    <>
      <div className="tree-tabs" role="tablist">
        {TABS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`tree-tab ${tab === id ? "active" : ""}`}
            title={t(label)}
            onClick={() => setTab(id)}
          >
            <Icon size={15} aria-hidden="true" />
            <span>{t(`${label}Short`)}</span>
          </button>
        ))}
      </div>
      <div className="panel-header">
        <span className="panel-title">{t(current.label)}</span>
        <span className="panel-actions">
          {tab === "files" && (
            <>
              <button
                className="icon-btn icon-btn-sm tree-new-file"
                title={t("tree.newFile")}
                aria-label={t("tree.newFile")}
                onClick={() => openModal({ kind: "newFile" })}
              >
                <FilePlus2 size={15} />
              </button>
              <button
                className="icon-btn icon-btn-sm"
                title={t("tree.refresh")}
                aria-label={t("tree.refresh")}
                onClick={() => void useProjectStore.getState().refresh().catch(toast.error)}
              >
                <RefreshCw size={14} />
              </button>
            </>
          )}
        </span>
      </div>
      <div className="panel-scroll">
        {tab === "files" && <ProjectTree />}
        {tab === "outline" && <OutlinePanel />}
        {tab === "bib" && <BibPanel />}
        {tab === "todo" && <TodoPanel />}
      </div>
    </>
  );
}
