# TeXButler（LaTeX 管家）

[English](README.md) | [简体中文](README.zh-CN.md)

**本地 LaTeX 桌面编译器 + AI 辅助工具**，面向中文学术 / 报告用户。开箱即用：不需要手动安装 TeX Live，也能编译出 PDF。

## 核心价值

1. **自包含本地编译** — 内置 Tectonic 0.15 编译内核（随应用打包），系统无 TeX Live 也能编译中文 LaTeX 出 PDF；检测到系统 `xelatex`/`lualatex` 时自动兜底。
2. **AI 错误诊断与修复** — 把晦涩的编译报错翻译成人话、定位真实错误行；一键修复：确定性修复（缺宏包/未定义命令/缺 `\end{document}` 自动处理）+ AI diff 生成 → 审核（引用文件存在性检查）→ 应用 → 自动重编译，失败自动回滚。
3. **中文 LaTeX 特有问题检查** — 9 条规则：裸 `%`、`\textit` 包中文、`[ht]` 浮动错位、浮点垃圾、段落粘连等，保存即自动检查。
4. **为写作而生（v0.2.0）** — 一键插图并自动生成代码、常用格式按钮（章节/公式/表格/列表）、AI 自然语言直接生成 LaTeX 代码、**Word (.docx) 导入 → AI 自动生成完整可编译 LaTeX**、用户模板库、数学符号面板（36 个符号）、日间/夜间主题、中英双语界面。
5. **端到端可验证** — 真实 API + 真实编译的端到端测试（`cargo test --test e2e_ai -- --ignored`），修复闭环每一步都有实测兜底。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri 2（Rust 后端 + WebView2 前端） |
| 前端 | React 18 + TypeScript + Vite + Monaco Editor + zustand |
| 编译内核 | Tectonic 0.15（内置二进制，bundle 按需缓存 / 可离线） + 系统 TeX Live / MiKTeX 兜底 |
| AI 层 | Rust 侧 HTTP 客户端，多 provider（OpenAI 兼容 / Anthropic / Ollama） |

> 说明：Tectonic 驱动采用官方预编译二进制（`src-tauri/resources/bin/tectonic.exe`）。不使用 `tectonic` crate 的原因：其 `tectonic_bridge_png` 构建脚本强制依赖系统 libpng（pkg-config/vcpkg），与"干净机器开箱即用"冲突（详见 `docs/ARCHITECTURE.md`）。

## 开发环境搭建

前置要求：

- [Rust](https://rustup.rs)（stable，MSVC toolchain）
- [Node.js](https://nodejs.org) ≥ 18
- Windows 10/11（含 WebView2；Win11 自带）
- 可选：TeX Live / MiKTeX（系统引擎兜底；不装也能用 Tectonic 编译）

```bash
# 1. 安装前端依赖
npm install

# 2. 开发模式（热重载，自动启动窗口）
npm run tauri dev

# 3. 单元测试（Rust 核心逻辑）
cargo test

# 4. 端到端测试（真实 API + 真实编译，需配置 API key）
cargo test --test e2e_ai -- --ignored --nocapture

# 5. 打包安装包（NSIS + MSI）
npm run tauri build
```

首次编译中文文档时，Tectonic 会从 `https://relay.fullyjustified.net` 按需下载资源到本机缓存（约几十 MB），之后离线可编译。也可以在"设置 → 预下载 Tectonic bundle"中提前预热。

## 快速上手

1. 点击 **打开** 选择任意包含 `.tex` 的项目文件夹（或在"新建"中选择模板：中文文章/报告/幻灯片/你的模板）；
2. 左侧文件树打开 `main.tex`，编辑（`Ctrl+S` 保存自动触发规则检查；`Ctrl+B` 编译、`Ctrl+Shift+B` 编译当前文件；右键 `.tex` 可"设为主文件"）；
3. 点击 **▶ 编译** → 右侧预览 PDF，"编译错误"面板列出带真实行号的错误，点击跳转；"日志"按钮可查看原始 `main.log`；
4. 选中错误 → **AI 解释**（人话 + 修复建议）或 **AI 修复**（确定性修复 → AI diff → 审核 → 应用 → 重编译 → 失败自动回滚）；
5. "规则检查"页签展示 9 条中文 LaTeX 规则命中（含修复提示），可在设置中逐条开关；
6. 底部状态栏显示引擎/耗时/问题数；设置中可查看系统字体检测与 bundle 状态。

### v0.2.0 写作辅助

- **插图**：编辑器工具栏 🖼 选图 → 自动复制进项目并在光标处生成 `figure`/`includegraphics` 代码。
- **快速格式**：工具栏按钮（段落/章节/粗体/行内与行间公式/列表/表格）。
- **AI 生成**：AI 面板输入自然语言（如"生成一个 booktabs 三线表"）→ AI 返回 LaTeX → 插入编辑器或保存为新文件。
- **Word 导入**：工具栏 **Word→LaTeX** → 选 `.docx` → 解析标题/段落/表格 → AI 自动生成完整可编译 LaTeX。
- **模板库**：项目树 ⭐ 将当前项目存为模板；新建项目可选内置 + 用户模板（用户模板可删除）。
- **数学符号**：αβ 按钮打开 36 个符号面板（α β γ … ∑ ∫ √ ± ≤ ≥ ≈ ≠ ∈ ∀ ∃）——点击即键入，无需背命令。
- **日夜主题**：工具栏 ☀️/🌙 一键切换，重启后记忆。

## 演示项目

`assets/demo-project/` 包含一个含预设错误的项目（缺 xcolor、未定义命令、`71%`、中文斜体、`[ht]`、浮点垃圾），用于快速体验 AI 修复闭环。

## 目录结构

```
├── src/                  # 前端（React + TS）
│   ├── api/              # invoke 封装（tb_* 命令一一对应）
│   ├── store/            # zustand 状态
│   ├── i18n/             # 中英双语字典
│   └── components/       # 项目树 / 编辑器 / PDF / 问题面板 / AI / 设置
├── src-tauri/
│   ├── src/
│   │   ├── commands/     # Tauri commands（project/compile/diagnostics/ai/check）
│   │   └── core/         # 核心逻辑
│   │       ├── compiler/ # tectonic + texlive 双驱动 + 调度器 + bundler
│   │       ├── rules/    # 9 条中文规则引擎
│   │       ├── ai/       # provider / diagnose / fix_loop（确定性修复+审核）/ prompts
│   │       ├── log_parser.rs
│   │       └── project.rs / settings.rs
│   └── resources/bin/    # 内置 tectonic.exe
├── assets/sample/        # 中文回归样例
├── assets/demo-project/  # 演示项目（预设错误）
├── assets/e2e/           # 端到端测试样例
└── docs/                 # ARCHITECTURE.md / PLAN.md
```

## 规则引擎（9 条）

| ID | 规则 | 级别 |
|---|---|---|
| `percent` | 裸 `%` 疑似百分号误当注释（`71% `） | 建议 |
| `italic` | `\textit`/`\emph` 包中文（中文字体无斜体） | 警告 |
| `bold` | `\textbf` 参数内含 `&`（触发 File ended…） | 警告 |
| `float` | `[ht]` 浮动错位，建议 `[H]` + float 包 | 提示 |
| `color` | 用 `blue!60` 混色但缺 xcolor | 错误 |
| `numbers` | 浮点垃圾（`87.30000000000001`） | 错误 |
| `paragraph` | 相邻正文行未空行（段落粘连） | 提示 |
| `missing_end` | 有 `\begin{document}` 但缺 `\end{document}` | 错误 |
| `bom` | 文件带 UTF-8 BOM 头 | 警告 |

规则库通过注册表扩展：新增规则只需在 `src-tauri/src/core/rules/` 加文件并在 `all_rules()` 注册一行。

## AI 修复闭环（架构）

1. **确定性修复**（不依赖 AI）：缺 xcolor → 自动加宏包；独立成行的未定义命令 → 按编译器行号精确删除；缺 `\end{document}` → 自动补
2. **AI diff 生成**：项目文件清单注入（AI 严禁引用不存在的文件）+ 完整源码注入（防行号幻觉）+ 按错误类型处理约定
3. **diff 审核**：引用文件存在性检查（`\includegraphics`/`\input` 等）、行号偏移内容定位、歧义拒绝、no-op 修改清理、`*** End of diff` 尾部容错
4. **渐进式验证**：每轮追踪当前错误、修改保留不回滚、每轮真实编译验证、≤3 轮、失败自动回滚原文件（快照在 `.texbutler/backup/`）

## AI 配置

设置面板支持三种 provider（base_url / model / key 持久化到 `%APPDATA%\texbutler\settings.json`）：

- **OpenAI 兼容**：OpenAI / DeepSeek / 通义千问（DashScope）
- **Anthropic**：原生 Messages API
- **Ollama（本地）**：`http://localhost:11434/v1` 的 OpenAI 兼容端点，无需 key

2026-08 最新模型预设：GPT-5.6 Luna/Terra、DeepSeek V4 Flash/Pro、Qwen3.7-Plus、Claude Sonnet-5/Haiku-4.5、Ollama Qwen3.5。

安全约定：AI 请求只发送错误片段 + 局部上下文（前后各 20 行，第 2 轮起附加完整文件），**绝不发送其他文件**；api_key 仅存本机、不写入日志；修复永远先预览 diff，任何修改都有快照可回滚。

## License

MIT License © 2026 [WhitePepperLambSoup（苏喆）](https://github.com/WhitePepperLambSoup)（详见 [LICENSE](LICENSE)）。**注意**：MIT 许可证要求保留版权声明——分发或修改本项目时必须保留 LICENSE 文件与版权行。


