import { useEffect, useState } from "react";
import { api, type AiSettings, type ProviderKind, type RuleState } from "../api";
import { useAiStore } from "../store/aiStore";
import { loadFlow, saveFlow } from "../flow";
import { keyCombo, loadKeymap, saveKeymap, comboLabel, type Keymap } from "../store/keymap";
import { useI18n, useT } from "../i18n";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Defensive: ensure provider objects always carry a string base_url
 * (a null/undefined base_url would break the controlled inputs). */
function sanitizeProvider(p: ProviderKind): ProviderKind {
  if (p.kind === "anthropic") return { kind: "anthropic" };
  const base_url = (p as { base_url?: string | null }).base_url ?? "";
  if (p.kind === "ollama") return { kind: "ollama", base_url };
  return { kind: "open_ai_compatible", base_url };
}

export default function SettingsModal({ open, onClose }: Props) {
  const { settings, saveSettings, testConnection, loadSettings } = useAiStore();
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const setLang = useI18n((s) => s.setLang);
  const [provider, setProvider] = useState<ProviderKind>({
    kind: "open_ai_compatible",
    base_url: "https://api.openai.com/v1",
  });
  const [model, setModel] = useState("gpt-4o-mini");
  const [apiKey, setApiKey] = useState("");
  const [disableThinking, setDisableThinking] = useState(false);
  const [engine, setEngine] = useState("auto");
  const [autosaveSecs, setAutosaveSecs] = useState<number>(() =>
    Number(localStorage.getItem("tb-autosave-secs") ?? "30"),
  );
  const [keymap, setKeymap] = useState<Keymap>(() => loadKeymap());
  const [updateCheck, setUpdateCheck] = useState(true);
  const [updateInfo, setUpdateInfo] = useState<{ version: string; name: string; body: string; url: string } | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [passes, setPasses] = useState(2);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [bundleStatus, setBundleStatus] = useState<string>("");
  const [ruleStates, setRuleStates] = useState<RuleState[]>([]);
  const [flow, setFlow] = useState(loadFlow());
  const [fonts, setFonts] = useState<{ name: string; available: boolean }[]>([]);

  useEffect(() => {
    if (!open) return;
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
      .then((b) => {
        const mb = (b.bundle_bytes / 1024 / 1024).toFixed(1);
        setBundleStatus(
          `Tectonic bundle: ${b.bundle_present ? `已就绪 (${mb} MB)` : "未就绪（编译时按需下载）"}；系统 TeX: ${b.system_texlive ? "可用" : "不可用"}`
        );
      })
      .catch(() => setBundleStatus("bundle 状态查询失败"));
  }, [open, loadSettings]);

  if (!open) return null;

  const presets: { label: string; p: ProviderKind; m: string }[] = [
    // 2026-08 最新模型（来源：各 provider 官方文档）
    { label: "OpenAI", p: { kind: "open_ai_compatible", base_url: "https://api.openai.com/v1" }, m: "gpt-5.6-luna" },
    { label: "OpenAI Terra", p: { kind: "open_ai_compatible", base_url: "https://api.openai.com/v1" }, m: "gpt-5.6-terra" },
    { label: "DeepSeek", p: { kind: "open_ai_compatible", base_url: "https://api.deepseek.com/v1" }, m: "deepseek-v4-flash" },
    { label: "DeepSeek Pro", p: { kind: "open_ai_compatible", base_url: "https://api.deepseek.com/v1" }, m: "deepseek-v4-pro" },
    { label: "通义千问", p: { kind: "open_ai_compatible", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" }, m: "qwen3.7-plus" },
    { label: "Anthropic", p: { kind: "anthropic" }, m: "claude-sonnet-5" },
    { label: "Anthropic 快", p: { kind: "anthropic" }, m: "claude-haiku-4-5" },
    { label: "Ollama (本地)", p: { kind: "ollama", base_url: "http://localhost:11434/v1" }, m: "qwen3.5:9b" },
  ];

  const applyPreset = (label: string) => {
    const found = presets.find((x) => x.label === label);
    if (found) {
      setProvider(found.p);
      setModel(found.m);
    }
  };

  const save = async () => {
    try {
      const s: AiSettings = {
        provider: sanitizeProvider(provider),
        model,
        api_key: apiKey,
        temperature: settings?.temperature ?? 0.2,
        max_tokens: settings?.max_tokens ?? 1024,
        timeout_secs: settings?.timeout_secs ?? 60,
        disable_thinking: disableThinking,
      };
      await saveSettings(s);
      await api.setEngine(engine);
      await api.setTexlivePasses(passes);
      saveKeymap(keymap);
      window.alert(t("settings.saved"));
    } catch (e) {
      console.error("save settings failed", e);
      window.alert(t("settings.saveFailed", { e: String(e) }));
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testConnection();
      setTestResult(r);
    } catch (e) {
      console.error("test connection failed", e);
      setTestResult(t("settings.connFailed", { e: String(e) }));
    }
    setTesting(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t("settings.title")}</span>
          <span className="panel-actions">
            <select
              className="snippet-select"
              value={lang}
              onChange={(e) => setLang(e.target.value as "zh" | "en")}
              title={t("settings.language")}
            >
              <option value="zh">{t("settings.languageZh")}</option>
              <option value="en">{t("settings.languageEn")}</option>
            </select>
            <button className="btn-mini" onClick={onClose}>
              ×
            </button>
          </span>
        </div>
        <div className="modal-body">
          <h4>{t("settings.aiProvider")}</h4>
          <div className="preset-row">
            {presets.map((p) => (
              <button key={p.label} className="btn-mini" onClick={() => applyPreset(p.label)}>
                {p.label}
              </button>
            ))}
          </div>
          <label>
            {t("settings.providerType")}
            <select
              value={provider.kind}
              onChange={(e) => {
                const k = e.target.value as ProviderKind["kind"];
                if (k === "anthropic") setProvider({ kind: "anthropic" });
                else if (k === "ollama")
                  setProvider({ kind: "ollama", base_url: "http://localhost:11434/v1" });
                else setProvider({ kind: "open_ai_compatible", base_url: "https://api.openai.com/v1" });
              }}
            >
              <option value="open_ai_compatible">OpenAI 兼容（OpenAI/DeepSeek/Qwen）</option>
              <option value="anthropic">Anthropic</option>
              <option value="ollama">Ollama（本地，OpenAI 兼容端点）</option>
            </select>
          </label>
          {provider.kind !== "anthropic" && (
            <label>
              {t("settings.baseUrl")}
              <input
                value={(provider as { base_url?: string | null }).base_url ?? ""}
                onChange={(e) =>
                  setProvider({ ...provider, base_url: e.target.value } as ProviderKind)
                }
              />
            </label>
          )}
          <label>
            {t("settings.model")}
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          <label>
            {t("settings.apiKey")}{provider.kind === "ollama" && <small>{t("settings.apiKeyHint")}</small>}
            <input
              type="password"
              value={apiKey}
              placeholder="sk-..."
              onChange={(e) => setApiKey(e.target.value)}
            />
            <small>{t("settings.apiKeyNote")}</small>
          </label>
          {provider.kind === "open_ai_compatible" && (
            <label className="rule-toggle">
              <input
                type="checkbox"
                checked={disableThinking}
                onChange={(e) => setDisableThinking(e.target.checked)}
              />
              <span>{t("settings.thinking")}</span>
            </label>
          )}
          <div className="modal-actions">
            <button className="btn-mini" onClick={test} disabled={testing}>
              {testing ? t("settings.testing") : t("settings.test")}
            </button>
            {testResult && <span className="test-result">{testResult}</span>}
          </div>

          <h4>{t("settings.flow")}</h4>
          <div className="rule-toggles">
            <label className="rule-toggle">
              <input
                type="checkbox"
                checked={flow.autoCompile}
                onChange={(e) => {
                  saveFlow({ autoCompile: e.target.checked });
                  setFlow({ ...flow, autoCompile: e.target.checked });
                }}
              />
              <span>{t("settings.autoCompile")}</span>
            </label>
            <label className="rule-toggle">
              <input
                type="checkbox"
                checked={flow.restoreSession}
                onChange={(e) => {
                  saveFlow({ restoreSession: e.target.checked });
                  setFlow({ ...flow, restoreSession: e.target.checked });
                }}
              />
              <span>{t("settings.restoreSession")}</span>
            </label>
          </div>

          <h4>{t("settings.rulesTitle")}</h4>
          <div className="rule-toggles">
            {ruleStates.map((r) => (
              <label key={r.id} className="rule-toggle">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={async (e) => {
                    const next = e.target.checked;
                    setRuleStates((prev) =>
                      prev.map((x) => (x.id === r.id ? { ...x, enabled: next } : x))
                    );
                    await api.setRuleEnabled(r.id, next).catch(() => undefined);
                  }}
                />
                <span>{r.name}</span>
              </label>
            ))}
          </div>

          <h4>{t("settings.engine")}</h4>
          <label>
            {t("settings.engineChoice")}
            <select
              value={engine}
              onChange={(e) => setEngine(e.target.value)}
            >
              <option value="auto">{t("settings.engineAuto")}</option>
              <option value="tectonic">{t("settings.engineTectonic")}</option>
              <option value="system_texlive">{t("settings.engineSystem")}</option>            </select>
          </label>

          <h4>{t("settings.autosave")}</h4>
          <label>
            {t("settings.autosaveInterval")}
            <select
              value={String(autosaveSecs)}
              onChange={(e) => {
                const v = Number(e.target.value);
                setAutosaveSecs(v);
                localStorage.setItem("tb-autosave-secs", String(v));
              }}
            >
              <option value="0">{t("settings.autosaveOff")}</option>
              <option value="30">30s</option>
              <option value="60">60s</option>
              <option value="120">120s</option>
            </select>
          </label>

          <h4>{t("settings.shortcuts")}</h4>
          <label>
            {t("settings.shortcutCompile")}
            <input
              className="shortcut-input"
              value={comboLabel(keymap.compileMain)}
              readOnly
              onKeyDown={(e) => {
                e.preventDefault();
                const combo = keyCombo(e.nativeEvent);
                if (combo) setKeymap((k) => ({ ...k, compileMain: combo }));
              }}
            />
          </label>
          <label>
            {t("settings.shortcutCompileCurrent")}
            <input
              className="shortcut-input"
              value={comboLabel(keymap.compileCurrent)}
              readOnly
              onKeyDown={(e) => {
                e.preventDefault();
                const combo = keyCombo(e.nativeEvent);
                if (combo) setKeymap((k) => ({ ...k, compileCurrent: combo }));
              }}
            />
          </label>
          <p className="settings-hint">{t("settings.shortcutHint")}</p>
          <label>
            {t("settings.passes")}
            <select
              value={passes}
              onChange={(e) => setPasses(Number(e.target.value))}
            >
              <option value={1}>{t("settings.passes1")}</option>
              <option value={2}>{t("settings.passes2")}</option>
              <option value={3}>{t("settings.passes3")}</option>
              <option value={4}>{t("settings.passes4")}</option>
              <option value={5}>{t("settings.passes5")}</option>
            </select>
          </label>
          <p className="bundle-status">{bundleStatus}</p>

          <h4>{t("settings.updates")}</h4>
          <label className="row">
            <input
              type="checkbox"
              checked={updateCheck}
              onChange={async (e) => {
                const v = e.target.checked;
                setUpdateCheck(v);
                await api.setUpdateCheck(v).catch(() => undefined);
              }}
            />
            {t("settings.updatesCheck")}
          </label>
          <div className="path-row">
            <button
              className="btn-mini"
              disabled={updateChecking}
              onClick={async () => {
                setUpdateChecking(true);
                try {
                  const info = await api.checkUpdates();
                  setUpdateInfo(info);
                } catch {
                  setUpdateInfo(null);
                }
                setUpdateChecking(false);
              }}
            >
              {updateChecking ? t("settings.updatesChecking") : t("settings.updatesNow")}
            </button>
            {updateInfo && (
              <a className="btn-mini btn-primary" href={updateInfo.url} target="_blank" rel="noreferrer">
                {t("settings.updatesGo", { v: updateInfo.version })}
              </a>
            )}
          </div>
          {updateInfo && (
            <p className="bundle-status">
              <strong>{updateInfo.name}</strong>
              <br />
              {updateInfo.body.slice(0, 600)}
            </p>
          )}
          {updateInfo === null && !updateChecking && (
            <p className="bundle-status">{t("settings.updatesNone")}</p>
          )}

          <div className="modal-actions">
            <button
              className="btn-mini"
              onClick={async () => {
                const r = await api.downloadBundle().catch((e) => `下载失败: ${String(e)}`);
                window.alert(typeof r === "string" ? r : "完成");
              }}
            >
              {t("settings.bundle")}
            </button>
          </div>

          <h4>{t("settings.fonts")}</h4>
          <div className="font-grid">
            {fonts.map((f) => (
              <span key={f.name} className={`font-item ${f.available ? "font-ok" : "font-missing"}`}>
                {f.available ? "●" : "○"} {f.name}
              </span>
            ))}
          </div>
          <small>{t("settings.fontsNote")}</small>
        </div>
        <div className="modal-footer">
          <button className="btn-mini" onClick={onClose}>
            {t("settings.cancel")}
          </button>
          <button className="btn-mini btn-primary" onClick={() => void save()}>
            {t("settings.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
