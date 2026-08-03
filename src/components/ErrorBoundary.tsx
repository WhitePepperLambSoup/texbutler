import { Component, type ErrorInfo, type ReactNode } from "react";
import { useI18n } from "../i18n";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort error boundary: a render exception in any child currently
 * unmounts the whole React tree ("应用无法使用" — user report). This keeps
 * the UI alive and offers a reload instead of a silent white screen.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[TeXButler] render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const t = useI18n.getState().t;
      return (
        <div className="error-boundary">
          <h3>{t("errorBoundary.title")}</h3>
          <pre>{String(this.state.error?.message ?? this.state.error)}</pre>
          <div className="modal-actions">
            <button className="btn" onClick={() => this.setState({ error: null })}>
              {t("errorBoundary.recover")}
            </button>
            <button className="btn" onClick={() => window.location.reload()}>
              {t("errorBoundary.reload")}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
