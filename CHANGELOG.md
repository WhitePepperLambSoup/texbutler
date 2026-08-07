# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 语义化版本约定。

## [0.6.1] - 2026-08-07

### 安全加固 / Security Hardening

- **符号链接越界防护**：所有文件读取与写入（图片导入/剪贴板/导出/AI 快照）统一经过 canonical 路径校验，项目内符号链接无法把读写引到项目外。 / **Symlink escape protection**: every read and write (image import, clipboard, export, AI snapshots) is canonical-path verified — a symlink inside the project can no longer redirect I/O outside it.
- **AI 编辑事件零丢失**：流式请求发送前先完成事件监听注册，`tb://ai-edit` 永不漏收（编辑器同步与回滚记录始终完整）。 / **Zero-lost AI edit events**: listeners are registered before the streaming request fires, so every edit event lands (editor sync and rollback records are always complete).

### 工程完善 / Engineering

- **SyncTeX 定位当前编译产物**：多主文档项目中"定位到 PDF"使用最近一次编译的实际输出，嵌套文件与独立章节均可正确跳页。 / **SyncTeX targets the real output**: "locate in PDF" uses the last compiled PDF, so nested files and standalone chapters jump to the right page.
- **依赖扫描 UTF-8 安全**：`\input` 后紧跟中文等场景不再可能因字节切片 panic。 / **UTF-8-safe dependency scan**: CJK right after `\input` can no longer panic the scanner.
- **AI 引用索引读取 .bib**：生成 `\cite` 时注入的文献键来自真实 .bib 文件（此前为空）。 / **Real .bib feeding**: cite-key injection reads actual .bib files.
- **扩展名大小写一致**：`.TEX` 文件与 `.tex` 同等识别（文件树/主文件/编译/规则检查全链路）。 / **Case-insensitive extensions**: `.TEX` is treated like `.tex` across the whole pipeline.
- **流式超时跟随设置**：AI 流式回答使用设置中的超时值（下限 60 秒）。 / **Configured streaming timeout**: streamed AI replies honor the settings timeout (60 s floor).

## [0.6.0] - 2026-08-06

### AI 协同编辑 / AI Co-editing

- **对话式编辑**：直接说出修改要求（"把标题改成…""每个 Question 前加分页"），AI 以声明式工具调用精确改写文件，程序确定性执行——多调用批量一次应用，失败自动重试。 / **Conversational editing**: state a change in plain words; the AI rewrites the file through declarative tool calls executed deterministically, applied in batch with automatic retry on failure.
- **编译验证闭环**：AI 每次修改后自动重新编译，失败自动修复一轮；编辑结果即时同步进编辑器与 PDF 预览。 / **Compile-verify loop**: every AI edit triggers an automatic recompile with one self-healing round; results sync instantly into the editor and PDF preview.
- **AI 面板右侧伸缩式竖条**：收起时 34px 窄条，展开完整面板，折叠状态持久化。 / **Collapsible right AI rail**: 34px strip when collapsed, full panel when expanded, state persisted.
- **AI 消息流式输出**：逐字显示，无需等待完整生成。 / **Streaming AI replies**: token-by-token output.
- **编辑器选区提问与多轮对话**：选中代码问 AI，或带项目上下文连续追问。 / **Selection Q&A and multi-turn chat** with project context.
- **快照时间线**：修复历史一键回退任意一次，逐文件独立回滚。 / **Snapshot timeline**: one-click rollback of any edit, per-file independent.
- **建议模式**：AI 输出逐块审阅，手动应用，不自动写盘。 / **Suggestion mode**: review hunks one by one and apply manually.
- **AI 修改不覆盖输入**：你正在编辑的文件（未保存）不会被 AI 同步冲掉。 / **Never clobber your typing**: dirty tabs keep your unsaved edits during AI sync.

### 项目智能 / Project Intelligence

- **文档概要注入**：AI 自动获知文档类、宏包、中文支持状态与编译引擎。 / **Document summary injection**: class, packages, CJK support and compiler engine are visible to the AI.
- **翻译保持结构**：中英互译不碰数学公式、命令与转义，自动补中文支持宏包。 / **Structure-preserving translation** with automatic CJK package insertion.
- **跨文件一致性检查**：重复 `\label`（提示首个定义位置）、自定义宏定义了却从未使用。 / **Cross-file consistency checks**: duplicate labels and unused macros.
- **依赖图上下文**：`\input`/`\include` 链自动注入 AI 修复。 / **Dependency-graph context**: input/include chains feed AI fixes.
- **引用索引注入**：生成 `\ref`/`\cite` 时注入项目现有标签与文献键，杜绝编造引用。 / **Reference index injection**: real labels and bib keys only.
- **AI_GUIDE.md 项目指南**：格式要求/常用宏/禁忌一键写入并注入所有 AI 对话。 / **Project guide**: format rules and macros injected into every AI session.
- **规则确定性批量修复**：段落粘连等规则问题一键批量修复，无需 AI。 / **Deterministic rule fixes**: glued paragraphs and friends fixed in one batch, no AI needed.

### 工程与安全 / Engineering & Security

- **Token 用量统计**：实时输入/输出 token 与成本估算。 / **Token usage meter** with cost estimate.
- **AI 编辑白名单**：仅 `.tex/.bib/.sty/.cls`；指南注入护栏、路径归一化、快照防穿越。 / **Edit allowlist, guide guardrails, path normalization, traversal-safe snapshots**.
- **SyncTeX 正向搜索**：编辑器"定位到 PDF"按钮，光标行跳到对应页，无同步数据时明确提示。 / **SyncTeX forward search**: jump from cursor line to PDF page, with clear guidance when data is missing.

## [0.5.0] - 2026-08-06

### 写作体验

- **悬空引用检查**（规则引擎第 10 条）：`\ref` 必须有对应 `\label`、`\cite` 必须在 bib 中，全项目扫描，编译前揪出最常见的引用错误。
- **\ref/\cite 智能补全**：输入 `\ref{` / `\cite{` 自动补全项目内全部标签与参考文献条目（含作者/标题预览），标签随保存即时更新。
- **可视化表格生成器**：行列数 + 对齐方式 + 表头/表题，一键生成 booktabs 三线表代码插入光标处。
- **AI 翻译保持 LaTeX 结构**：选中段落中英互译，命令/环境/公式/引用结构原样保留。
- **SyncTeX 正向搜索**：编辑器"定位到 PDF"按钮，光标行一键跳到 PDF 对应页。
- **多主文档**：含 `\documentclass` 的每个文件都可作为编译目标（工具栏下拉切换），`\includeonly` 自然生效。

### 工程能力

- **字数统计**：状态栏实时显示当前文件字数（排除注释与命令名，命令参数计入正文，中英分列）。
- **保存自动编译**：保存后防抖触发规则检查与编译（可关闭），问题面板即时更新。
- **LaTeX → Markdown / Word 导出**：一键导出为 `.md` / `.docx`（章节/列表/公式/表格/引用自动转换）。

### 变更

- 规则引擎注册表扩展为 10 条规则（新增 `refs`）。
- 编译启用 SyncTeX（tectonic `--synctex` / 系统引擎 `-synctex=1`）。

## [0.4.0] - 2026-08-05

### 液态玻璃多主题 UI

- **液态玻璃主题（默认）**：动画渐变光斑画布 + 磨砂玻璃面板 + 高光按钮 + 渐变品牌字；PDF 阅读时右侧光斑自动让位（阅读区专注），关闭 PDF 后完整恢复。
- **三主题外观切换**：工具栏色块选择器（液态玻璃 / 经典深色 / 经典浅色）一键切换并持久化；Monaco 编辑器主题联动。
- **完全离线的编辑器**：Monaco 本地打包，无网络依赖；内置离线 Tectonic bundle，首次编译无需联网。
- **PDF 安全预览**：内置白名单预览协议（仅项目目录内文件、7 种预览类型），端到端验证 PDF 正常渲染。
- **工具栏公式符号**：12 个常驻快捷符号（α β γ δ θ λ π √ ∫ ∞ ± ≤）+ 符号面板扩至 90 个。
- **小窗口适配**：高度 700px 以下自动紧凑布局，工具栏/标签行完整可见。

## [0.3.1] - 2026-08-04

### 完善与增强

- **AI 修复确认闭环**：修复成功返回修复前快照，可一键回滚；接受后编辑器自动与磁盘同步。
- **PDF 预览**：WebView2 兼容的白名单预览协议（仅项目目录内文件、7 种预览扩展名），端到端验证渲染正常。
- **快捷键体系**：Ctrl+B 编译主文件、Ctrl+Shift+K 编译当前文件、Ctrl+Shift+B 编辑器内加粗包裹。
- **安全加固**：白名单预览协议 + 严格 CSP（script-src 'self'、object-src none）+ 自定义协议路径四重校验。
- **规则引擎**：对 `%` 注释内容完全感知（6 条规则不误报注释、行尾裸 `%` 检出、includegraphics 参数不误判）。
- **编译调度**：全局互斥锁串行化编译，失败以红色提示条常驻显示。
- **文件切换**：请求序号保证快速连点文件不落错标签。
- **Word 导入**：单遍扫描，带属性/无属性段落混排保持文档顺序。
- **工程化**：CI 加 rust-cache 与依赖锁定、下载脚本 SHA-256 校验与超时。
- **路径支持**：日志含空格路径与项目内绝对路径完整支持。
- **界面健壮性**：设置面板异常隔离（ErrorBoundary 可恢复/重载）。
- **静默编译**：Windows 子进程统一无控制台窗口。

### 变更

- AI 模型预设更新为 2026-08 官方最新：OpenAI `gpt-5.6-luna`/`gpt-5.6-terra`、DeepSeek `deepseek-v4-flash`/`deepseek-v4-pro`、通义千问 `qwen3.7-plus`、Anthropic `claude-sonnet-5`/`claude-haiku-4-5`、Ollama `qwen3.5:9b`；后端默认模型改为 `gpt-5.6-luna`。

## [0.3.0] - 2026-08-04

### 图片插入流程优化

- **拖拽插图**：直接把图片文件拖进编辑器，自动复制入项目并弹出插入选项。
- **截图粘贴**：Ctrl+V 粘贴剪贴板截图，自动保存为 PNG 并弹出插入选项（不再粘贴乱码二进制）。
- **插入选项**：预览图 + 宽度（0.3/0.5/0.8/1.0 倍行宽）+ 浮动位置（H/htbp/行内）+ 图注 + 标签，确认后生成完整代码。
- **插入即编译**：插入确认后自动重新编译，PDF 立即刷新。

### 编辑辅助功能

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

## [0.1.0] - 2026-06-18

### 新增

- **自包含本地编译**：内置 Tectonic 0.15 二进制（打包在安装包内），无需安装 TeX Live 即可编译中文 LaTeX 出 PDF；bundle 按需下载缓存，支持"预下载"离线编译。
- **系统 TeX 兜底**：检测到 xelatex/lualatex（TeX Live / MiKTeX）时自动降级使用；兼容 MiKTeX 多文件项目——`-output-directory` 下 `\input` 子文件解析（TEXINPUTS 方案，集成测试验证）。
- **多文件项目**：递归文件树、`\input`/`\include` 子文件、主文件右键切换（持久化到 `.texbutler/main.txt`）、编译目标可选"主文件/当前文件"（Ctrl+B / Ctrl+Shift+B）。
- **.log 解析器**：错误块提取（含无 `!` 前缀的 fatal 行与 Overfull 警告）、真实行号解析（file-line-error > `l.N` > 上下文回溯）、中文人话分类、原始错误保留给 AI。
- **规则引擎（9 条）**：裸 `%`、`\textit` 包中文、`\textbf` 含 `&`、`[ht]` 浮动错位、混色缺 xcolor、浮点垃圾、段落粘连、缺 `\end{document}`、UTF-8 BOM——保存自动触发（防抖 500ms），设置中可逐条开关。
- **AI 诊断**：OpenAI 兼容（OpenAI/DeepSeek/通义千问）/ Anthropic / Ollama 三 provider；只发送错误片段 + 前后 20 行上下文；中文人话解释 + 修复建议。
- **AI 修复闭环**：生成 unified diff → 上下文校验 → 快照备份（`.texbutler/backup/`）→ 自动重编译 → 失败回滚，最多 3 轮；前端 diff 预览接受/拒绝。
- **新建项目模板**：中文文章 / 中文报告（含目录）/ 中文幻灯片（ctexbeamer）/ 空白四种模板。
- **UI 增强**：四栏布局 + AI 面板、底部状态栏（引擎/耗时/结果/问题数）、PDF 预览自动刷新、原始日志查看器、错误复制、常用 LaTeX 片段插入、最近项目快速打开、系统中文字体检测、保存前未修改保护。

### 兼容性与健壮性

- MiKTeX 多文件项目兼容：`-output-directory` 下 `\input` 子文件解析（TEXINPUTS 方案，集成测试验证）。
- 切换文件保护：未保存修改有保存确认。
- 数字格式化：round 处理杜绝浮点垃圾（87.30000000000001）。
- LaTeX 语法检测：`\textbf` 含 `&` 的致命错误检测。

### 技术决策记录

- **Tectonic 驱动方式**：采用官方预编译二进制而非 `tectonic` crate。原因：crate 的 `tectonic_bridge_png` 构建脚本强制依赖系统 libpng（仅 pkg-config/vcpkg 后端、无 vendored 回退），与"干净机器开箱即用"冲突（详见 `docs/ARCHITECTURE.md`）。
