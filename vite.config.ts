import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8")) as { version: string };

/**
 * pdf.js loads CMaps (CJK fonts without embedded encodings), the standard
 * 14 fonts and its wasm image decoders at runtime by URL. Serve them from
 * node_modules in dev and emit them into the build, so the viewer works
 * fully offline (same promise as the bundled Monaco and Tectonic).
 */
function pdfjsAssets(): Plugin {
  const dirs = ["cmaps", "standard_fonts", "wasm", "iccs"];
  const base = path.join(here, "node_modules", "pdfjs-dist");
  return {
    name: "texbutler-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const dir = rel.split("/")[0];
        if (!dirs.includes(dir) || rel.includes("..")) return next();
        const file = path.join(base, rel);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of dirs) {
        const src = path.join(base, dir);
        if (!fs.existsSync(src)) continue;
        for (const name of fs.readdirSync(src)) {
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${name}`, source: fs.readFileSync(path.join(src, name)) });
        }
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },

  // Tauri expects a fixed port; fail if that port is not available.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Ignore `src-tauri` AND build artifacts: vite's fs watcher dies with
      // EBUSY when the running app locks files under `target/` (WebView2
      // Cookies etc.), which killed `tauri dev` mid-session.
      ignored: ["**/src-tauri/**", "**/target/**", "**/dist/**", "**/assets/e2e/**", "**/scripts/e2e/**"],
    },
  },
  build: {
    // pdf.js (v6) ships ES2022 syntax; WebView2 (Chromium) supports it
    target: "es2022",
    outDir: "dist",
    sourcemap: false,
  },
});
