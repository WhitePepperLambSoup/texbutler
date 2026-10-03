import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { useUiStore } from "./store/uiStore";
import { useProjectStore } from "./store/projectStore";
import { useCompileStore } from "./store/compileStore";
import "./styles.css";

// Monaco cancels pending view-state/folding work on every model switch and
// rejects those promises with `Canceled`; they are expected, not errors.
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as { name?: string; message?: string } | undefined;
  if (reason?.name === "Canceled" || reason?.message === "Canceled") event.preventDefault();
});

// apply the saved theme before the first paint (no light→dark flash)
document.documentElement.dataset.theme = useUiStore.getState().theme;

if (import.meta.env.DEV) {
  // dev-only handle for CDP-driven UI checks (stripped from production builds)
  void Promise.all([import("./store/aiStore"), import("./store/feedbackStore"), import("./editorBridge")]).then(
    ([ai, feedback, bridge]) => {
      (window as unknown as { __tb: unknown }).__tb = {
        ui: useUiStore,
        project: useProjectStore,
        compile: useCompileStore,
        ai: ai.useAiStore,
        feedback: feedback.useFeedbackStore,
        bridge,
      };
    },
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
