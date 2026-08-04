# TeXButler (LaTeX Butler)

[English](README.md) | [简体中文](README.zh-CN.md)

**A local LaTeX compiler with an AI assistant**, built for Chinese academic and report writing. It works out of the box — you don't need to install TeX Live to compile PDFs.

## Highlights

1. **Self-contained local compilation** — bundles the Tectonic 0.15 engine, so it compiles Chinese LaTeX to PDF even without TeX Live; automatically falls back to a system `xelatex`/`lualatex` when detected.
2. **AI error diagnosis & repair** — turns cryptic LaTeX errors into plain language with the real error line; one-click fix: deterministic fixes (missing packages / undefined commands / missing `\end{document}`) → AI diff → audit (referenced-file existence check) → apply → recompile, with automatic rollback on failure.
3. **Chinese-LaTeX specific checks** — 9 rules (bare `%`, `\textit` with CJK, `[ht]` float drift, floating-point garbage, glued paragraphs, …) that run automatically on save.
4. **Made for writing (v0.2.0)** — one-click image insertion with generated code, quick-format buttons (sections / formulas / tables / lists), AI code generation from natural language, **Word (.docx) import → AI generates a complete compilable LaTeX document**, user template library, math-symbol panel (36 symbols), day/night theme, and a bilingual UI (中文 / English).
5. **Smooth writing flow (v0.3.0)** — drag images into the editor or paste screenshots (auto-saved, insert dialog with width/position/caption), an **Outline panel** (section tree, click to jump), a **Bibliography panel** (click a .bib entry to insert `\cite`), LaTeX autocompletion (60+ commands, environment pairs), optional auto-compile after save, session restore on startup, and Ctrl+P quick file open.
6. **End-to-end verifiable** — real-API + real-compile e2e tests (`cargo test --test e2e_ai -- --ignored`) validate every layer of the fix loop.

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop | Tauri 2 (Rust backend + WebView2 frontend) |
| Frontend | React 18 + TypeScript + Vite + Monaco Editor + zustand |
| Compile engine | Tectonic 0.15 (bundled binary, on-demand bundle cache / offline) + system TeX Live / MiKTeX fallback |
| AI layer | Rust HTTP client, multi-provider (OpenAI-compatible / Anthropic / Ollama) |

> Note: the Tectonic driver uses the official prebuilt binary (`src-tauri/resources/bin/tectonic.exe`) instead of the `tectonic` crate, because the crate's `tectonic_bridge_png` build script requires a system libpng (pkg-config/vcpkg only) — which conflicts with "install & run on a clean machine". See `docs/ARCHITECTURE.md`.

## Development Setup

Prerequisites:

- [Rust](https://rustup.rs) (stable, MSVC toolchain)
- [Node.js](https://nodejs.org) ≥ 18
- Windows 10/11 (WebView2 included on Win11)
- Optional: TeX Live / MiKTeX (system-engine fallback; Tectonic works without it)

```bash
# 1. install frontend deps
npm install

# 2. dev mode (hot reload, auto-launches the window)
npm run tauri dev

# 3. unit tests (Rust core)
cargo test

# 4. end-to-end tests (real API + real compile; requires an AI API key)
cargo test --test e2e_ai -- --ignored --nocapture

# 5. build installers (NSIS + MSI)
npm run tauri build
```

On the first compile, Tectonic downloads resources on demand from `https://relay.fullyjustified.net` into a local cache (tens of MB); afterwards it compiles offline. You can pre-warm it via Settings → "Pre-download Tectonic bundle".

## Quick Start

1. Click **Open** to select any folder containing `.tex` files (or **New** with a template: article / report / slides / your saved templates);
2. Open `main.tex` in the file tree and edit (`Ctrl+S` saves & triggers rule checks; `Ctrl+B` compiles, `Ctrl+Shift+B` compiles the current file; right-click a `.tex` file to set it as main);
3. Click **▶ Compile** → PDF preview on the right; the "Compile errors" panel lists errors with real line numbers (click to jump); the "Log" button shows the raw `main.log`;
4. Select an error → **AI explain** (plain-Chinese explanation + fix advice) or **AI fix** (deterministic fix → AI diff → audit → apply → recompile → auto-rollback);
5. The "Rule check" tab shows the 9 Chinese-LaTeX rule hits (with fix hints), toggleable in Settings;
6. The status bar shows engine / duration / issue count; Settings shows system-font detection and bundle status.

### v0.2.0 writing aids

- **Insert image**: click the image button in the editor toolbar, pick an image — it is copied into the project and a `figure`/`includegraphics` block is inserted at the cursor.
- **Quick formats**: toolbar buttons for paragraph / section / bold / inline & display math / lists / tables.
- **AI generate**: type a request in the AI panel (e.g. "generate a three-line booktabs table") → AI returns LaTeX → insert into the editor or save as a new file.
- **Word import**: toolbar **Word→LaTeX** → pick a `.docx` → headings/paragraphs/tables are parsed and AI generates a complete compilable LaTeX document.
- **Templates**: the star button in the project tree saves the current project as a reusable template; the new-project dialog lists built-in + user templates (user ones can be deleted).
- **Math symbols**: the αβ button opens a 36-symbol panel (α β γ … ∑ ∫ √ ± ≤ ≥ ≈ ≠ ∈ ∀ ∃) — click to type, no need to memorize commands.
- **Day/night theme**: day/night toolbar toggle, persisted across restarts.

## Demo Project

`assets/demo-project/` contains a project with seeded errors (missing xcolor, undefined command, `71%`, Chinese italics, `[ht]`, floating-point garbage) — a quick way to try the AI fix loop.

## Directory Layout

```
├── src/                  # frontend (React + TS)
│   ├── api/              # typed invoke wrappers (tb_* commands)
│   ├── store/            # zustand stores
│   ├── i18n/             # zh/en dictionaries
│   └── components/       # tree / editor / PDF / problems / AI / settings
├── src-tauri/
│   ├── src/
│   │   ├── commands/     # Tauri commands
│   │   └── core/         # core logic (compiler / rules / ai / log_parser …)
│   └── resources/bin/    # bundled tectonic.exe
├── assets/sample/        # Chinese regression sample
├── assets/demo-project/  # demo project with seeded errors
└── docs/                 # ARCHITECTURE.md / PLAN.md
```

## Rule Engine (9 rules)

| ID | Rule | Level |
|---|---|---|
| `percent` | bare `%` mistaken for a comment (`71% `) | suggestion |
| `italic` | `\textit`/`\emph` wrapping CJK (no italic CJK fonts) | warning |
| `bold` | `&` inside `\textbf` (triggers "File ended…") | warning |
| `float` | `[ht]` placement drift → prefer `[H]` + float package | info |
| `color` | `blue!60` mixing without xcolor | error |
| `numbers` | floating-point garbage (`87.30000000000001`) | error |
| `paragraph` | adjacent prose lines without a blank line | info |
| `missing_end` | `\begin{document}` without `\end{document}` | error |
| `bom` | UTF-8 BOM header | warning |

The registry is extensible: add a file under `src-tauri/src/core/rules/` and register it in `all_rules()`.

## AI Fix Loop (architecture)

1. **Deterministic fixes** (no AI): missing xcolor → add `\usepackage{xcolor}`; standalone undefined command → delete exactly the compiler-reported line; missing `\end{document}` → append.
2. **AI diff generation**: project file inventory injected (the AI must never reference non-existent files) + full numbered source on later rounds (prevents line-number hallucination) + per-error-type handling rules.
3. **Diff audit**: referenced-file existence check, content-based hunk location for line-number drift, ambiguity rejection, no-op pair cleanup, `*** End of diff` trailing-marker tolerance.
4. **Progressive verification**: track the currently failing error, keep applied fixes, real compile after every round, ≤3 rounds, automatic rollback to the original (snapshots in `.texbutler/backup/`).

## AI Configuration

Settings support three providers (base_url / model / key persisted to `%APPDATA%\texbutler\settings.json`):

- **OpenAI-compatible**: OpenAI / DeepSeek / Qwen (DashScope)
- **Anthropic**: native Messages API
- **Ollama (local)**: `http://localhost:11434/v1` OpenAI-compatible endpoint, no key needed

2026-08 model presets: GPT-5.6 Luna/Terra, DeepSeek V4 Flash/Pro, Qwen3.7-Plus, Claude Sonnet-5/Haiku-4.5, Ollama Qwen3.5.

Security: AI requests only receive the error snippet + a local context window (20 lines around; the full file on later rounds), never other files; the API key is stored locally and never logged; fixes always preview the diff first and every write is snapshotted for rollback.

## License

MIT License © 2026 [WhitePepperLambSoup (苏喆)](https://github.com/WhitePepperLambSoup) (see [LICENSE](LICENSE)). **Note**: the MIT license requires retaining the copyright notice — keep the LICENSE file and the copyright line when distributing or modifying this project.


