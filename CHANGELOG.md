# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 语义化版本约定。

## [0.4.0] - 2026-08-05

### 液态玻璃多主题 UI 重构

- **液态玻璃主题（默认）**：动画渐变光斑画布 + 磨砂玻璃面板 + specular 高光按钮 + 渐变品牌字；PDF 打开时仅隐藏右侧光斑球，左侧/底部保留；编辑器 Monaco 本地打包（完全离线，不再依赖 CDN）。
- **三主题外观切换**：工具栏色块选择器，液态玻璃 / 经典深色 / 经典浅色一键切换并持久化；Monaco 编辑器主题联动。
- **工具栏公式符号**：12 个常驻快捷符号（α β γ δ θ λ π √ ∫ ∞ ± ≤）+ 符号面板扩至 90 个。
- **修复**：PDF 预览空白（WebView2 自定义协议兼容）、液态玻璃闪屏（去大面积 blur）、编辑器永久 loading（Monaco CDN → 本地）、小窗口遮挡（紧凑模式）。

### 修复（代码审查 v0.3.1）

- **AI 修复真确认**：修复成功后返回修复前快照，点"拒绝"真实回滚文件并同步编辑器；点"接受"自动从磁盘重载编辑器（此前"拒绝"只是清弹窗，文件早已写入）。
- **PDF 预览修复**：WebView2 不支持非标准协议，PDF/图片预览协议改为 `http://tb-file.localhost/`（wry workaround 形式，服务端白名单校验不变），端到端实测 PDF 正常渲染。
- **快捷键冲突**：`Ctrl+Shift+B` 仅保留编辑器内"加粗包裹"，全局"编译当前文件"改 `Ctrl+Shift+K`（此前一次按键同时编译+加粗）。
- **安全配置收窄**：关闭 `assetProtocol`（原 `scope: ["**"]`），PDF/图片预览改走白名单自定义协议 `tb-file://`（仅项目目录内、仅 7 种预览扩展名）；启用严格 CSP（script-src 'self'、object-src none）。
- **规则引擎注释感知**：italic/bold/float/color/missing_end 不再对 `%` 注释内内容误报；percent 补报行尾裸 `%`；paragraph 不再把 `\includegraphics[..]{..}` 误判为正文。
- **编译互斥**：全局编译锁（`COMPILE_LOCK`）串行化手动编译与 AI 修复编译，杜绝并发写同一 `build/` 目录；编译失败以红色提示条常驻显示（此前失败被隐藏）。
- **竞态修复**：`openFile` 加请求序号，快速连点文件时活动标签不再落错。
- **Word 导入顺序**：docx 解析改单遍扫描，带属性/无属性段落混排时保持文档顺序。
- **CI/脚本**：CI 加 rust-cache、`--locked`、`tsc --noEmit`；`download-tectonic.ps1` 加 SHA-256 校验与超时。

## [0.3.0] - 2026-08-04

### 图片插入流程优化

- **拖拽插图**：直接把图片文件拖进编辑器，自动复制入项目并弹出插入选项。
- **截图粘贴**：Ctrl+V 粘贴剪贴板截图，自动保存为 PNG 并弹出插入选项（不再粘贴乱码二进制）。
- **插入选项**：预览图 + 宽度（0.3/0.5/0.8/1.0 倍行宽）+ 浮动位置（H/htbp/行内）+ 图注 + 标签，确认后生成完整代码。
- **插入即编译**：插入确认后自动重新编译，PDF 立即刷新。

### 对标 Overleaf 补全的功能

- **大纲面板**：左侧"大纲"页签，解析当前文件章节结构（chapter/section/subsection/…），点击跳转到对应行。
- **参考文献面板**：左侧"参考文献"页签，解析项目 .bib 文件（标题/作者/年份），点击即可在光标处插入 `\cite{key}`。
- **自动补全**：编辑器内输入 `\` 提示 60+ 常用命令（希腊字母、公式、强调、章节、引用等），输入 `\begin` 提示 15 种环境并自动生成配对 `\begin{}...\end{}`。

### 流畅度优化

- **自动编译**：设置中可开启"保存后自动编译"（1.2 秒防抖），保存即出 PDF。
- **会话恢复**：启动时自动恢复上次打开的项目与文件（可在设置中关闭）。
- **快速打开**：Ctrl+P 弹出文件搜索框，输入文件名过滤、Enter 打开。

### 其他

- 版本号升至 0.3.0。

## [0.2.0] - 2026-08-04

### 新增

- **图片插入**：编辑器工具栏图片按钮一键选图，自动复制入项目并生成 `figure`/`includegraphics` 代码。
- **快速格式**：正文/章节/粗体/行内与行间公式/列表/表格一键插入。
- **AI 生成**：AI 面板输入自然语言直接生成大段 LaTeX 代码（插入编辑器或保存为新文件）。
- **Word 导入**：`.docx` 解析（标题/段落/表格）→ AI 自动生成完整 LaTeX 文档（实测可编译）。
- **模板库**：保存当前项目为模板、列出/删除用户模板、新建项目时可选用（内置 + 用户）。
- **数学符号面板**：36 个常用符号（α β γ … ∑ ∫ √ ± ≤ ≥ ≈ ≠ ∈ ∀ ∃）点击直接键入。
- **日间/夜间模式**：日间/夜间一键切换并持久化。
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
