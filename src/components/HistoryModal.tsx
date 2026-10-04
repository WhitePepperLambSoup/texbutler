import { useEffect, useMemo, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { api, type HistoryEntry } from "../api";
import { useProjectStore } from "../store/projectStore";
import { dialog, toast } from "../store/feedbackStore";
import { useI18n, useT } from "../i18n";
import { foldContext, lineDiff } from "../lineDiff";
import Modal from "./ui/Modal";

function when(ts: number, lang: string) {
  return new Date(ts).toLocaleString(lang === "zh" ? "zh-CN" : "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Local history of one file: versions saved automatically before saves,
 *  replace-all and restores. Diff against the current content; restore. */
export default function HistoryModal({ file, onClose }: { file: string; onClose: () => void }) {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const [versions, setVersions] = useState<HistoryEntry[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [current, setCurrent] = useState<string>("");

  const load = async () => {
    const list = await api.historyList(file).catch(() => []);
    setVersions(list);
    setSelected((s) => s ?? list[0]?.id ?? null);
  };

  useEffect(() => {
    const tab = useProjectStore.getState().tabs.find((x) => x.path === file);
    if (tab) setCurrent(tab.content);
    else void api.readFile(file).then(setCurrent).catch(() => setCurrent(""));
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  useEffect(() => {
    if (!selected) return setContent(null);
    void api.historyRead(file, selected).then(setContent).catch((e) => toast.error(e));
  }, [file, selected]);

  const rows = useMemo(() => (content === null ? [] : foldContext(lineDiff(content, current))), [content, current]);
  const changes = rows.filter((r) => r.kind === "add" || r.kind === "del").length;

  const restore = async () => {
    if (content === null || !selected) return;
    const ok = await dialog.confirm({
      title: t("history.restoreTitle"),
      message: t("history.restoreMsg", { file }),
      confirmLabel: t("history.restore"),
    });
    if (!ok) return;
    try {
      const st = useProjectStore.getState();
      await st.saveAll();
      // keep the current state as a version too, so the restore is undoable
      await api.historySnapshot(file);
      await api.writeFile(file, content);
      await st.reloadTab(file);
      setCurrent(content);
      toast.success(t("history.restored", { file }));
      await load();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Modal
      title={
        <>
          <History size={16} /> {t("history.title")} · <code>{file}</code>
        </>
      }
      onClose={onClose}
      className="history-modal"
      footer={
        <>
          <span className="footer-note">{t("history.note")}</span>
          <button className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn btn-primary history-restore" disabled={content === null || changes === 0} onClick={() => void restore()}>
            <RotateCcw size={14} /> {t("history.restore")}
          </button>
        </>
      }
    >
      <div className="history-layout">
        <div className="history-list">
          {versions === null && <div className="panel-empty">{t("common.loading")}</div>}
          {versions?.length === 0 && <div className="panel-empty">{t("history.empty")}</div>}
          {versions?.map((v) => (
            <button
              key={v.id}
              className={`history-item ${selected === v.id ? "active" : ""}`}
              onClick={() => setSelected(v.id)}
            >
              <span className="history-time">{when(v.ts, lang)}</span>
              <span className="history-size">{v.size.toLocaleString()} B</span>
            </button>
          ))}
        </div>
        <div className="history-diff diff-view">
          {content !== null && changes === 0 && <div className="panel-empty">{t("history.same")}</div>}
          {rows.map((r, i) =>
            r.kind === "fold" ? (
              <div key={i} className="diff-line fold">
                ⋯ {t("history.folded", { n: r.count })}
              </div>
            ) : (
              <div key={i} className={`diff-line ${r.kind}`}>
                <span className="diff-num">{r.line}</span>
                <span className="diff-mark">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
                <span className="diff-text">{r.text || " "}</span>
              </div>
            ),
          )}
        </div>
      </div>
    </Modal>
  );
}
