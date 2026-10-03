import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { useUiStore } from "./store/uiStore";
import { useProjectStore } from "./store/projectStore";
import { useCompileStore } from "./store/compileStore";
import "./styles.css";

// apply the saved theme before the first paint (no light→dark flash)
document.documentElement.dataset.theme = useUiStore.getState().theme;

if (import.meta.env.DEV) {
  // dev-only handle for CDP-driven UI checks (stripped from production builds)
  (window as unknown as { __tb: unknown }).__tb = { ui: useUiStore, project: useProjectStore, compile: useCompileStore };
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
