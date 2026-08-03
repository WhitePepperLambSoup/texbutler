// Minimal dependency-free i18n: zh/en dictionaries + zustand store.
// Persisted in localStorage; the Settings panel switches the language.

import { create } from "zustand";

export type Lang = "zh" | "en";

type Dict = Record<string, string>;

const zh: Dict = {
  // toolbar
  "toolbar.open": "打开项目",
  "toolbar.new": "新建项目",
  "toolbar.compile": "▶ 编译",
  "toolbar.compiling": "编译中…",
  "toolbar.cancel": "取消",
  "toolbar.settings": "⚙ 设置",
  "toolbar.target.main": "主文件（{file}）",
  "toolbar.target.current": "当前文件（{file}）",
  "toolbar.target.currentEmpty": "当前文件",
  "tree.title": "项目",
  "tree.noProject": "尚未打开项目",
  "tree.openFolder": "打开 LaTeX 项目文件夹",
  "tree.newProject": "新建项目",
  "tree.recent": "最近项目",
  "tree.setMain": "设为主文件",
  "tree.isMain": "✓ 当前主文件",
  "tree.mainTag": "主",
  "editor.untitled": "未打开文件",
  "editor.save": "保存 (Ctrl+S)",
  "editor.insert": "插入片段…",
  "editor.empty": "打开或新建项目后开始编辑 .tex 文件",
  "pdf.title": "PDF 预览",
  "pdf.empty": "编译成功后在此显示 PDF",
  "pdf.openNew": "在新窗口打开",
  "problems.compile": "编译错误 ({n})",
  "problems.rules": "规则检查 ({n})",
  "problems.rulesRunning": "规则检查中…",
  "problems.log": "日志",
  "problems.logTitle": "编译日志（main.log）",
  "problems.copyAll": "复制全部",
  "problems.noErrors": "没有编译错误 🎉",
  "problems.notCompiled": "尚未编译",
  "problems.runRules": "立即运行规则检查",
  "problems.copy": "复制错误信息",
  "problems.aiExplain": "AI 解释",
  "problems.aiFix": "AI 修复",
  "sev.error": "错误",
  "sev.warning": "警告",
  "sev.info": "提示",
  "sev.suggestion": "建议",
  "ai.title": "AI 助手",
  "ai.clear": "清空",
  "ai.busyDiagnose": "分析中…",
  "ai.busyFix": "修复中…",
  "ai.empty": '在"编译错误"列表中选择一条错误，点击 AI 解释 或 AI 修复。\n支持 OpenAI 兼容 / Anthropic / Ollama，请在"设置"中配置。',
  "ai.rawToggleShow": "查看原始回复",
  "ai.rawToggleHide": "收起原始回复",
  "ai.diffBar": "AI 已生成修复方案（第 {n} 轮）。",
  "ai.diffApply": "应用并确认",
  "ai.diffReject": "拒绝",
  "ai.oneKeyFix": "一键修复：{msg}（{loc}）",
  "ai.explainReq": "请解释这条错误：{msg}（{loc}）",
  "ai.diffGenerated": "AI 已生成修复 diff（第 {n} 轮）。请先预览确认，接受后才会写入文件。",
  "ai.fixFailed": "❌ {summary}",
  "ai.fixApplied": "✅ 修复已应用并通过编译（第 {n} 轮）：{summary}",
  "ai.rejected": "已拒绝该修复 diff（未写入任何文件）。",
  "ai.diagFailed": "诊断失败：{e}",
  "ai.fixFailedMsg": "修复失败：{e}",
  "settings.connFailed": "连接失败：{e}",
  "status.engine": "引擎：{name}",
  "status.engineNone": "引擎：—",
  "status.engineFellBack": "（已自动降级）",
  "status.duration": "耗时：{s}s",
  "status.result": "结果：{ok}",
  "status.ok": "✅ 成功",
  "status.fail": "❌ 失败",
  "status.issues": "问题：{n}",
  "status.noProject": "未打开项目",
  "settings.title": "设置",
  "settings.save": "保存",
  "settings.cancel": "取消",
  "settings.saved": "设置已保存",
  "settings.saveFailed": "保存失败：{e}",
  "settings.aiProvider": "AI Provider",
  "settings.providerType": "Provider 类型",
  "settings.baseUrl": "Base URL",
  "settings.model": "模型",
  "settings.apiKey": "API Key",
  "settings.apiKeyHint": "（Ollama 可留空）",
  "settings.apiKeyNote": "仅保存在本机 settings.json，不会上传或写入日志。",
  "settings.thinking": "关闭思考模式（DeepSeek 等模型的思考会消耗大量 token，可能导致修复返回空内容）",
  "settings.test": "测试连接",
  "settings.testing": "测试中…",
  "settings.engine": "编译内核",
  "settings.engineChoice": "引擎选择",
  "settings.engineAuto": "自动（Tectonic 优先，失败自动切换系统 TeX）",
  "settings.engineTectonic": "仅 Tectonic",
  "settings.engineSystem": "仅系统 TeX Live / MiKTeX",
  "settings.passes": "系统引擎编译遍数（TOC/交叉引用需要 ≥2 遍）",
  "settings.passes1": "1 遍（快速，无目录）",
  "settings.passes2": "2 遍（推荐）",
  "settings.passes3": "3 遍（复杂文档）",
  "settings.passes4": "4 遍",
  "settings.passes5": "5 遍",
  "settings.bundle": "预下载 Tectonic bundle（离线可用）",
  "settings.fonts": "系统中文字体",
  "settings.fontsNote": "缺失的字体可能导致 ctex 中文文档报\"字体未找到\"。ctex 默认使用系统字体；Tectonic 内置 Fandol 字体（中文文档一般无需额外安装）。",
  "settings.rulesTitle": "中文规则检查（保存时自动触发）",
  "settings.language": "界面语言 / Language",
  "settings.languageZh": "简体中文",
  "settings.languageEn": "English",
  "newProject.title": "新建项目",
  "newProject.parent": "父目录（绝对路径，将在其中创建同名文件夹）",
  "newProject.name": "项目名称",
  "newProject.template": "模板",
  "newProject.create": "创建并打开",
  "newProject.creating": "创建中…",
  "newProject.parentRequired": "请填写父目录绝对路径",
  "newProject.nameRequired": "请填写项目名称",
  "newProject.failed": "创建失败：{e}",
  "errorBoundary.title": "界面出现异常",
  "errorBoundary.recover": "尝试恢复",
  "errorBoundary.reload": "重新加载",
  "compile.prepare": "准备编译…",
  "compile.running": "使用 {engine} 编译中…",
  "compile.done": "编译完成",
  "compile.failed": "编译失败",
};

const en: Dict = {
  "toolbar.open": "Open Project",
  "toolbar.new": "New Project",
  "toolbar.compile": "▶ Compile",
  "toolbar.compiling": "Compiling…",
  "toolbar.cancel": "Cancel",
  "toolbar.settings": "⚙ Settings",
  "toolbar.target.main": "Main file ({file})",
  "toolbar.target.current": "Current file ({file})",
  "toolbar.target.currentEmpty": "Current file",
  "tree.title": "Project",
  "tree.noProject": "No project opened",
  "tree.openFolder": "Open a LaTeX project folder",
  "tree.newProject": "New Project",
  "tree.recent": "Recent projects",
  "tree.setMain": "Set as main file",
  "tree.isMain": "✓ Current main file",
  "tree.mainTag": "MAIN",
  "editor.untitled": "No file open",
  "editor.save": "Save (Ctrl+S)",
  "editor.insert": "Insert snippet…",
  "editor.empty": "Open or create a project to start editing .tex files",
  "pdf.title": "PDF Preview",
  "pdf.empty": "The PDF appears here after a successful compile",
  "pdf.openNew": "Open in new window",
  "problems.compile": "Compile errors ({n})",
  "problems.rules": "Rule check ({n})",
  "problems.rulesRunning": "Checking…",
  "problems.log": "Log",
  "problems.logTitle": "Compile log (main.log)",
  "problems.copyAll": "Copy all",
  "problems.noErrors": "No compile errors 🎉",
  "problems.notCompiled": "Not compiled yet",
  "problems.runRules": "Run rule check now",
  "problems.copy": "Copy error info",
  "problems.aiExplain": "AI explain",
  "problems.aiFix": "AI fix",
  "sev.error": "Error",
  "sev.warning": "Warning",
  "sev.info": "Info",
  "sev.suggestion": "Suggestion",
  "ai.title": "AI Assistant",
  "ai.clear": "Clear",
  "ai.busyDiagnose": "Analyzing…",
  "ai.busyFix": "Fixing…",
  "ai.empty": "Select an error in the \"Compile errors\" list and click AI explain or AI fix.\nProviders: OpenAI-compatible / Anthropic / Ollama — configure in Settings.",
  "ai.rawToggleShow": "Show raw reply",
  "ai.rawToggleHide": "Hide raw reply",
  "ai.diffBar": "AI generated a fix (round {n}).",
  "ai.diffApply": "Apply & confirm",
  "ai.diffReject": "Reject",
  "ai.oneKeyFix": "One-click fix: {msg} ({loc})",
  "ai.explainReq": "Explain this error: {msg} ({loc})",
  "ai.diffGenerated": "AI generated a fix diff (round {n}). Review it — it is only written to the file after you accept.",
  "ai.fixFailed": "❌ {summary}",
  "ai.fixApplied": "✅ Fix applied and compiled (round {n}): {summary}",
  "ai.rejected": "Diff rejected (no file was changed).",
  "ai.diagFailed": "Diagnosis failed: {e}",
  "ai.fixFailedMsg": "Fix failed: {e}",
  "settings.connFailed": "Connection failed: {e}",
  "status.engine": "Engine: {name}",
  "status.engineNone": "Engine: —",
  "status.engineFellBack": " (auto-fallback)",
  "status.duration": "Time: {s}s",
  "status.result": "Result: {ok}",
  "status.ok": "✅ OK",
  "status.fail": "❌ Failed",
  "status.issues": "Issues: {n}",
  "status.noProject": "No project opened",
  "settings.title": "Settings",
  "settings.save": "Save",
  "settings.cancel": "Cancel",
  "settings.saved": "Settings saved",
  "settings.saveFailed": "Save failed: {e}",
  "settings.aiProvider": "AI Provider",
  "settings.providerType": "Provider type",
  "settings.baseUrl": "Base URL",
  "settings.model": "Model",
  "settings.apiKey": "API Key",
  "settings.apiKeyHint": " (empty for Ollama)",
  "settings.apiKeyNote": "Stored locally in settings.json; never uploaded or logged.",
  "settings.thinking": "Disable thinking mode (DeepSeek's thinking can consume the token budget and yield an empty reply)",
  "settings.test": "Test connection",
  "settings.testing": "Testing…",
  "settings.engine": "Compile Engine",
  "settings.engineChoice": "Engine selection",
  "settings.engineAuto": "Auto (Tectonic first, fallback to system TeX)",
  "settings.engineTectonic": "Tectonic only",
  "settings.engineSystem": "System TeX Live / MiKTeX only",
  "settings.passes": "System engine passes (≥2 for TOC/cross-refs)",
  "settings.passes1": "1 pass (fast, no TOC)",
  "settings.passes2": "2 passes (recommended)",
  "settings.passes3": "3 passes (complex docs)",
  "settings.passes4": "4 passes",
  "settings.passes5": "5 passes",
  "settings.bundle": "Pre-download Tectonic bundle (offline)",
  "settings.fonts": "System CJK fonts",
  "settings.fontsNote": "Missing fonts can cause \"font not found\" errors in ctex documents. Tectonic bundles the Fandol fonts, so most Chinese docs need nothing extra.",
  "settings.rulesTitle": "Chinese rule checks (auto-run on save)",
  "settings.language": "界面语言 / Language",
  "settings.languageZh": "简体中文",
  "settings.languageEn": "English",
  "newProject.title": "New Project",
  "newProject.parent": "Parent directory (absolute path; a subfolder will be created)",
  "newProject.name": "Project name",
  "newProject.template": "Template",
  "newProject.create": "Create & open",
  "newProject.creating": "Creating…",
  "newProject.parentRequired": "Please enter an absolute parent path",
  "newProject.nameRequired": "Please enter a project name",
  "newProject.failed": "Create failed: {e}",
  "errorBoundary.title": "Something went wrong",
  "errorBoundary.recover": "Try to recover",
  "errorBoundary.reload": "Reload",
  "compile.prepare": "Preparing compile…",
  "compile.running": "Compiling with {engine}…",
  "compile.done": "Compile finished",
  "compile.failed": "Compile failed",
};

const dicts: Record<Lang, Dict> = { zh, en };

interface I18nState {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

function loadLang(): Lang {
  try {
    const saved = window.localStorage.getItem("tb-lang");
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* ignore */
  }
  return "zh";
}

export const useI18n = create<I18nState>((set, get) => ({
  lang: loadLang(),
  setLang: (l) => {
    try {
      window.localStorage.setItem("tb-lang", l);
    } catch {
      /* ignore */
    }
    set({ lang: l });
  },
  t: (key, vars) => {
    const dict = dicts[get().lang] ?? zh;
    let s = dict[key] ?? zh[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replaceAll(`{${k}}`, String(v));
      }
    }
    return s;
  },
}));

/** Convenience hook: `const t = useT();` — subscribes to `lang` so the
 * returned function re-renders the component when the language changes. */
export function useT() {
  useI18n((s) => s.lang); // subscribe to language changes
  return useI18n((s) => s.t);
}
