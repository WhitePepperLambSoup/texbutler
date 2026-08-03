# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 语义化版本约定。

## [0.2.0] - 2026-08-04

### 新增

- **图片插入**：编辑器工具栏 🖼 一键选图，自动复制入项目并生成 `figure`/`includegraphics` 代码。
- **快速格式**：正文/章节/粗体/行内与行间公式/列表/表格一键插入。
- **AI 生成**：AI 面板输入自然语言直接生成大段 LaTeX 代码（插入编辑器或保存为新文件）。
- **Word 导入**：`.docx` 解析（标题/段落/表格）→ AI 自动生成完整 LaTeX 文档（实测可编译）。
- **模板库**：保存当前项目为模板、列出/删除用户模板、新建项目时可选用（内置 + 用户）。
- **数学符号面板**：36 个常用符号（α β γ … ∑ ∫ √ ± ≤ ≥ ≈ ≠ ∈ ∀ ∃）点击直接键入。
- **日间/夜间模式**：☀️/🌙 一键切换并持久化。
- 版本号升至 0.2.0。

### 安全

- 模板/项目名路径遍历封堵（validate_template_name / validate_project_name 全覆盖）。
- docx 解析 zip-bomb 防护（20MB 双保险 + 截断检测）。
- AI 生成/导入输出 2MB 上限。

## [Unreleased] - 2026-08

### 修复

- **一键修复读取失败**：日志路径含空格（如 `D:/reasonix program/...`）时文件名校验被截断；现在支持项目内绝对路径归一化（log_parser 空格/盘符冒号、resolve 项目内绝对路径、fix_loop/AI 上下文 relative_path）。
- **设置面板卡退/白屏**：受控输入 null 防御 + sanitizeProvider + ErrorBoundary（渲染异常不再导致应用不可用，可恢复/重载）+ 设置加载保存全程异常捕获。
- **编译黑框窗口**：Windows 子进程（tectonic/xelatex/bundler 预热）统一加 `CREATE_NO_WINDOW`，不再弹出 shell 黑框。

### 变更

- AI 模型预设更新为 2026-08 官方最新：OpenAI `gpt-5.6-luna`/`gpt-5.6-terra`、DeepSeek `deepseek-v4-flash`/`deepseek-v4-pro`、通义千问 `qwen3.7-plus`、Anthropic `claude-sonnet-5`/`claude-haiku-4-5`、Ollama `qwen3.5:9b`；后端默认模型改为 `gpt-5.6-luna`。

## [0.1.0] - 2026-06-18

### 新增

- **自包含本地编译**：内置 Tectonic 0.15 二进制（打包在安装包内），无需安装 TeX Live 即可编译中文 LaTeX 出 PDF；bundle 按需下载缓存，支持"预下载"离线编译。
- **系统 TeX 兜底**：检测到 xelatex/lualatex（TeX Live / MiKTeX）时自动降级使用；修复了 MiKTeX `-output-directory` 导致多文件 `\input` 找不到子文件的兼容问题（TEXINPUTS 方案）。
- **多文件项目**：递归文件树、`\input`/`\include` 子文件、主文件右键切换（持久化到 `.texbutler/main.txt`）、编译目标可选"主文件/当前文件"（Ctrl+B / Ctrl+Shift+B）。
- **.log 解析器**：错误块提取（含无 `!` 前缀的 fatal 行与 Overfull 警告）、真实行号解析（file-line-error > `l.N` > 上下文回溯）、中文人话分类、原始错误保留给 AI。
- **规则引擎（9 条）**：裸 `%`、`\textit` 包中文、`\textbf` 含 `&`、`[ht]` 浮动错位、混色缺 xcolor、浮点垃圾、段落粘连、缺 `\end{document}`、UTF-8 BOM——保存自动触发（防抖 500ms），设置中可逐条开关。
- **AI 诊断**：OpenAI 兼容（OpenAI/DeepSeek/通义千问）/ Anthropic / Ollama 三 provider；只发送错误片段 + 前后 20 行上下文；中文人话解释 + 修复建议。
- **AI 修复闭环**：生成 unified diff → 上下文校验 → 快照备份（`.texbutler/backup/`）→ 自动重编译 → 失败回滚，最多 3 轮；前端 diff 预览接受/拒绝。
- **新建项目模板**：中文文章 / 中文报告（含目录）/ 中文幻灯片（ctexbeamer）/ 空白四种模板。
- **UI 增强**：四栏布局 + AI 面板、底部状态栏（引擎/耗时/结果/问题数）、PDF 预览自动刷新、原始日志查看器、错误复制、常用 LaTeX 片段插入、最近项目快速打开、系统中文字体检测、保存前未修改保护。

### 修复

- MiKTeX 多文件项目 `\input` 找不到子文件（TEXINPUTS 修复，集成测试验证）。
- 切换文件时未保存修改丢失（增加保存确认）。
- 浮点垃圾（87.30000000000001）规则与 round 处理。
- `\textbf` 含 `&` 触发 `File ended while scanning use of \textbf` 的检测。

### 技术决策记录

- **Tectonic 驱动方式**：采用官方预编译二进制而非 `tectonic` crate。原因：crate 的 `tectonic_bridge_png` 构建脚本强制依赖系统 libpng（仅 pkg-config/vcpkg 后端、无 vendored 回退），与"干净机器开箱即用"冲突（详见 `docs/ARCHITECTURE.md`）。
