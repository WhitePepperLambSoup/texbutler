import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // Tauri expects a fixed port; fail if that port is not available.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Ignore `src-tauri` AND build artifacts: vite's fs watcher dies with
      // EBUSY when the running app locks files under `target/` (WebView2
      // Cookies etc.), which killed `tauri dev` mid-session.
      ignored: ["**/src-tauri/**", "**/target/**", "**/dist/**", "**/assets/e2e/**"],
    },
  },
  build: {
    target: "es2021",
    outDir: "dist",
    sourcemap: false,
  },
});
