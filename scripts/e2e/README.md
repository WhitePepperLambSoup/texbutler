# TeXButler end-to-end suites

Drive the real desktop app over the Chrome DevTools Protocol (WebView2).

```powershell
# 1. dev server
npx vite --port 1420 --strictPort
# 2. debug build with CDP enabled (cargo build --manifest-path src-tauri/Cargo.toml)
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9336"
.\target\debug\texbutler.exe
# 3. suites (each recreates its fixture project under scripts/e2e/proj)
node scripts/e2e/core.mjs    # editor, project, compile, panels, settings, layout (no AI)
node scripts/e2e/extra.mjs   # Chinese project, templates, external edits, autosave, i18n
node scripts/e2e/ai.mjs      # AI features — uses the AI provider saved in Settings (real requests)
```

- The suites need the dev build: `window.__tb` (stores + editor bridge) only
  exists when `import.meta.env.DEV` is true.
- They change app preferences while running (theme, recent projects, last
  session); results go to `scripts/e2e/results/*.json`, screenshots to
  `scripts/e2e/shots/`.
- `node scripts/e2e/probe.mjs -f body.js` evaluates an async snippet in the
  page with `T` (= `window.__tb`), `$`, `$$`, `invoke` and `sleep` in scope.
