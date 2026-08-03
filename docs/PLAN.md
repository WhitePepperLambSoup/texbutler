# 开发计划（跟踪进度）

> 本文件是项目 prompt 中"分阶段计划"的拷贝，用于跟踪进度。勾选 = 已完成并验证。

## 阶段 0：工程骨架 ✅

- [x] Tauri 2 + React + TS + Vite 工程，窗口 1280x800，identifier `com.texbutler.app`
- [x] core / commands / rules / ai 模块骨架，`cargo check` 通过
- [x] 四栏布局（项目树 | 编辑器 | PDF | 问题面板）+ 底部 AI 面板
- [x] Monaco 集成（latex 语法高亮、Ctrl+S 保存）
- [x] git 初始 commit

## 阶段 1：最小编译闭环 ✅

- [x] `TectonicCompiler`：单文件 .tex → PDF + .log（bundle 按需下载缓存）
- [x] `.log` 解析器第一版：错误块 / 行号 / 基本分类
- [x] 前端"编译"→ `tb_compile` → PDF 预览刷新 + 问题面板（点击跳转编辑器）
- [x] `assets/sample/` 中文 ctex 样例（含故意踩坑点），tectonic + xelatex 双引擎实测通过

## 阶段 2：中文完善 + 多文件项目 + 兜底 ✅

- [x] 多文件项目：文件树递归、`\input`/`\include` 子文件支持（tectonic filesystem_root / texlive 同目录运行）
- [x] `SystemTexliveCompiler` 兜底：PATH 检测 xelatex/lualatex，tectonic 失败自动切换，结果标记引擎 + fell_back
- [x] 编译引擎切换 UI 提示（编译进度事件中展示引擎名）
- [x] 文件监视（notify）：外部修改刷新文件树与诊断

## 阶段 3：bundle 本地化与打包 ✅（部分）

- [x] bundler.rs：预热下载（编译热身文档拉取 ctex/fandol 等资源到 tectonic 缓存）+ 离线 `-C --only-cached`
- [x] `TEXBUTLER_BUNDLE_DIR` / `TEXBUTLER_BUNDLE_ZIP` 发布资源入口；tectonic.exe 已打包进 resources
- [x] Tauri 打包配置（NSIS + MSI）
- [ ] 干净 Windows 虚拟机实测"安装即编译"（无 texlive、无网络）——需要发布后环境验证，已通过"预下载 + only-cached"路径保证

## 阶段 4：AI 诊断 ✅

- [x] provider.rs：OpenAI 兼容 + Anthropic + Ollama（OpenAI 兼容端点），设置持久化 settings.json
- [x] diagnose.rs：错误 + 局部上下文 → 中文人话解释 + 修复方向（≤150 字 prompt）
- [x] SettingsModal：preset（OpenAI/DeepSeek/Qwen/Anthropic/Ollama）、测试连接、无 key 引导文案

## 阶段 5：AI 修复闭环 ✅

- [x] fix_loop.rs：diff 生成 → 解析/应用（上下文校验）→ 备份快照 → 重编译 → ≤3 轮 → 失败回滚
- [x] 前端 diff 预览（接受/拒绝），拒绝不写文件
- [x] 修复后自动重跑诊断刷新

## 阶段 6：中文规则引擎上线 ✅（9 条）

- [x] 9 条规则 + 注册表 + 规则开关（设置持久化 + 设置面板 UI）
- [x] 问题面板"规则检查"页签，保存防抖 500ms 自动触发，编译完成自动检查
- [x] 自测：样例全部命中且无误报（纯 ASCII 注释不误报——percent 规则仅当 `%` 前是数字时触发）
- [x] 扩展：missing_end（文档未闭合）、bom（UTF-8 BOM）两条新规则

## 迭代增强（0.1.0 交付时追加）

- [x] 新建项目模板：ctexart / ctexrep（含目录）/ ctexbeamer / blank
- [x] 主文件切换（右键"设为主文件"，持久化 `.texbutler/main.txt`）+ 编译目标选择（主文件/当前文件，Ctrl+B / Ctrl+Shift+B）
- [x] 底部状态栏：引擎 / 耗时 / 结果 / 问题数 / 项目路径
- [x] 原始日志查看器（main.log 弹窗 + 复制）、错误原文复制、规则 fix_hint 展示
- [x] 常用 LaTeX 片段插入（章节/图/表/公式/引用等 11 个）
- [x] 最近项目快速打开、系统中文字体检测、保存前未保存修改保护
- [x] 修复 MiKTeX `-output-directory` 下多文件 `\input` 解析失败的兼容问题（TEXINPUTS 方案 + 集成测试）
- [x] 真实 tectonic 日志回归 fixture（tests/fixtures/ + tests/log_regression.rs）
- [x] 61 个测试全部通过（59 单元 + 2 真实日志回归；1 个系统 xelatex 集成测试手动验证通过）

## 阶段 7（后续，不在本次范围）

- [ ] 数字一致性检查、引用核查、模板库、代码签名分发

## 待定区（发现但未扩展 scope）

- 无
