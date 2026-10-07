// Typed Tauri command wrappers + event helpers.
// Every command here mirrors a `tb_` command in src-tauri/src/commands/.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Unified issue shape (mirrors src-tauri Issue). */
export interface Issue {
  severity: "error" | "warning" | "info" | "suggestion";
  file?: string | null;
  line?: number | null;
  col?: number | null;
  message: string;
  raw?: string | null;
  kind: "compile_error" | "rule_check" | "ai_diagnosis" | "consistency";
  rule_id?: string | null;
  fix_hint?: string | null;
}

export interface CompileResult {
  ok: boolean;
  pdf_path?: string | null;
  log_path: string;
  issues: Issue[];
  engine: "tectonic" | "system_texlive";
  fell_back: boolean;
}

export interface ProjectFileNode {
  path: string;
  name: string;
  is_dir: boolean;
  children: ProjectFileNode[];
}

export interface ProjectInfo {
  root: string;
  generation: number;
  main_file: string;
  files: ProjectFileNode[];
  pdf_url?: string | null;
}

export interface CompileProgress {
  stage: string;
  progress: number;
  message: string;
}

export interface CompileProgressEvent extends CompileProgress {
  root: string;
  generation: number;
}

export interface FixHunk {
  file: string;
  line: number;
  old: string;
  new: string;
  why: string;
}

export interface FixReport {
  ok: boolean;
  rounds: number;
  diff?: string | null;
  summary: string;
  issues_after: Issue[];
  rolled_back: boolean;
  backup?: string | null;
  hunks: FixHunk[];
  suggested: boolean;
}

export interface RefLabel {
  key: string;
  file: string;
  line: number;
}

export interface RefIndex {
  labels: RefLabel[];
  bib: BibEntry[];
}

export interface TodoHit {
  file: string;
  line: number;
  text: string;
}

export interface MarketTemplate {
  id: string;
  name: string;
  category: string;
  repo: string;
  desc: string;
  stars: number;
  size_kb: number;
  mode: string;
  builtin: boolean;
  ready: boolean;
  verified?: string | null;
}

export interface WordCount {
  chars: number;
  cjk_chars: number;
  words: number;
  lines: number;
}

export interface BibEntry {
  key: string;
  entry_type: string;
  title: string;
  author: string;
  year: string;
  /** location of the entry inside its .bib file (Ctrl+Click jump) */
  file?: string;
  line?: number;
}

export interface AiDiagnosis {
  ok: boolean;
  explanation: string;
  suggestion: string;
  confidence: "high" | "medium" | "low";
  raw?: string | null;
  error?: string | null;
}

export type ProviderKind =
  | { kind: "open_ai_compatible"; base_url: string }
  | { kind: "anthropic"; base_url?: string | null }
  | { kind: "ollama"; base_url: string };

export interface AiSettings {
  provider: ProviderKind;
  model: string;
  api_key?: string | null;
  temperature: number;
  max_tokens: number;
  timeout_secs: number;
  disable_thinking?: boolean;
}

export interface DiagnosticsBundle {
  compile_issues: Issue[];
  rule_issues: Issue[];
  ai_notes: Issue[];
}

export interface RuleState {
  id: string;
  name: string;
  enabled: boolean;
}

export interface CheckResult {
  issues: Issue[];
  rule_states: RuleState[];
}

export interface BundleStatus {
  bundle_dir: string;
  bundle_present: boolean;
  bundle_bytes: number;
  system_texlive: boolean;
}

export interface CompileDoneEvent {
  root: string;
  generation: number;
  result: CompileResult;
}

export type TemplateSource = "user" | "market";

export interface ImportedTemplate {
  target_dir: string;
  main_file: string;
}

export interface SearchOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface SearchHit {
  file: string;
  line: number;
  col: number;
  len: number;
  text: string;
}

export interface HistoryEntry {
  id: string;
  ts: number;
  size: number;
}

export interface GitFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";
  staged: boolean;
}

export interface GitStatus {
  available: boolean;
  is_repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export interface KeyUse {
  key: string;
  file: string;
  line: number;
}

export interface ReferenceReport {
  labels: (KeyUse & { refs: number })[];
  undefined_refs: KeyUse[];
  duplicate_labels: KeyUse[];
  bib: { key: string; file: string | null; line: number | null; title: string; cites: number }[];
  missing_cites: KeyUse[];
  nocite_all: boolean;
}

export interface PdfPos {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EngineStatus {
  tectonic: string | null;
  tectonic_user_path: string | null;
  system_engine: string | null;
  system_path: string | null;
  can_compile: boolean;
}

export interface UpdateInfo {
  version: string;
  name: string;
  body: string;
  url: string;
  asset_url?: string | null;
  asset_name?: string | null;
  asset_size?: number | null;
}

export type KeyKind = "label" | "cite";

export interface RenameKeyResult {
  files: string[];
  count: number;
  /** Edits for the file open in the editor (applied there, undoable). */
  skipped_edits: { line: number; start_col: number; end_col: number }[];
}

export interface ZoteroItem {
  citekey: string;
  title: string;
  authors: string;
  year: string;
  container: string;
  item_type: string;
  library: string;
  in_project: boolean;
}

export interface ReviewItem {
  line: number;
  start_col: number;
  end_col: number;
  quote: string;
  problem: string;
  suggestion: string;
  category: string;
}

export interface DownloadProgress {
  stage: "download" | "extract" | "done";
  downloaded: number;
  total: number;
}

export const api = {
  // project
  openProject: (path?: string) => invoke<ProjectInfo>("tb_open_project", { path: path ?? null }),
  newProject: (parent: string, name: string, template?: string) =>
    invoke<ProjectInfo>("tb_new_project", { parent, name, template: template ?? null }),
  templates: () => invoke<{ id: string; name: string; source: string }[]>("tb_get_templates"),
  saveTemplate: (name: string) => invoke<void>("tb_save_template", { name }),
  listTemplates: () => invoke<{ id: string; name: string; source: string }[]>("tb_list_templates"),
  deleteTemplate: (name: string) => invoke<void>("tb_delete_template", { name }),
  projectInfo: () => invoke<ProjectInfo>("tb_project_info"),
  readFile: (path: string) => invoke<string>("tb_read_file", { path }),
  writeFile: (path: string, content: string) => invoke<void>("tb_write_file", { path, content }),
  newFile: (path: string, template?: string) =>
    invoke<void>("tb_new_file", { path, template: template ?? null }),

  // compile
  compile: (mainOverride?: string) =>
    invoke<void>("tb_compile", { mainOverride: mainOverride ?? null }),
  cancelCompile: () => invoke<void>("tb_cancel_compile"),
  lastResult: () => invoke<CompileResult | null>("tb_get_last_result"),
  readLog: () => invoke<string>("tb_read_log"),
  setMainFile: (path: string) => invoke<ProjectInfo>("tb_set_main_file", { path }),
  importImage: (sourcePath: string) => invoke<string>("tb_import_image", { sourcePath }),
  importClipboardImage: () => invoke<string>("tb_import_clipboard_image"),
  listBibEntries: () => invoke<BibEntry[]>("tb_list_bib_entries"),
  refIndex: () => invoke<RefIndex>("tb_ref_index"),
  scanTodos: () => invoke<TodoHit[]>("tb_scan_todos"),
  bibFromId: (identifier: string) => invoke<string>("tb_bib_from_id", { identifier }),
  listMarketTemplates: () => invoke<MarketTemplate[]>("tb_list_market_templates"),
  downloadTemplate: (id: string) => invoke<string>("tb_download_template", { id }),
  importProjectTemplate: (targetDir: string, templateId: string, source: TemplateSource) =>
    invoke<ImportedTemplate>("tb_import_project_template", {
      targetDir,
      templateId,
      source,
    }),
  createFromMarketTemplate: (parent: string, name: string, templateId: string) =>
    invoke<string>("tb_create_from_market_template", { parent, name, templateId }),
  countWords: (file?: string) =>
    invoke<WordCount>("tb_count_words", { file: file ?? null }),
  listRoots: () => invoke<string[]>("tb_list_roots"),
  synctexForward: (file: string, line: number) =>
    invoke<number | null>("tb_synctex_forward", { file, line }),
  exportFile: (file: string, format: "md" | "docx") =>
    invoke<string>("tb_export", { file, format }),
  aiTranslate: (text: string, target: string) =>
    invoke<string>("tb_ai_translate", { text, target }),
  aiPolish: (text: string, mode: "compress" | "expand" | "academic") =>
    invoke<string>("tb_ai_polish", { text, mode }),
  aiChat: (question: string, file?: string | null, selection?: string | null) =>
    invoke<string>("tb_ai_chat", { question, file: file ?? null, selection: selection ?? null }),
  aiChatStream: (question: string, file?: string | null, selection?: string | null, history?: { role: string; content: string }[]) =>
    invoke<string>("tb_ai_chat_stream", { question, file: file ?? null, selection: selection ?? null, history: history ?? [] }),
  aiSnapshots: () => invoke<{ path: string; ts: string; file: string }[]>("tb_ai_snapshots"),
  // note: tb_ai_generate stays in the backend (harmless), the UI is
  // chat-driven only — see askAboutSource in the AI panel
  tokenUsage: () => invoke<{ prompt_tokens: number; completion_tokens: number; requests: number; cost_usd: number; provider: string }>("tb_token_usage"),
  tokenUsageReset: () => invoke<void>("tb_token_usage_reset"),
  aiCreateGuide: (requirements: string) => invoke<string>("tb_ai_create_guide", { requirements }),
  checkUpdates: (pretendCurrent?: string) =>
    invoke<UpdateInfo | null>("tb_check_updates", { pretendCurrent: pretendCurrent ?? null }),
  downloadUpdate: (url: string, size?: number | null) => invoke<string>("tb_download_update", { url, size: size ?? null }),
  installUpdate: (path: string) => invoke<void>("tb_install_update", { path }),
  engineStatus: () => invoke<EngineStatus>("tb_engine_status"),
  installTectonic: () => invoke<string>("tb_install_tectonic"),

  // files
  createDir: (path: string) => invoke<string>("tb_create_dir", { path }),
  renamePath: (from: string, to: string) =>
    invoke<{ from: string; to: string; main_file: string }>("tb_rename_path", { from, to }),
  deletePath: (path: string) => invoke<{ path: string; trash_id: string }>("tb_delete_path", { path }),
  restoreDeleted: (path: string, trashId: string) => invoke<string>("tb_restore_deleted", { path, trashId }),
  revealPath: (path?: string | null, output?: boolean, dryRun?: boolean) =>
    invoke<string>("tb_reveal_path", { path: path ?? null, output: output ?? null, dryRun: dryRun ?? null }),
  savePdfAs: (dest: string) => invoke<string>("tb_save_pdf_as", { dest }),

  // workspace tools
  searchProject: (options: SearchOptions) =>
    invoke<{ hits: SearchHit[]; files_searched: number; truncated: boolean }>("tb_search_project", { options }),
  replaceInProject: (options: SearchOptions, replacement: string, files?: string[] | null) =>
    invoke<{ files_changed: string[]; replacements: number }>("tb_replace_in_project", {
      options,
      replacement,
      files: files ?? null,
    }),
  historyList: (file: string) => invoke<HistoryEntry[]>("tb_history_list", { file }),
  historyRead: (file: string, id: string) => invoke<string>("tb_history_read", { file, id }),
  historySnapshot: (file: string) => invoke<string | null>("tb_history_snapshot", { file }),
  gitStatus: () => invoke<GitStatus>("tb_git_status"),
  referenceReport: () => invoke<ReferenceReport>("tb_reference_report"),
  synctexForwardPos: (file: string, line: number) => invoke<PdfPos | null>("tb_synctex_forward_pos", { file, line }),
  synctexReverse: (page: number, x: number, y: number) =>
    invoke<{ file: string; line: number } | null>("tb_synctex_reverse", { page, x, y }),
  aiImageToLatex: (path: string) => invoke<string>("tb_ai_image_to_latex", { path }),
  renameKey: (kind: KeyKind, old: string, newKey: string, skipFile?: string | null) =>
    invoke<RenameKeyResult>("tb_rename_key", { kind, old, new: newKey, skipFile: skipFile ?? null }),
  encodingScan: () => invoke<{ path: string; encoding: "gbk" | "unknown" }[]>("tb_encoding_scan"),
  convertToUtf8: (paths: string[]) =>
    invoke<{ converted: string[]; failed: string[]; backup_dir: string }>("tb_convert_to_utf8", { paths }),
  zoteroStatus: (url?: string | null) => invoke<{ zotero: string; betterbibtex: string }>("tb_zotero_status", { url: url ?? null }),
  zoteroSearch: (query: string, url?: string | null) => invoke<ZoteroItem[]>("tb_zotero_search", { query, url: url ?? null }),
  zoteroAdd: (citekeys: string[], bibFile?: string | null, url?: string | null) =>
    invoke<{ added: string[]; existing: string[]; bib_file: string; created: boolean }>("tb_zotero_add", {
      citekeys,
      bibFile: bibFile ?? null,
      url: url ?? null,
    }),
  aiReview: (file: string, english: boolean) => invoke<ReviewItem[]>("tb_ai_review", { file, english }),
  getUpdateCheck: () => invoke<boolean>("tb_get_update_check"),
  setUpdateCheck: (enabled: boolean) => invoke<void>("tb_set_update_check", { enabled }),
  importDocx: (sourcePath: string) =>
    invoke<{ file: string; preview: string; chars: number }>("tb_import_docx", { sourcePath }),

  // diagnostics
  diagnostics: () => invoke<DiagnosticsBundle>("tb_get_diagnostics"),

  // ai
  aiDiagnose: (issueIndex: number) => invoke<AiDiagnosis>("tb_ai_diagnose", { issueIndex }),
  aiFix: (issueIndex: number, maxRounds?: number, apply?: boolean) =>
    invoke<FixReport>("tb_ai_fix", { issueIndex, maxRounds: maxRounds ?? null, apply: apply ?? true }),
  fixRuleIssue: (issue: Issue, maxRounds?: number, apply?: boolean) =>
    invoke<FixReport>("tb_fix_rule_issue", { issue, maxRounds: maxRounds ?? null, apply: apply ?? true }),
  aiApplyPatch: (file: string, patch: string) =>
    invoke<string>("tb_ai_apply_patch", { file, patch }),
  aiRollback: (backup: string) => invoke<string>("tb_ai_rollback", { backup }),
  aiGetSettings: () => invoke<AiSettings>("tb_ai_get_settings"),
  aiSetSettings: (s: {
    provider: ProviderKind;
    model: string;
    apiKey?: string | null;
    temperature?: number;
    maxTokens?: number;
    timeoutSecs?: number;
    disableThinking?: boolean;
  }) =>
    invoke<void>("tb_ai_set_settings", {
      provider: s.provider,
      model: s.model,
      apiKey: s.apiKey ?? null,
      temperature: s.temperature ?? null,
      maxTokens: s.maxTokens ?? null,
      timeoutSecs: s.timeoutSecs ?? null,
      disableThinking: s.disableThinking ?? null,
    }),
  aiTestConnection: () => invoke<string>("tb_ai_test_connection"),
  aiGenerate: (request: string) => invoke<string>("tb_ai_generate", { request }),

  // rules / bundle
  runCheck: (onlyFile?: string) =>
    invoke<CheckResult>("tb_run_check", { onlyFile: onlyFile ?? null }),
  setRuleEnabled: (id: string, enabled: boolean) =>
    invoke<void>("tb_set_rule_enabled", { id, enabled }),
  ruleStates: () => invoke<RuleState[]>("tb_get_rule_states"),
  bundleStatus: () => invoke<BundleStatus>("tb_get_bundle_status"),
  downloadBundle: () => invoke<string>("tb_download_bundle"),
  setEngine: (preference: string) => invoke<void>("tb_set_engine", { preference }),
  getEngine: () => invoke<string>("tb_get_engine"),
  setTexlivePasses: (passes: number) => invoke<void>("tb_set_texlive_passes", { passes }),
  getTexlivePasses: () => invoke<number>("tb_get_texlive_passes"),
  cjkFonts: () => invoke<{ name: string; available: boolean }[]>("tb_get_cjk_fonts"),
};

/** Subscribe to a `tb://` event; returns an unsubscribe fn. */
export function onEvent<T>(name: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(name, (e) => handler(e.payload as T));
}

export const events = {
  compileProgress: "tb://compile-progress",
  compileDone: "tb://compile-done",
  fileChanged: "tb://file-changed",
  checkDone: "tb://check-done",
  aiStatus: "tb://ai-status",
  bundleProgress: "tb://bundle-progress",
  installProgress: "tb://install-progress",
  updateProgress: "tb://update-progress",
} as const;
