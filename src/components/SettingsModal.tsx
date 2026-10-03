import { Fragment, useEffect, useState } from "react";
import { Bot, CheckSquare, Cpu, Keyboard, SlidersHorizontal } from "lucide-react";
import { api, type AiSettings, type ProviderKind, type RuleState } from "../api";
import { useAiStore } from "../store/aiStore";
import { useUiStore, type SettingsSection, type ThemeId } from "../store/uiStore";
import { dialog, toast } from "../store/feedbackStore";
import { loadFlow, saveFlow } from "../flow";
import { keyCombo, loadKeymap, saveKeymap, comboLabel, type Keymap } from "../store/keymap";
import { useI18n, useT } from "../i18n";
import Modal from "./ui/Modal";

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

const SECTIONS: { id: SettingsSection; icon: typeof Bot; label: string }[] = [
  { id: "general", icon: SlidersHorizontal, label: "settings.secGeneral" },
  { id: "editor", icon: Keyboard, label: "settings.secEditor" },
  { id: "compile", icon: Cpu, label: "settings.secCompile" },
  { id: "ai", icon: Bot, label: "settings.secAi" },
  { id: "rules", icon: CheckSquare, label: "settings.secRules" },
];

function ShortcutField({ label, value, onChange }: { label: string; value: string; onChange: (combo: string) => void }) {
  const t = useT();
  const [listening, setListening] = useState(false);
  return (
    <div className="field">
      <span className="field-label">{label}</span>
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
          // require at least one modifier — a bare letter would swallow
          // typing in the editor
          if (combo && combo.includes("+")) {
            onChange(combo);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}

export default function SettingsModal({ initialSection, onClose }: { initialSection?: SettingsSection; onClose: () => void }) {
  const { saveSettings, testConnection, loadSettings } = useAiStore();
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const setLang = useI18n((s) => s.setLang);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
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
  const [engine, setEngine] = useState("auto");
  const [passes, setPasses] = useState(2);
  const [autosaveSecs, setAutosaveSecs] = useState<number>(() => Number(localStorage.getItem("tb-autosave-secs") ?? "30"));
  const [keymap, setKeymap] = useState<Keymap>(() => loadKeymap());
  const [updateCheck, setUpdateCheck] = useState(true);
  const [updateInfo, setUpdateInfo] = useState<{ version: string; name: string; body: string; url: string } | null | undefined>(undefined);
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
    void api.getEngine().then(setEngine).catch(() => setEngine("auto"));
    void api.getUpdateCheck().then(setUpdateCheck).catch(() => setUpdateCheck(true));
    void api.getTexlivePasses().then(setPasses).catch(() => setPasses(2));
    void api.ruleStates().then(setRuleStates).catch(() => setRuleStates([]));
    void api.cjkFonts().then(setFonts).catch(() => setFonts([]));
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
    // test what the form shows, not the previously stored config
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
      // never drop unsaved AI provider changes silently
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
        {SECTIONS.map(({ id, icon: Icon, label }) => (
          <button key={id} className={`settings-nav-item ${section === id ? "active" : ""}`} onClick={() => setSection(id)}>
            <Icon size={15} /> {t(label)}
            {id === "ai" && aiDirty && <span className="count-badge warn">•</span>}
          </button>
        ))}
      </nav>

      <div className="settings-content">
        {section === "general" && (
          <>
            <h3 className="settings-section-title">{t("settings.secGeneral")}</h3>
            <div className="settings-card">
              <h4>{t("theme.title")}</h4>
              <div className="theme-cards">
                {(["liquid", "dark", "light"] as ThemeId[]).map((id) => (
                  <button key={id} className={`theme-card ${theme === id ? "active" : ""}`} onClick={() => setTheme(id)}>
                    <span className={`theme-card-preview swatch-${id}`} />
                    {t(`theme.${id}`)}
                  </button>
                ))}
              </div>
              <label className="field">
                <span className="field-label">{t("settings.language")}</span>
                <select className="input" value={lang} onChange={(e) => setLang(e.target.value as "zh" | "en")}>
                  <option value="zh">{t("settings.languageZh")}</option>
                  <option value="en">{t("settings.languageEn")}</option>
                </select>
              </label>
            </div>
            <div className="settings-card">
              <h4>{t("settings.flow")}</h4>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={flow.restoreSession}
                  onChange={(e) => {
                    saveFlow({ restoreSession: e.target.checked });
                    setFlow({ ...flow, restoreSession: e.target.checked });
                  }}
                />
                {t("settings.restoreSession")}
              </label>
              <label className="field">
                <span className="field-label">{t("settings.autosaveInterval")}</span>
                <select
                  className="input"
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
              </label>
            </div>
            <div className="settings-card">
              <h4>{t("settings.updates")}</h4>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={updateCheck}
                  onChange={(e) => {
                    const v = e.target.checked;
                    setUpdateCheck(v);
                    void api.setUpdateCheck(v).catch(() => undefined);
                  }}
                />
                {t("settings.updatesCheck")}
              </label>
              <div className="modal-actions">
                <button
                  className="btn btn-sm"
                  disabled={updateChecking}
                  onClick={async () => {
                    setUpdateChecking(true);
                    try {
                      setUpdateInfo(await api.checkUpdates());
                    } catch (e) {
                      setUpdateInfo(undefined);
                      toast.error(e);
                    }
                    setUpdateChecking(false);
                  }}
                >
                  {updateChecking ? t("settings.updatesChecking") : t("settings.updatesNow")}
                </button>
                {updateInfo && (
                  <a className="btn btn-sm btn-primary" href={updateInfo.url} target="_blank" rel="noreferrer">
                    {t("settings.updatesGo", { v: updateInfo.version })}
                  </a>
                )}
                {updateInfo === null && <span className="settings-hint">{t("settings.updatesNone")}</span>}
              </div>
              {updateInfo && (
                <p className="bundle-status">
                  <strong>{updateInfo.name}</strong>
                  <br />
                  {updateInfo.body.slice(0, 600)}
                </p>
              )}
            </div>
          </>
        )}

        {section === "editor" && (
          <>
            <h3 className="settings-section-title">{t("settings.secEditor")}</h3>
            <div className="settings-card">
              <h4>{t("settings.shortcuts")}</h4>
              <div className="field-grid">
                <ShortcutField
                  label={t("settings.shortcutCompile")}
                  value={keymap.compileMain}
                  onChange={(combo) => applyKeymap({ ...keymap, compileMain: combo })}
                />
                <ShortcutField
                  label={t("settings.shortcutCompileCurrent")}
                  value={keymap.compileCurrent}
                  onChange={(combo) => applyKeymap({ ...keymap, compileCurrent: combo })}
                />
              </div>
              <p className="settings-hint">{t("settings.shortcutHint")}</p>
            </div>
            <div className="settings-card">
              <h4>{t("settings.builtinShortcuts")}</h4>
              <div className="shortcut-list" style={{ justifyContent: "start" }}>
                {[
                  ["Ctrl+S", "cmd.save"],
                  ["Ctrl+Shift+S", "cmd.saveAll"],
                  ["Ctrl+P", "cmd.quickOpen"],
                  ["Ctrl+Shift+P", "cmd.palette"],
                  ["Ctrl+N", "cmd.newFile"],
                  ["Ctrl+O", "cmd.openProject"],
                  ["Ctrl+J", "cmd.toggleProblems"],
                  ["Ctrl+Shift+B", "fmt.bold"],
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
          </>
        )}

        {section === "compile" && (
          <>
            <h3 className="settings-section-title">{t("settings.secCompile")}</h3>
            <div className="settings-card">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={flow.autoCompile}
                  onChange={(e) => {
                    saveFlow({ autoCompile: e.target.checked });
                    setFlow({ ...flow, autoCompile: e.target.checked });
                  }}
                />
                {t("settings.autoCompile")}
              </label>
              <div className="field-grid">
                <label className="field">
                  <span className="field-label">{t("settings.engineChoice")}</span>
                  <select
                    className="input"
                    value={engine}
                    onChange={(e) => {
                      setEngine(e.target.value);
                      void api.setEngine(e.target.value).catch(toast.error);
                    }}
                  >
                    <option value="auto">{t("settings.engineAuto")}</option>
                    <option value="tectonic">{t("settings.engineTectonic")}</option>
                    <option value="system_texlive">{t("settings.engineSystem")}</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">{t("settings.passes")}</span>
                  <select
                    className="input"
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
                </label>
              </div>
            </div>
            <div className="settings-card">
              <h4>{t("settings.bundleTitle")}</h4>
              <p className="bundle-status">
                {bundle
                  ? t("settings.bundleStatus", {
                      bundle: bundle.present ? t("settings.bundleReady", { mb: bundle.mb }) : t("settings.bundleMissing"),
                      system: bundle.system ? t("settings.available") : t("settings.unavailable"),
                    })
                  : t("settings.bundleUnknown")}
              </p>
              <div className="modal-actions">
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
                  {bundleBusy ? t("settings.bundleDownloading") : t("settings.bundle")}
                </button>
              </div>
            </div>
            <div className="settings-card">
              <h4>{t("settings.fonts")}</h4>
              <div className="font-grid">
                {fonts.map((f) => (
                  <span key={f.name} className={`font-item ${f.available ? "font-ok" : "font-missing"}`}>
                    {f.available ? "●" : "○"} {f.name}
                  </span>
                ))}
              </div>
              <p className="settings-hint">{t("settings.fontsNote")}</p>
            </div>
          </>
        )}

        {section === "ai" && (
          <>
            <h3 className="settings-section-title">{t("settings.secAi")}</h3>
            <div className="settings-card">
              <h4>{t("settings.presets")}</h4>
              <div className="preset-row">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    className={`btn-mini ${presetActive(p) ? "active" : ""}`}
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
            <div className="settings-card">
              <div className="field-grid">
                <label className="field">
                  <span className="field-label">{t("settings.providerType")}</span>
                  <select
                    className="input"
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
                </label>
                <label className="field">
                  <span className="field-label">{t("settings.model")}</span>
                  <input className="input" value={model} onChange={(e) => editAi(setModel)(e.target.value)} />
                </label>
              </div>
              {provider.kind !== "anthropic" && (
                <label className="field">
                  <span className="field-label">{t("settings.baseUrl")}</span>
                  <input
                    className="input"
                    value={(provider as { base_url?: string | null }).base_url ?? ""}
                    onChange={(e) => editAi(setProvider)({ ...provider, base_url: e.target.value } as ProviderKind)}
                  />
                </label>
              )}
              <label className="field">
                <span className="field-label">
                  {t("settings.apiKey")}
                  {provider.kind === "ollama" && <small> {t("settings.apiKeyHint")}</small>}
                </span>
                <input
                  className="input"
                  type="password"
                  value={apiKey}
                  placeholder="sk-..."
                  autoComplete="off"
                  onChange={(e) => editAi(setApiKey)(e.target.value)}
                />
                <span className="field-hint">{t("settings.apiKeyNote")}</span>
              </label>
              {provider.kind === "open_ai_compatible" && (
                <label className="check-row">
                  <input type="checkbox" checked={disableThinking} onChange={(e) => editAi(setDisableThinking)(e.target.checked)} />
                  {t("settings.thinking")}
                </label>
              )}
              <div className="modal-actions">
                <button className="btn btn-sm" onClick={() => void test()} disabled={testing}>
                  {testing ? t("settings.testing") : aiDirty ? t("settings.saveAndTest") : t("settings.test")}
                </button>
                {testResult && <span className={`test-result ${testResult.ok ? "ok" : "fail"}`}>{testResult.text}</span>}
              </div>
            </div>
          </>
        )}

        {section === "rules" && (
          <>
            <h3 className="settings-section-title">{t("settings.secRules")}</h3>
            <div className="settings-card">
              <p className="settings-hint">{t("settings.rulesTitle")}</p>
              <div className="rule-toggles">
                {ruleStates.map((r) => (
                  <label key={r.id} className="rule-toggle">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setRuleStates((prev) => prev.map((x) => (x.id === r.id ? { ...x, enabled: next } : x)));
                        void api.setRuleEnabled(r.id, next).catch(toast.error);
                      }}
                    />
                    <span>{r.name}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
