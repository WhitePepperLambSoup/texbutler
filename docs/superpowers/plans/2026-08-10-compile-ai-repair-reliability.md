# 编译诊断与 AI 修复链可靠性实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Each step ends with a focused verification and a small commit.

**Goal:** 修复 TeXButler 中 XeLaTeX 失败诊断、空 unified diff、fenced JSON 工具调用和问题文件 AI 会话错位问题。

**Architecture:** 先在编译器边界统一收集新 `.log` 与 stdout/stderr，产出带文件和原始证据的 `Issue`；再由 AI 层使用稳定的“无引擎输出”标记阻止盲修。补丁应用器只忽略内容完全不变的 hunk，聊天解析器仅在明确修改意图下兼容 fenced ToolCall，前端在请求开始前将问题操作绑定到所属文件的持久化会话。

**Tech Stack:** Rust 2021、Tokio、Tauri、TypeScript、React、Zustand、Vite、WebView2 E2E。

## Global Constraints

- 不修改用户项目中的 `q2_en.tex`、`main.tex` 或任何外部文件。
- AI 可写范围仍为项目内 `.tex`、`.bib`、`.sty`、`.cls`；路径校验、快照和回滚不能削弱。
- 不以本地化错误字符串判断“无输出”；使用稳定的 `texbutler:no-engine-output` raw 标记。
- 未知行号保持 `None`，UI 和 AI 上下文不得显示第 0 行。
- 不改变一键修复最多 3 轮策略；所有空 diff 必须在写文件/编译前拒绝。
- 新增生产代码必须先有一个会失败的回归测试。
- 所有提交只发生在 `codex/fix-compile-ai-repair`，不推送远端。

---

### Task 1: 修复未知行号的源上下文渲染

**Files:**
- Modify: `src-tauri/src/core/mod.rs` (`SourceContext::around`, `SourceContext::render`)
- Test: `src-tauri/src/core/mod.rs` 的 `#[cfg(test)]` 模块（新增）

**Interfaces:**
- Consumes: `SourceContext::around(file, line, body, radius)` 现有签名。
- Produces: 相同结构体字段和序列化格式；`line=None` 时 `focus=None`、渲染行号从 1 开始。

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn unknown_line_context_does_not_mark_first_line_as_error() {
    let ctx = SourceContext::around(
        "q2_en.tex",
        None,
        "\\documentclass{article}\n\\usepackage{ctex}\n正文\n",
        2,
    );
    assert!(ctx.focus.is_none());
    let rendered = ctx.render();
    assert!(rendered.contains("1 | \\documentclass{article}"));
    assert!(!rendered.contains("0 |"));
    assert!(!rendered.contains("<<<< 此处出错"));
}
```

- [ ] **Step 2: 运行测试确认它按预期失败**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml core::tests::unknown_line_context_does_not_mark_first_line_as_error -- --exact
```

Expected: FAIL，因为当前 `around(None)` 将第一行放入 `focus`，`render()` 输出 `0 | ... <<<< 此处出错`。

- [ ] **Step 3: 写最小实现**

在 `around` 中分开处理 `line=None`：把文件开头最多 `radius * 2 + 1` 行放入 `after`，不设置 `focus`。在 `render` 开头加入未知行号分支，按 1-based 行号顺序输出 `after`，然后直接返回；保留 `line=Some(n)` 的现有 before/focus/after 算法。

```rust
if self.line.is_none() {
    for (i, line) in self.after.iter().enumerate() {
        out.push_str(&format!("{} | {}\\n", i + 1, line));
    }
    return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run 同一条 `cargo test`；Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src-tauri/src/core/mod.rs
git commit -m "fix: avoid false line zero in AI source context"
```

### Task 2: 保留 XeLaTeX 控制台证据并标记不可安全修复

**Files:**
- Modify: `src-tauri/src/core/compiler/texlive.rs`
- Modify: `src-tauri/src/core/ai/fix_loop.rs`
- Test: `src-tauri/src/core/compiler/texlive.rs` 测试模块
- Test: `src-tauri/src/core/ai/fix_loop.rs` 测试模块

**Interfaces:**
- Produces: `pub(crate) const NO_ENGINE_OUTPUT_MARKER: &str = "texbutler:no-engine-output"`；纯函数 `synthesize_failure_issues(main: &Path, engine_name: &str, exit_code: Option<i32>, log_text: &str, console_text: &str) -> Vec<Issue>`。
- Consumes: 现有 `SystemTexliveCompiler::compile` 的 `all_logs`、`produced_log` 和 `Issue` 类型。

- [ ] **Step 1: 写失败测试——控制台优先与主文件定位**

```rust
#[test]
fn failure_diagnostics_use_console_when_log_has_no_parseable_error() {
    let issues = synthesize_failure_issues(
        Path::new("q2_en.tex"),
        "xelatex",
        Some(1),
        "This is a stale log with no errors",
        "C:/tmp/q2_en.tex:7: Undefined control sequence.\\n! Undefined control sequence.\\n",
    );
    assert_eq!(issues[0].file.as_deref(), Some("q2_en.tex"));
    assert_eq!(issues[0].line, Some(7));
    assert!(issues[0].raw.as_deref().unwrap().contains("Undefined control sequence"));
}

#[test]
fn failure_diagnostics_mark_empty_engine_output_without_fake_line() {
    let issues = synthesize_failure_issues(Path::new("q2_en.tex"), "xelatex", Some(1), "", "");
    assert_eq!(issues[0].file.as_deref(), Some("q2_en.tex"));
    assert_eq!(issues[0].line, None);
    assert!(issues[0].raw.as_deref().unwrap().starts_with(NO_ENGINE_OUTPUT_MARKER));
}
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml failure_diagnostics_use_console_when_log_has_no_parseable_error -- --exact
cargo test --manifest-path src-tauri/Cargo.toml failure_diagnostics_mark_empty_engine_output_without_fake_line -- --exact
```

Expected: FAIL，因为当前 fallback Issue 没有 `file`、`line`、`raw` 控制台证据，也没有稳定标记。

- [ ] **Step 3: 写最小实现**

在编译开始时删除 `produced_log`，每次进程输出以 `String::from_utf8_lossy` 收集到 `console_text`。让 `synthesize_failure_issues` 依次调用 `parse_log_str(log_text)`、`parse_log_str(console_text)`；对解析到的相对/绝对路径调用项目根目录归一化，无法归一化时回退到 `main`。无结构化问题时构造：

```rust
let raw = if console_text.trim().is_empty() {
    format!("{NO_ENGINE_OUTPUT_MARKER}\\nengine={engine_name} exit_code={exit_code:?}")
} else {
    format!("engine={engine_name} exit_code={exit_code:?}\\n{}", tail(console_text, 12_000))
};
Issue::new(Severity::Error, IssueKind::CompileError, message)
    .with_file(main.to_string_lossy().replace('\\\\', "/"))
    .with_raw(raw)
```

在 `fix_loop` 增加纯函数 `is_unrepairable_engine_failure(issue: &Issue) -> bool`，只识别 `raw` 的稳定 marker；在进入 AI chat 前返回 `FixReport`，`rounds=0`、`diff=None`、`suggested=!apply`。

- [ ] **Step 4: 运行两条回归测试及日志解析测试**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml failure_diagnostics -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml core::log_parser -- --nocapture
```

Expected: PASS；控制台错误可定位，空输出带 marker 且无伪行号。

- [ ] **Step 5: 提交**

```powershell
git add src-tauri/src/core/compiler/texlive.rs src-tauri/src/core/ai/fix_loop.rs
git commit -m "fix: preserve system tex diagnostics for AI repair"
```

### Task 3: 允许 mixed diff 跳过空 hunk

**Files:**
- Modify: `src-tauri/src/core/ai/fix_loop.rs` (`apply_unified_diff`, `apply_hunk`)
- Modify: `src-tauri/src/core/ai/prompt_templates.rs`（禁止 no-op hunk 的提示）
- Test: `src-tauri/src/core/ai/fix_loop.rs` 测试模块

**Interfaces:**
- Keeps: `pub fn apply_unified_diff(original: &str, diff: &str) -> Result<String, String>`。
- Internal change: `apply_hunk` 对完全未改变的 hunk 返回原内容，而不是错误；外层统一判断是否至少有一个 hunk 改变。

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn mixed_real_and_noop_hunks_apply_real_change() {
    let original = "a\\n\nunchanged\\n\nb\\n";
    let diff = "@@ -1,1 +1,1 @@\\n-a\\n+A\\n@@ -3,1 +3,1 @@\\n-unchanged\\n+unchanged\\n";
    assert_eq!(apply_unified_diff(original, diff).unwrap(), "A\\n\nunchanged\\n\nb");
}

#[test]
fn all_noop_hunks_are_rejected_before_compile() {
    let diff = "@@ -1,1 +1,1 @@\\n-a\\n+a\\n@@ -3,1 +3,1 @@\\n-b\\n+b\\n";
    assert!(apply_unified_diff("a\\n\nb\\n", diff)
        .unwrap_err()
        .contains("没有实际修改"));
}
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml mixed_real_and_noop_hunks_apply_real_change -- --exact
```

Expected: FAIL，当前反向遍历在空 hunk处直接返回“没有实际修改”。

- [ ] **Step 3: 写最小实现**

让 `apply_hunk` 在 `!applied_any` 时返回 `Ok(original.to_string())`；`apply_unified_diff` 维护 `changed`，只有 `next != result` 才更新并置 true。所有 hunk完成后若 `changed=false` 返回原有 no-op 错误。同步在 `fix_prompt` 中加入“不要输出 `-X/+X` 相同对，不要输出只有上下文的 hunk”。

- [ ] **Step 4: 运行 diff 单测与完整 fix_loop 单测**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml core::ai::fix_loop -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml core::ai::prompt_templates -- --nocapture
```

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src-tauri/src/core/ai/fix_loop.rs src-tauri/src/core/ai/prompt_templates.rs
git commit -m "fix: ignore no-op hunks in AI patches"
```

### Task 4: 兼容明确修改请求中的 fenced ToolCall

**Files:**
- Modify: `src-tauri/src/core/ai/chat.rs` (`parse_tool_calls`, `user_facing_tool_text`, `run_edit_chat`)
- Test: `src-tauri/src/core/ai/chat.rs` 测试模块

**Interfaces:**
- Keeps: `parse_tool_calls(reply: &str)` 现有调用者和 marker/bare JSON 行为。
- Adds: `parse_tool_calls_with_mode(reply: &str, allow_fenced: bool) -> Vec<ToolCall>`；`parse_tool_calls` 调用它并传 `false`，`run_edit_chat` 根据用户请求传入 `question_requests_edit(question)`。

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn fenced_read_tool_after_prose_is_parsed_only_for_edit_request() {
    let reply = "我先读取文件。\\n```json\\n{\\"tool\\":\\"read_file\\",\\"file\\":\\"main.tex\\"}\\n```";
    assert!(parse_tool_calls(reply).is_empty());
    let calls = parse_tool_calls_with_mode(reply, true);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].tool, "read_file");
}

#[test]
fn explanation_example_in_fenced_json_is_not_executed() {
    let reply = "解释工具格式：\\n```json\\n{\\"tool\\":\\"replace\\",\\"file\\":\\"main.tex\\",\\"old\\":\\"a\\",\\"new\\":\\"b\\"}\\n```";
    assert!(parse_tool_calls_with_mode(reply, false).is_empty());
}
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml fenced_read_tool_after_prose_is_parsed_only_for_edit_request -- --exact
```

Expected: FAIL，因为当前解析器只接受回复开头 bare JSON 或 `【工具调用】` marker。

- [ ] **Step 3: 写最小实现**

扫描 ` ```json`/` ```JSON` 代码围栏，复用 `parse_json_objects` 解析已知 `ToolCall`；只在 `allow_fenced=true` 时加入结果。`question_requests_edit` 使用固定中英文动作词集合，不把“解释/查看格式/示例”当作修改意图。对 `user_facing_tool_text` 使用同一 span 提取器移除已执行的 fenced JSON，保留说明文字。

- [ ] **Step 4: 运行 chat 单测和现有 read/edit 流程测试**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml core::ai::chat -- --nocapture
```

Expected: PASS，现有 marker、bare JSON、读取轮次上限和回滚相关测试保持通过。

- [ ] **Step 5: 提交**

```powershell
git add src-tauri/src/core/ai/chat.rs
git commit -m "fix: execute safe fenced AI tool calls"
```

### Task 5: 将问题解释/修复绑定到问题所属文件会话

**Files:**
- Modify: `src/store/aiStore.ts`（新增 `focusIssueFile`，调整 `diagnoseIssue`、`fixIssue`）
- Modify: `src/components/ProblemsPanel.tsx`（动作调用等待文件聚焦）
- Test: `scripts/e2e-v088.mjs`（新增 WebView2 回归场景）

**Interfaces:**
- Adds store action `focusIssueFile(file: string | null): Promise<void>`：在当前项目内打开文件，等待 `openFile` 完成后调用 `attachFile(root, file)`。
- `diagnoseIssue`/`fixIssue` 在 `captureRequestContext()` 前 `await focusIssueFile(issue.file)`；无文件时保持现有活动会话。
- `ProblemsPanel` 的点击处理保留事件隔离，但异步等待 store action，不把索引和上下文错配。

- [ ] **Step 1: 写失败 E2E 场景**

在 `scripts/e2e-v088.mjs` 中创建包含 `main.tex` 与 `contents/q2_en.tex` 的临时项目，注入两个问题并调用 store：

```js
await callAi(`useAiStore.getState().attachFile(${JSON.stringify(root)}, 'main.tex')`);
await callAi(`await useAiStore.getState().diagnoseIssue(${JSON.stringify(issueForQ2)}, 0)`);
const active = await callAi(`useAiStore.getState().activeFile`);
const messages = await callAi(`useAiStore.getState().messages.map(m => m.text).join('\\n')`);
assert.equal(active, 'contents/q2_en.tex');
assert(messages.includes('q2-en-diagnosis'));
```

- [ ] **Step 2: 运行场景确认失败**

```powershell
node scripts/e2e-v088.mjs --case issue-session-scope
```

Expected: FAIL，当前请求仍写入 `main.tex` 会话，`activeFile` 不会切换到 `contents/q2_en.tex`。

- [ ] **Step 3: 写最小实现**

`focusIssueFile` 只处理项目内 `.tex` 文件；调用 `useProjectStore.getState().openFile(file)`，完成后读取最新 `root` 并 `attachFile`。若文件不存在，保留当前会话并让后端返回精确错误。`diagnoseIssue` 和 `fixIssue` 在捕获 request context 前等待该 action，保证返回结果写回同一个文件会话。

- [ ] **Step 4: 运行 E2E 场景确认通过**

```powershell
node scripts/e2e-v088.mjs --case issue-session-scope
```

Expected: PASS，`q2_en.tex` 会话收到请求与结果，切回 `main.tex` 不出现该消息。

- [ ] **Step 5: 提交**

```powershell
git add src/store/aiStore.ts src/components/ProblemsPanel.tsx scripts/e2e-v088.mjs
git commit -m "fix: scope issue actions to the reported file"
```

### Task 6: 完整验证与交付检查

**Files:**
- Modify: none（仅验证）
- Test: `scripts/e2e-v088.mjs` 全部场景及既有 `scripts/e2e-v087.mjs`

- [ ] **Step 1: 运行 Rust 新增回归测试**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml core::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml core::compiler::texlive -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml core::ai::fix_loop -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml core::ai::chat -- --nocapture
```

Expected: 所有新增和现有测试通过；需要系统 TeX/真实 API 的测试按现有标记忽略。

- [ ] **Step 2: 运行前端类型检查和生产构建**

```powershell
npx.cmd tsc --noEmit
npm.cmd run build
```

Expected: 两条命令退出码为 0。

- [ ] **Step 3: 运行 WebView2 回归矩阵**

```powershell
node scripts/e2e-v088.mjs
node scripts/e2e-v087.mjs
```

Expected: 编译错误显示真实 raw、未知行号不显示 0、mixed diff 可应用、fenced 工具执行受保护、问题操作按文件隔离，且原有文件级会话/竞态场景保持通过。

- [ ] **Step 4: 做提交前检查**

```powershell
git diff --check
git status --short --branch
git log --oneline --decorate -6
```

Expected: 只有预期代码提交和未跟踪本地 `.superpowers/`；不提交用户项目文件，不执行 push。

- [ ] **Step 5: 创建最终本地提交并报告**

```powershell
git add src-tauri/src/core/mod.rs src-tauri/src/core/compiler/texlive.rs src-tauri/src/core/ai/fix_loop.rs src-tauri/src/core/ai/prompt_templates.rs src-tauri/src/core/ai/chat.rs src/store/aiStore.ts src/components/ProblemsPanel.tsx scripts/e2e-v088.mjs
git commit -m "fix: make compile diagnostics and AI repair reliable"
```

报告分支、提交哈希、验证命令结果和未推送状态；保留 `.superpowers/` 与其他本地审查记录。
