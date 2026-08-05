# TeXButler 架构

## 总览

```
┌─────────────────────────── Tauri 2 WebView (React 18) ───────────────────────────┐
│  ProjectTree │ Monaco Editor │ PdfPreview(iframe) │ ProblemsPanel │ AiPanel │ … │
│        ▲  invoke(tb_*)  ▲                            ▲ 事件(tb://*)               │
└────────┼───────────────┼────────────────────────────┼───────────────────────────┘
         │               │                            │
┌────────┴───────────────┴────────────────────────────┴───────────────────────────┐
│  commands/   project · compile · diagnostics · ai · check                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│  state.rs    AppState: project / settings / last_result / rule_issues / cancel  │
├─────────────────────────────── core/ ───────────────────────────────────────────┤
│  project.rs    Project 模型 · 文件树 · notify 监视 · 备份目录                     │
│  settings.rs   $APPDATA/texbutler/settings.json（AI/引擎/规则开关）              │
│  compiler/     Compiler trait + CompilerScheduler（tectonic → texlive 兜底）    │
│    ├ tectonic.rs   内置二进制驱动（--outdir/--bundle/-C，可取消）                │
│    ├ texlive.rs    xelatex/lualatex 驱动（-file-line-error，2 遍）               │
│    └ bundler.rs    bundle 缓存/预热/打包资源                                     │
│  log_parser.rs     .log → Vec<Issue>（错误块/行号/分类/raw）                     │
│  rules/            规则引擎（Rule trait + 注册表，10 条规则）                  │
│  ai/               provider(OpenAI 兼容/Anthropic/Ollama) · diagnose · fix_loop  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 模块职责

### Issue 统一模型（core/mod.rs）

编译错误、规则检查、AI 诊断共用 `Issue`：

```rust
pub struct Issue {
    severity: Severity,      // Error | Warning | Info | Suggestion
    file: Option<String>,    // 相对项目根
    line: Option<usize>,     // 1-based 真实行号
    col: Option<usize>,
    message: String,         // 人话（中文）
    raw: Option<String>,     // 原始报错（AI 上下文）
    kind: IssueKind,         // CompileError | RuleCheck | AiDiagnosis | Consistency
    rule_id: Option<String>, // 规则开关用
    fix_hint: Option<String>,
}
```

### 编译调度（core/compiler/mod.rs）

```rust
pub trait Compiler {
    fn name(&self) -> &str;
    fn available(&self) -> bool;                       // 环境检测
    fn compile(&self, project: &Project, main: &Path,
               stop: &dyn Fn() -> bool) -> Result<CompileResult, CompileError>;
}
pub struct CompilerScheduler { tectonic, texlive, preference }
// 策略：Auto = tectonic 优先；tectonic 不可用/失败 → 自动降级 texlive，
// 结果 CompileResult.engine 标记实际引擎，fell_back 标记是否降级。
```

### Tectonic 驱动（core/compiler/tectonic.rs）

**二进制 vs crate 的决策记录**：`tectonic` crate 的 `tectonic_bridge_png` build script 强制探测系统 libpng（仅 pkg-config/vcpkg 两种后端，无 vendored 回退）；Windows 干净机器无法满足，违背"自包含"承诺。因此采用官方预编译二进制 `tectonic 0.15.0`（打包在 `src-tauri/resources/bin/`），以子进程方式驱动——引擎仍是黑盒，仅通过 CLI 调用。

编译命令：

```
tectonic --outdir <build> --keep-logs --color never --chatter minimal -r 2 \
         [--bundle <dir|zip>] <main.tex>
```

- 取消：`child.kill()`（tokio process，kill_on_drop）
- bundle：默认走 tectonic 自管缓存（`%LOCALAPPDATA%\TectonicProject\Tectonic\bundles`，按需下载）；离线发布用 `TEXBUTLER_BUNDLE_DIR`/`TEXBUTLER_BUNDLE_ZIP` 或 `-C --only-cached`。

### 系统 TeX 兜底（core/compiler/texlive.rs）

- PATH 探测 `xelatex` → `lualatex`（另含 MiKTeX 常见安装路径）
- 参数：`-interaction=nonstopmode -halt-on-error -file-line-error -output-directory=<build>`
- 跑 2 遍（TOC/交叉引用），首遍失败即停
- 结果标记 `EngineUsed::SystemTexlive`

### 日志解析（core/log_parser.rs）

1. 提取 `! ...` 错误块 + 其后 2-5 行上下文（直到 `?` 提示行）
2. 行号解析优先级：`./file.tex:<N>:`（file-line-error）→ `l.<N>` + 最近 `(<file>` 上下文
3. 关键词分类表 → 中文人话（未定义控制序列 / File ended / Missing $ / 宏包错误 / 字体缺失 / Overfull 等）
4. 保留 `raw` 供 AI

### 规则引擎（core/rules/）

```rust
pub trait Rule { fn id(&self); fn name(&self); fn default_enabled(&self) -> bool;
                 fn check(&self, src: &str, file: &str, issues: &mut Vec<Issue>); }
pub fn all_rules() -> Vec<Box<dyn Rule>>   // 注册表，新增规则只需加一项
```

10 条规则见 README；规则开关持久化于 settings.json（`rules: {id: bool}`），保存文件时前端防抖 500ms 自动触发 `tb_run_check`；>2MB 文件跳过（性能保护）。

### AI 层（core/ai/）

- `provider.rs`：`ProviderKind::{OpenAiCompatible{base_url}, Anthropic, Ollama{base_url}}`；Ollama 走 `/v1/chat/completions` OpenAI 兼容端点；Anthropic 走 Messages API（`x-api-key` + `anthropic-version`）。
- `diagnose.rs`：只发送 raw 错误 + `SourceContext`（前后各 20 行）；prompt 要求 ≤150 字中文解释 + 具体修复 + 不确定时明说，优先返回 JSON。
- `fix_loop.rs`：diagnose → AI 输出 unified diff → 自研 diff 解析/应用（上下文校验，不匹配即拒绝）→ 应用前快照到 `.texbutler/backup/<ts>/` → 重编译 → 失败回滚再试，≤3 轮 → 全部失败恢复原文件。diff 先给前端预览（接受/拒绝），不静默改文件。

## 数据流

```
保存文件 ──(防抖 500ms)──▶ tb_run_check ──▶ rules 引擎 ──▶ rule_issues ──▶ ProblemsPanel(规则页签)
编译 ──▶ tb_compile ──▶ spawn_blocking(CompilerScheduler) ──▶ 进度事件 tb://compile-progress
   └─▶ CompileResult ──▶ tb://compile-done ──▶ 问题面板(编译页签) + PDF iframe(convertFileSrc, revision++)
AI 解释 ──▶ tb_ai_diagnose(issue_idx) ──▶ provider.chat ──▶ AiPanel
AI 修复 ──▶ tb_ai_fix ──▶ fix_loop(快照→diff→应用→重编译→回滚) ──▶ diff 预览 → 接受/拒绝
文件监视 ──▶ notify ──▶ tb://file-changed ──▶ 刷新文件树/诊断
```

## 安全

- AI 请求仅发送错误片段 + 局部上下文（≤ 前后 20 行），不发整个文件
- api_key 仅存本机 settings.json，日志中不打印 key
- 修复操作全部先快照（`.texbutler/backup/`），失败自动回滚
- 文件读写路径校验：`Project::resolve` 拒绝越界（`../`）
- 数值一律 round，杜绝浮点垃圾

## 性能

- 编译与 AI 调用全部异步（tokio）；编译在 `spawn_blocking` 中执行，可取消（子进程 kill）
- 规则检查 >2MB 文件跳过；文件树扫描深度 ≤12
