# 下一步功能路线图（基于 v0.6.1 现状扫描）

> 本文档为纯建议，未改动任何代码。基于对 951fba5（v0.6.1）全量代码的只读扫描与两轮深度审查。
> 现状盘点：10 条规则引擎、AI 修复循环（真回滚）、AI 对话/翻译/指南、声明式工具调用通道 + 编译验证闭环、SyncTeX 正向搜索、docx/md 导出、字数统计、表格生成器、本地模板、OTA 更新、多主文档、`.bib` 解析与引用索引。

## A 级：贴现有架构、低成本、高价值（下一步首选）

| # | 功能 | 现状基础（可复用） | 落地要点 |
|---|------|--------------------|----------|
| A1 | **通用文件历史/版本时间线** | AI 快照已存 `.texbutler/backup/`（fix_loop.rs snapshot/rollback），`tb_ai_snapshots`/`tb_ai_rollback` 已有 UI | 扩为"每次编译前 + 每 5 分钟自动快照全部 tex"，时间线面板 diff 预览 + 一键回滚；复用 rollback_from_backup 三重路径防护 |
| A2 | **label 批量重命名（F2）** | `rules/refs.rs` 的 scan_labels 索引 + refIndex 补全已就绪 | Monaco rename provider：改 `\label{foo}` 同步所有 `\ref{foo}`/`\eqref{foo}`/`\pageref`；纯文本替换 + 预览 diff |
| A3 | **第 11 条规则：CJK 与英文/数字间空格** | 规则引擎 10 条框架 + 单测模式 | 中文论文最常见规范问题（「使用LaTeX」→「使用 LaTeX」）；`is_in_comment` 感知已有；注册表加一条 + 测试 |
| A4 | **bib 条目可视化编辑器** | `core/bib.rs` 解析共用（面板/规则/补全三处复用） | 字段表单 + 校验（缺 title/year 高亮）+ 自动格式化 + 新条目向导；补全/规则即时刷新 |
| A5 | **跨文件查找替换** | `collect_tex` 全项目文件扫描 + fix_loop 的 apply_diff | Monaco 替换扩展到全项目：regex 搜索 → 结果列表 → diff 预览 → 批量应用（复用 diff 审计防错） |

## B 级：AI 深化（用户关注方向）

| # | 功能 | 说明 |
|---|------|------|
| B1 | **规则一键全量修复** | `tb_fix_rule_issue` 已有单条确定性修复 + AiPanel 逐 hunk 应用；补"全部修复"聚合入口（修复预览列表 → 逐条接受/拒绝，沿用真回滚语义） |
| B2 | **AI 全文审阅（批注模式）** | 复用工具调用通道 + 快照回滚：AI 输出"位置 + 问题 + 修改建议"清单，用户逐条接受/拒绝（先预览后应用，吸取假确认教训的正确形态） |
| B3 | **AI 生成 pgfplots/tikz 图表** | 编译验证闭环现成：用户给数据 → AI 生成图表代码 → 自动编译验证 → 失败回喂修复 → 插入光标处 |
| B4 | **公式截图识别（图片→LaTeX）** | 与 FormulaModal/KaTeX 预览联动；本地 LaTeX-OCR 模型或云 API，插入后立即编译验证 |
| B5 | **对话会话历史持久化** | chat 每轮全量上下文；会话 JSON 落盘（`.texbutler/chats/`）+ 继续/重命名/删除；token 用量按会话统计（tb_token_usage 已有） |

## C 级：中成本亮点

| # | 功能 | 说明 |
|---|------|------|
| C1 | **PDF 反向搜索（点击回源）** | 现 iframe PDFium 无点击回调（synctex.rs 明确 out of scope）；改嵌 `pdfjs-dist`（text layer 点击 → synctex 反向解析 → 跳转编辑器行）——最亮眼但成本最高 |
| C2 | **模板市场/分享** | 本地模板已有（tb_list_templates）；加"导入 zip 模板 / 导出当前项目为模板"，可选在线仓库 |
| C3 | **git 集成面板** | status/diff/commit 轻量集成（Command::arg 安全模式已有先例） |
| C4 | **多文档一键导出** | 批量 md/docx 导出 + 进度事件（tb_export 已有单文件能力） |

## D 级：打磨（小成本）

- 状态栏增强：光标行列 + 当前环境/章节名
- 命令面板（Ctrl+Shift+P，Monaco addAction）
- 最近文件 MRU 列表
- GBK 编码检测与转 UTF-8（国内老模板，encoding_rs 一行接入）
- 导出 PDF 时嵌入书签/大纲（tectonic 产物已含，核对超链接样式）

## 优先级建议

第一批 A1 + A2 + A3（历史时间线 / label 重命名 / CJK 空格规则）——全部贴现有骨架，合计估 500 行内，直接命中中文 LaTeX 写作的真实痛点；随后 B1/B2 完成 AI 编辑的安全闭环（预览→确认→回滚），再考虑 C1 差异化亮点。

