import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Bot, CheckSquare, Cpu, Download, Keyboard, SlidersHorizontal, Wrench } from "lucide-react";
import { api, type AiSettings, type ProviderKind, type RuleState } from "../api";
import { useAiStore } from "../store/aiStore";
import { DEFAULT_EDITOR_PREFS, useUiStore, type SettingsSection, type ThemeId } from "../store/uiStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { dialog, toast } from "../store/feedbackStore";
import { loadFlow, saveFlow } from "../flow";
import { keyCombo, loadKeymap, saveKeymap, comboLabel, type Keymap } from "../store/keymap";
import { customWords } from "../spell";
import { useI18n, useT } from "../i18n";
import * as actions from "../actions";
import Modal from "./ui/Modal";
import Switch from "./ui/Switch";

/** Defensive: ensure provider objects always carry a string base_url
 * (a null/undefined base_url would break the controlled inputs). */
function sanitizeProvider(p: ProviderKind): ProviderKind {
  if (p.kind === "anthropic") return { kind: "anthropic" };
  const base_url = (p as { base_url?: string | null }).base_url ?? "";
  if (p.kind === "ollama") return { kind: "ollama", base_url };
  return { kind: "open_ai_compatible", base_url };
}

const PRESETS: { label: string; p: ProviderKind; m: string }[] = [
  { label: "OpenAI", p: { kind: "open_ai_compatible", base_url: "https://api.openai.com/v1" }, m: "gpt-5.6-luna" },
  { label: "OpenAI Terra", p: { kind: "open_ai_compatible", base_url: "https://api.openai.com/v1" }, m: "gpt-5.6-terra" },
  { label: "DeepSeek", p: { kind: "open_ai_compatible", base_url: "https://api.deepseek.com/v1" }, m: "deepseek-v4-flash" },
  { label: "DeepSeek Pro", p: { kind: "open_ai_compatible", base_url: "https://api.deepseek.com/v1" }, m: "deepseek-v4-pro" },
  { label: "Qwen", p: { kind: "open_ai_compatible", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" }, m: "qwen3.7-plus" },
  { label: "Anthropic", p: { kind: "anthropic" }, m: "claude-sonnet-5" },
  { label: "Anthropic Haiku", p: { kind: "anthropic" }, m: "claude-haiku-4-5" },
  { label: "Ollama", p: { kind: "ollama", base_url: "http://localhost:11434/v1" }, m: "qwen3.5:9b" },
];

const SECTIONS: { id: SettingsSection; icon: typeof Bot; label: string; tint: string }[] = [
  { id: "general", icon: SlidersHorizontal, label: "settings.secGeneral", tint: "tint-gray" },
  { id: "editor", icon: Keyboard, label: "settings.secEditor", tint: "tint-blue" },
  { id: "compile", icon: Cpu, label: "settings.secCompile", tint: "tint-orange" },
  { id: "ai", icon: Bot, label: "settings.secAi", tint: "tint-purple" },
  { id: "rules", icon: CheckSquare, label: "settings.secRules", tint: "tint-green" },
];

const FONT_CHOICES = [
  { label: "Cascadia Code", value: DEFAULT_EDITOR_PREFS.fontFamily },
  { label: "Consolas", value: "Consolas, 'Microsoft YaHei UI', monospace" },
  { label: "JetBrains Mono", value: "'JetBrains Mono', Consolas, 'Microsoft YaHei UI', monospace" },
  { label: "SF Mono", value: "'SF Mono', Menlo, Consolas, 'PingFang SC', monospace" },
  { label: "Sarasa Mono SC", value: "'Sarasa Mono SC', 'Sarasa Term SC', Consolas, monospace" },
];

/** One grouped-inset row: label (+ secondary line) on the left, control right. */
function Row({ label, sub, children, className }: { label: ReactNode; sub?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={`settings-row ${className ?? ""}`}>
      <span className="settings-row-label">
        {label}
        {sub && <span className="settings-row-sub">{sub}</span>}
      </span>
      {children !== undefined && <span className="settings-row-control">{children}</span>}
    </div>
  );
}

function Group({ title, footer, children }: { title?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-block">
      {title && <div className="settings-group-title">{title}</div>}
      <div className="settings-group">{children}</div>
      {footer && <div className="settings-group-footer">{footer}</div>}
    </div>
  );
}

function ShortcutField({ value, onChange }: { value: string; onChange: (combo: string) => void }) {
  const t = useT();
  const [listening, setListening] = useState(false);
  return (
    <input
      className="input shortcut-input"
      value={listening ? t("settings.shortcutListening") : comboLabel(value)}
      readOnly
      onFocus={() => setListening(true)}
      onBlur={() => setListening(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Tab") return;
        e.preventDefault();
        e.stopPropagation();
        const combo = keyCombo(e.nativeEvent);
        // require at least one modifier — a bare letter would swallow typing
        if (combo && combo.includes("+")) {
          onChange(combo);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export default function SettingsModal({ initialSection, onClose }: { initialSection?: SettingsSection; onClose: () => void }) {
  const { saveSettings, testConnection, loadSettings } = useAiStore();
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const setLang = useI18n((s) => s.setLang);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const prefs = useUiStore((s) => s.editorPrefs);
  const setPrefs = useUiStore((s) => s.setEditorPrefs);
  const engine = useWorkspaceStore((s) => s.engine);
  const [section, setSection] = useState<SettingsSection>(initialSection ?? "general");

  // AI form (explicit save)
  const [provider, setProvider] = useState<ProviderKind>({ kind: "open_ai_compatible", base_url: "https://api.openai.com/v1" });
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [disableThinking, setDisableThinking] = useState(false);
  const [aiDirty, setAiDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // instant-apply settings
  const [engineChoice, setEngineChoice] = useState("auto");
  const [passes, setPasses] = useState(2);
  const [autosaveSecs, setAutosaveSecs] = useState<number>(() => Number(localStorage.getItem("tb-autosave-secs") ?? "30"));
  const [keymap, setKeymap] = useState<Keymap>(() => loadKeymap());
  const [updateCheck, setUpdateCheck] = useState(true);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [bundle, setBundle] = useState<{ present: boolean; mb: string; system: boolean } | null>(null);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [ruleStates, setRuleStates] = useState<RuleState[]>([]);
  const [flow, setFlow] = useState(loadFlow());
  const [fonts, setFonts] = useState<{ name: string; available: boolean }[]>([]);

  useEffect(() => {
    void loadSettings()
      .then(() => {
        const s = useAiStore.getState().settings;
        if (s) {
          setProvider(sanitizeProvider(s.provider));
          setModel(s.model ?? "");
          setApiKey(s.api_key ?? "");
          setDisableThinking(s.disable_thinking ?? false);
        }
      })
      .catch((e) => console.error("load settings failed", e));
    void api.getEngine().then(setEngineChoice).catch(() => setEngineChoice("auto"));
    void api.getUpdateCheck().then(setUpdateCheck).catch(() => setUpdateCheck(true));
    void api.getTexlivePasses().then(setPasses).catch(() => setPasses(2));
    void api.ruleStates().then(setRuleStates).catch(() => setRuleStates([]));
    void api.cjkFonts().then(setFonts).catch(() => setFonts([]));
    void useWorkspaceStore.getState().refreshEngine();
    void api
      .bundleStatus()
      .then((b) => setBundle({ present: b.bundle_present, mb: (b.bundle_bytes / 1024 / 1024).toFixed(1), system: b.system_texlive }))
      .catch(() => setBundle(null));
  }, [loadSettings]);

  const editAi = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setAiDirty(true);
    setTestResult(null);
  };

  const saveAi = async () => {
    setSaving(true);
    try {
      const current = useAiStore.getState().settings;
      const s: AiSettings = {
        provider: sanitizeProvider(provider),
        model: model.trim(),
        api_key: apiKey.trim(),
        temperature: current?.temperature ?? 0.2,
        max_tokens: current?.max_tokens ?? 1024,
        timeout_secs: current?.timeout_secs ?? 60,
        disable_thinking: disableThinking,
      };
      await saveSettings(s);
      setAiDirty(false);
      toast.success(t("settings.saved"));
      return true;
    } catch (e) {
      toast.error(t("settings.saveFailed", { e: String(e) }));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (aiDirty && !(await saveAi())) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult({ ok: true, text: await testConnection() });
    } catch (e) {
      setTestResult({ ok: false, text: t("settings.connFailed", { e: String(e) }) });
    }
    setTesting(false);
  };

  const applyKeymap = (next: Keymap) => {
    setKeymap(next);
    saveKeymap(next);
  };

  const presetActive = (p: (typeof PRESETS)[number]) =>
    p.p.kind === provider.kind && p.m === model && ((p.p as { base_url?: string }).base_url ?? "") === ((provider as { base_url?: string }).base_url ?? "");

  const close = async () => {
    if (aiDirty) {
      const discard = await dialog.confirm({
        title: t("settings.unsavedAiTitle"),
        message: t("settings.unsavedAi"),
        confirmLabel: t("settings.discard"),
        danger: true,
      });
      if (!discard) {
        setSection("ai");
        return;
      }
    }
    onClose();
  };

  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <Modal
      title={t("settings.title")}
      onClose={close}
      className="settings-modal"
      onSubmit={aiDirty ? () => void saveAi() : undefined}
      footer={
        <>
          <span className="footer-note">{aiDirty ? t("settings.unsavedAiNote") : t("settings.instantNote")}</span>
          {aiDirty && (
            <button className="btn btn-primary" onClick={() => void saveAi()} disabled={saving}>
              {t("settings.saveAi")}
            </button>
          )}
          <button className="btn" onClick={close}>
            {t("common.done")}
          </button>
        </>
      }
    >
      <nav className="settings-nav" aria-label={t("settings.title")}>
        {SECTIONS.map(({ id, icon: Icon, label, tint }) => (
          <button key={id} className={`settings-nav-item ${section === id ? "active" : ""}`} data-section={id} onClick={() => setSection(id)}>
            <span className={`nav-icon ${tint}`}>
              <Icon size={14} />
            </span>
            {t(label)}
            {id === "ai" && aiDirty && <span className="nav-dot" />}
          </button>
        ))}
      </nav>

      <div className="settings-content">
        <h3 className="settings-section-title">{t(current.label)}</h3>

        {section === "general" && (
          <>
            <Group title={t("theme.title")}>
              <div className="settings-row theme-row">
                <div className="theme-cards">
                  {(["liquid", "dark", "light"] as ThemeId[]).map((id) => (
                    <button key={id} className={`theme-card ${theme === id ? "active" : ""}`} onClick={() => setTheme(id)}>
                      <span className={`theme-card-preview swatch-${id}`} />
                      {t(`theme.${id}`)}
                    </button>
                  ))}
                </div>
              </div>
            </Group>
            <Group>
              <Row label={t("settings.language")}>
                <select className="input compact" value={lang} onChange={(e) => setLang(e.target.value as "zh" | "en")}>
                  <option value="zh">{t("settings.languageZh")}</option>
                  <option value="en">{t("settings.languageEn")}</option>
                </select>
              </Row>
              <Row label={t("settings.restoreSession")}>
                <Switch
                  label={t("settings.restoreSession")}
                  checked={flow.restoreSession}
                  onChange={(v) => {
                    saveFlow({ restoreSession: v });
                    setFlow({ ...flow, restoreSession: v });
                  }}
                />
              </Row>
              <Row label={t("settings.autosaveInterval")}>
                <select
                  className="input compact"
                  value={String(autosaveSecs)}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setAutosaveSecs(v);
                    localStorage.setItem("tb-autosave-secs", String(v));
                  }}
                >
                  <option value="0">{t("settings.autosaveOff")}</option>
                  <option value="10">10 s</option>
                  <option value="30">30 s</option>
                  <option value="60">60 s</option>
                  <option value="120">120 s</option>
                </select>
              </Row>
            </Group>
            <Group title={t("settings.updates")}>
              <Row label={t("settings.updatesCheck")}>
                <Switch
                  label={t("settings.updatesCheck")}
                  checked={updateCheck}
                  onChange={(v) => {
                    setUpdateCheck(v);
                    void api.setUpdateCheck(v).catch(() => undefined);
                  }}
                />
              </Row>
              <Row label={t("settings.version")} sub={`TeXButler ${__APP_VERSION__}`}>
                <button
                  className="btn btn-sm settings-check-updates"
                  disabled={updateChecking}
                  onClick={async () => {
                    setUpdateChecking(true);
                    await actions.checkForUpdates(true);
                    setUpdateChecking(false);
                  }}
                >
                  <Download size={13} /> {updateChecking ? t("settings.updatesChecking") : t("settings.updatesNow")}
                </button>
              </Row>
            </Group>
          </>
        )}

        {section === "editor" && (
          <>
            <Group title={t("settings.editorText")}>
              <Row label={t("settings.fontSize")}>
                <span className="stepper">
                  <button className="btn btn-sm" onClick={() => setPrefs({ fontSize: prefs.fontSize - 1 })} aria-label="-">
                    −
                  </button>
                  <span className="stepper-value">{prefs.fontSize}</span>
                  <button className="btn btn-sm" onClick={() => setPrefs({ fontSize: prefs.fontSize + 1 })} aria-label="+">
                    +
                  </button>
                </span>
              </Row>
              <Row label={t("settings.fontFamily")}>
                <select
                  className="input compact settings-font"
                  value={FONT_CHOICES.some((f) => f.value === prefs.fontFamily) ? prefs.fontFamily : FONT_CHOICES[0].value}
                  onChange={(e) => setPrefs({ fontFamily: e.target.value })}
                >
                  {FONT_CHOICES.map((f) => (
                    <option key={f.label} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label={t("settings.tabSize")}>
                <select className="input compact" value={prefs.tabSize} onChange={(e) => setPrefs({ tabSize: Number(e.target.value) })}>
                  {[2, 4, 8].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label={t("settings.wordWrap")}>
                <Switch label={t("settings.wordWrap")} checked={prefs.wordWrap} onChange={(v) => setPrefs({ wordWrap: v })} />
              </Row>
              <Row label={t("settings.lineNumbers")}>
                <Switch label={t("settings.lineNumbers")} checked={prefs.lineNumbers} onChange={(v) => setPrefs({ lineNumbers: v })} />
              </Row>
              <Row label={t("settings.minimap")}>
                <Switch label={t("settings.minimap")} checked={prefs.minimap} onChange={(v) => setPrefs({ minimap: v })} />
              </Row>
            </Group>
            <Group footer={t("settings.spellcheckNote", { n: customWords().length })}>
              <Row label={t("settings.spellcheck")} sub={t("settings.spellcheckSub")}>
                <Switch
                  className="settings-spell"
                  label={t("settings.spellcheck")}
                  checked={prefs.spellcheck}
                  onChange={(v) => setPrefs({ spellcheck: v })}
                />
              </Row>
            </Group>
            <Group title={t("settings.shortcuts")} footer={t("settings.shortcutHint")}>
              <Row label={t("settings.shortcutCompile")}>
                <ShortcutField value={keymap.compileMain} onChange={(combo) => applyKeymap({ ...keymap, compileMain: combo })} />
              </Row>
              <Row label={t("settings.shortcutCompileCurrent")}>
                <ShortcutField value={keymap.compileCurrent} onChange={(combo) => applyKeymap({ ...keymap, compileCurrent: combo })} />
              </Row>
            </Group>
            <Group title={t("settings.builtinShortcuts")}>
              <div className="settings-row">
                <div className="shortcut-list">
                  {[
                    ["Ctrl+S", "cmd.save"],
                    ["Ctrl+Shift+S", "cmd.saveAll"],
                    ["Ctrl+P", "cmd.quickOpen"],
                    ["Ctrl+Shift+P", "cmd.palette"],
                    ["Ctrl+Shift+F", "cmd.findInProject"],
                    ["Ctrl+N", "cmd.newFile"],
                    ["Ctrl+O", "cmd.openProject"],
                    ["Ctrl+J", "cmd.toggleProblems"],
                    ["Ctrl+Shift+B", "fmt.bold"],
                    ["Ctrl+= / Ctrl+- / Ctrl+0", "settings.zoomKeys"],
                    ["Ctrl+,", "cmd.settings"],
                  ].map(([k, label]) => (
                    <Fragment key={k}>
                      <span>{t(label)}</span>
                      <span>
                        <kbd>{k}</kbd>
                      </span>
                    </Fragment>
                  ))}
                </div>
              </div>
            </Group>
          </>
        )}

        {section === "compile" && (
          <>
            <Group title={t("engine.title")}>
              <Row label="Tectonic" sub={engine?.tectonic ?? t("engine.notFound")}>
                <span className={`pill ${engine?.tectonic ? "ok" : "warn"}`}>{engine?.tectonic ? t("settings.available") : t("settings.unavailable")}</span>
              </Row>
              <Row label={t("engine.system")} sub={engine?.system_engine ? `${engine.system_engine} · ${engine.system_path}` : t("engine.notFound")}>
                <span className={`pill ${engine?.system_engine ? "ok" : "warn"}`}>
                  {engine?.system_engine ? t("settings.available") : t("settings.unavailable")}
                </span>
              </Row>
              <Row label={t("engine.manage")}>
                <button className="btn btn-sm" onClick={() => useUiStore.getState().openModal({ kind: "engine" })}>
                  <Wrench size={13} /> {t("engine.setup")}
                </button>
              </Row>
            </Group>
            <Group>
              <Row label={t("settings.autoCompile")}>
                <Switch
                  label={t("settings.autoCompile")}
                  checked={flow.autoCompile}
                  onChange={(v) => {
                    saveFlow({ autoCompile: v });
                    setFlow({ ...flow, autoCompile: v });
                  }}
                />
              </Row>
              <Row label={t("settings.engineChoice")}>
                <select
                  className="input compact"
                  value={engineChoice}
                  onChange={(e) => {
                    setEngineChoice(e.target.value);
                    void api.setEngine(e.target.value).catch(toast.error);
                  }}
                >
                  <option value="auto">{t("settings.engineAuto")}</option>
                  <option value="tectonic">{t("settings.engineTectonic")}</option>
                  <option value="system_texlive">{t("settings.engineSystem")}</option>
                </select>
              </Row>
              <Row label={t("settings.passes")}>
                <select
                  className="input compact settings-passes"
                  value={passes}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setPasses(v);
                    void api.setTexlivePasses(v).catch(toast.error);
                  }}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {t(`settings.passes${n}`)}
                    </option>
                  ))}
                </select>
              </Row>
            </Group>
            <Group title={t("settings.bundleTitle")}>
              <Row
                label={t("settings.bundle")}
                sub={
                  bundle
                    ? t("settings.bundleStatus", {
                        bundle: bundle.present ? t("settings.bundleReady", { mb: bundle.mb }) : t("settings.bundleMissing"),
                        system: bundle.system ? t("settings.available") : t("settings.unavailable"),
                      })
                    : t("settings.bundleUnknown")
                }
              >
                <button
                  className="btn btn-sm"
                  disabled={bundleBusy}
                  onClick={async () => {
                    setBundleBusy(true);
                    try {
                      const r = await api.downloadBundle();
                      toast.success(r || t("settings.bundleDone"));
                      const b = await api.bundleStatus();
                      setBundle({ present: b.bundle_present, mb: (b.bundle_bytes / 1024 / 1024).toFixed(1), system: b.system_texlive });
                    } catch (e) {
                      toast.error(t("settings.bundleFailed", { e: String(e) }));
                    }
                    setBundleBusy(false);
                  }}
                >
                  {bundleBusy ? t("settings.bundleDownloading") : t("settings.bundleGo")}
                </button>
              </Row>
            </Group>
            <Group title={t("settings.fonts")} footer={t("settings.fontsNote")}>
              <div className="settings-row">
                <div className="font-grid">
                  {fonts.map((f) => (
                    <span key={f.name} className={`font-item ${f.available ? "font-ok" : "font-missing"}`}>
                      {f.available ? "●" : "○"} {f.name}
                    </span>
                  ))}
                </div>
              </div>
            </Group>
          </>
        )}

        {section === "ai" && (
          <>
            <Group title={t("settings.presets")}>
              <div className="settings-row">
                <div className="preset-row">
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      className={`chip ${presetActive(p) ? "active" : ""}`}
                      onClick={() => {
                        editAi(setProvider)(p.p);
                        setModel(p.m);
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </Group>
            <Group footer={t("settings.apiKeyNote")}>
              <Row label={t("settings.providerType")}>
                <select
                  className="input compact"
                  value={provider.kind}
                  onChange={(e) => {
                    const k = e.target.value as ProviderKind["kind"];
                    if (k === "anthropic") editAi(setProvider)({ kind: "anthropic" });
                    else if (k === "ollama") editAi(setProvider)({ kind: "ollama", base_url: "http://localhost:11434/v1" });
                    else editAi(setProvider)({ kind: "open_ai_compatible", base_url: "https://api.openai.com/v1" });
                  }}
                >
                  <option value="open_ai_compatible">{t("settings.providerOpenAi")}</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="ollama">{t("settings.providerOllama")}</option>
                </select>
              </Row>
              <Row label={t("settings.model")}>
                <input className="input compact settings-model" value={model} onChange={(e) => editAi(setModel)(e.target.value)} />
              </Row>
              {provider.kind !== "anthropic" && (
                <Row label={t("settings.baseUrl")}>
                  <input
                    className="input compact settings-wide"
                    value={(provider as { base_url?: string | null }).base_url ?? ""}
                    onChange={(e) => editAi(setProvider)({ ...provider, base_url: e.target.value } as ProviderKind)}
                  />
                </Row>
              )}
              <Row label={t("settings.apiKey")} sub={provider.kind === "ollama" ? t("settings.apiKeyHint") : undefined}>
                <input
                  className="input compact settings-wide"
                  type="password"
                  value={apiKey}
                  placeholder="sk-..."
                  autoComplete="off"
                  onChange={(e) => editAi(setApiKey)(e.target.value)}
                />
              </Row>
              {provider.kind === "open_ai_compatible" && (
                <Row label={t("settings.thinkingShort")} sub={t("settings.thinking")}>
                  <Switch label={t("settings.thinkingShort")} checked={disableThinking} onChange={(v) => editAi(setDisableThinking)(v)} />
                </Row>
              )}
              <Row label={t("settings.test")} sub={testResult ? <span className={`test-result ${testResult.ok ? "ok" : "fail"}`}>{testResult.text}</span> : undefined}>
                <button className="btn btn-sm" onClick={() => void test()} disabled={testing}>
                  {testing ? t("settings.testing") : aiDirty ? t("settings.saveAndTest") : t("settings.test")}
                </button>
              </Row>
            </Group>
          </>
        )}

        {section === "rules" && (
          <Group footer={t("settings.rulesTitle")}>
            {ruleStates.map((r) => (
              <Row key={r.id} label={r.name}>
                <Switch
                  label={r.name}
                  checked={r.enabled}
                  onChange={(next) => {
                    setRuleStates((prev) => prev.map((x) => (x.id === r.id ? { ...x, enabled: next } : x)));
                    void api.setRuleEnabled(r.id, next).catch(toast.error);
                  }}
                />
              </Row>
            ))}
          </Group>
        )}
      </div>
    </Modal>
  );
}
