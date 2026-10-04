import { useEffect, useState } from "react";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { useFeedbackStore, type DialogRequest } from "../../store/feedbackStore";
import { useT } from "../../i18n";
import Modal from "./Modal";

/** Bottom-right toast stack. */
export function Toasts() {
  const toasts = useFeedbackStore((s) => s.toasts);
  const dismiss = useFeedbackStore((s) => s.dismissToast);
  const t = useT();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} className={`toast toast-${item.tone}`}>
          <span className="toast-icon" aria-hidden="true">
            {item.tone === "success" ? <CheckCircle2 size={16} /> : item.tone === "error" ? <TriangleAlert size={16} /> : <Info size={16} />}
          </span>
          <span className="toast-text">{item.text}</span>
          {item.action && (
            <button
              className="btn btn-sm btn-ghost toast-action"
              onClick={() => {
                item.action?.run();
                dismiss(item.id);
              }}
            >
              {item.action.label}
            </button>
          )}
          <button className="icon-btn icon-btn-sm btn-ghost" aria-label={t("common.close")} onClick={() => dismiss(item.id)}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

function DialogView({ request, done }: { request: DialogRequest; done: () => void }) {
  const t = useT();
  const [value, setValue] = useState(request.kind === "prompt" ? request.initial ?? "" : "");

  useEffect(() => {
    if (request.kind === "prompt") setValue(request.initial ?? "");
  }, [request]);

  const cancel = () => {
    if (request.kind === "confirm") request.resolve(false);
    else if (request.kind === "prompt") request.resolve(null);
    else request.resolve();
    done();
  };
  const accept = () => {
    if (request.kind === "confirm") request.resolve(true);
    else if (request.kind === "prompt") {
      if (!value.trim() && !request.allowEmpty) return;
      request.resolve(value);
    } else request.resolve();
    done();
  };

  const confirmLabel =
    request.kind === "alert" ? t("common.ok") : request.confirmLabel ?? t("common.ok");

  return (
    <Modal
      title={request.title}
      onClose={cancel}
      onSubmit={accept}
      className={`dialog-modal ${request.kind === "alert" && request.preformatted ? "dialog-wide" : ""}`}
      footer={
        <>
          {request.kind !== "alert" && (
            <button className="btn" onClick={cancel}>
              {t("common.cancel")}
            </button>
          )}
          <button
            className={`btn ${request.kind === "confirm" && request.danger ? "btn-danger" : "btn-primary"}`}
            onClick={accept}
            disabled={request.kind === "prompt" && !value.trim() && !request.allowEmpty}
            data-autofocus={request.kind !== "prompt" ? true : undefined}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {request.message &&
        (request.kind === "alert" && request.preformatted ? (
          <pre className="dialog-pre">{request.message}</pre>
        ) : (
          <p className="dialog-message">{request.message}</p>
        ))}
      {request.kind === "prompt" &&
        (request.multiline ? (
          <textarea
            className="input dialog-input"
            rows={5}
            value={value}
            placeholder={request.placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <input
            className="input dialog-input"
            value={value}
            placeholder={request.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                accept();
              }
            }}
          />
        ))}
    </Modal>
  );
}

/** Renders the front request of the dialog queue. */
export function DialogHost() {
  const front = useFeedbackStore((s) => s.dialogs[0]);
  const pop = useFeedbackStore((s) => s.popDialog);
  if (!front) return null;
  return <DialogView key={dialogKey(front)} request={front} done={pop} />;
}

const keys = new WeakMap<DialogRequest, number>();
let keySeq = 0;
function dialogKey(d: DialogRequest): number {
  let k = keys.get(d);
  if (k === undefined) {
    k = ++keySeq;
    keys.set(d, k);
  }
  return k;
}
