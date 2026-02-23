import { useState, useMemo, useCallback } from "react";
import {
  X, Key, Bot, Sliders, Shield, Save, Eye, EyeOff,
  ExternalLink, Check, Search, Zap, Globe, AlertTriangle,
  Loader2, XCircle, CheckCircle2,
} from "lucide-react";
import { BotConfig } from "../types";
import type { AIProviderType, AIModelDef, AIProviderDef } from "../services/aiProviders";
import { AI_PROVIDERS, getProvider, estimateCycleCost } from "../services/aiProviders";
import { testApiKey } from "../services/aiService";
import { useTranslation } from "../i18n";

interface SettingsPanelProps {
  config: BotConfig;
  onSave: (config: BotConfig) => void;
  onClose: () => void;
}

export default function SettingsPanel({
  config,
  onSave,
  onClose,
}: SettingsPanelProps) {
  const [form, setForm] = useState<BotConfig>({ ...config });
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<"keys" | "trading" | "ai">("keys");
  const [expandedProvider, setExpandedProvider] = useState<AIProviderType | null>(null);
  const { t } = useTranslation();

  // ─── API Key Test State ──────────────────────────
  const [keyTestStatus, setKeyTestStatus] = useState<
    Record<string, "idle" | "testing" | "valid" | "invalid">
  >({});
  const [keyTestMessage, setKeyTestMessage] = useState<Record<string, string>>({});
  // Track which keys have been validated (to prevent saving unverified keys)
  const [validatedKeys, setValidatedKeys] = useState<Record<string, string>>({});
  // Track pending (not yet tested) key edits — initialized from existing config
  const [pendingKeys, setPendingKeys] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    AI_PROVIDERS.forEach((p) => {
      const key = config.ai_api_keys?.[p.id] || (p.id === "anthropic" ? config.claude_api_key : "") || "";
      if (key) initial[p.id] = key;
    });
    return initial;
  });

  const toggleShow = (field: string) => {
    setShowKeys((prev) => ({ ...prev, [field]: !prev[field] }));
  };

  const updateField = (field: keyof BotConfig, value: any) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const updateApiKey = (provider: AIProviderType, key: string) => {
    // Store in pending — won't be saved until validated
    setPendingKeys((prev) => ({ ...prev, [provider]: key }));
    // Reset test status when user edits the key
    setKeyTestStatus((prev) => ({ ...prev, [provider]: "idle" }));
    setKeyTestMessage((prev) => ({ ...prev, [provider]: "" }));
  };

  const runApiKeyTest = useCallback(async (provider: AIProviderType) => {
    const key = pendingKeys[provider];
    if (!key || key.trim().length < 5) {
      setKeyTestStatus((prev) => ({ ...prev, [provider]: "invalid" }));
      setKeyTestMessage((prev) => ({ ...prev, [provider]: "API key vacía o muy corta" }));
      return;
    }

    setKeyTestStatus((prev) => ({ ...prev, [provider]: "testing" }));
    setKeyTestMessage((prev) => ({ ...prev, [provider]: "Verificando..." }));

    const result = await testApiKey(provider, key);

    if (result.valid) {
      setKeyTestStatus((prev) => ({ ...prev, [provider]: "valid" }));
      setKeyTestMessage((prev) => ({ ...prev, [provider]: result.message }));
      // Mark as validated — now it can be saved
      setValidatedKeys((prev) => ({ ...prev, [provider]: key }));
      // Actually commit the key to the form
      setForm((prev) => ({
        ...prev,
        ai_api_keys: { ...prev.ai_api_keys, [provider]: key },
        ...(provider === "anthropic" ? { claude_api_key: key } : {}),
      }));
    } else {
      setKeyTestStatus((prev) => ({ ...prev, [provider]: "invalid" }));
      setKeyTestMessage((prev) => ({ ...prev, [provider]: result.message }));
    }
  }, [pendingKeys]);

  const selectProvider = (provider: AIProviderType) => {
    const providerDef = getProvider(provider);
    const firstModel = providerDef.models[0];
    setForm((prev) => ({
      ...prev,
      ai_provider: provider,
      ai_model: firstModel?.id || prev.ai_model,
      // Keep legacy field in sync
      ...(provider === "anthropic" ? { claude_model: firstModel?.id || prev.claude_model } : {}),
    }));
  };

  const selectModel = (modelId: string) => {
    setForm((prev) => ({
      ...prev,
      ai_model: modelId,
      // Keep legacy field in sync
      ...(prev.ai_provider === "anthropic" ? { claude_model: modelId } : {}),
    }));
  };

  const handleSave = () => {
    onSave(form);
  };

  // Active provider definition
  const activeProviderDef = useMemo(
    () => getProvider(form.ai_provider || "anthropic"),
    [form.ai_provider],
  );

  // Count configured API keys
  // Count configured API keys (only those actually saved in form)
  const configuredKeys = useMemo(() => {
    return AI_PROVIDERS.filter((p) => {
      const key =
        form.ai_api_keys?.[p.id] ||
        (p.id === "anthropic" ? form.claude_api_key : "");
      return key && key.length > 5;
    }).length;
  }, [form.ai_api_keys, form.claude_api_key]);

  const tabs = [
    { id: "keys" as const, label: t("settings.tabKeys"), icon: Key, badge: `${configuredKeys}/5` },
    { id: "trading" as const, label: t("settings.tabTrading"), icon: Sliders, badge: undefined },
    { id: "ai" as const, label: t("settings.tabAI"), icon: Bot, badge: undefined },
  ];

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50">
      <div className="glass-card rounded-2xl w-[680px] max-h-[85vh] flex flex-col shadow-card-hover border border-bot-border/30">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-bot-border/20">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-bot-cyan" />
            <span className="text-lg font-display font-bold text-white tracking-wide">
              {t("settings.title")}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-bot-muted hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-bot-border/20">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-display font-medium transition-colors border-b-2 ${
                activeTab === tab.id
                  ? "border-bot-cyan text-bot-cyan"
                  : "border-transparent text-bot-muted/50 hover:text-white"
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
              {tab.badge && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bot-surface/60 text-bot-muted/60">
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 custom-scrollbar">
          {/* ═══════════════════════════════════════════════ */}
          {/* TAB: API KEYS                                  */}
          {/* ═══════════════════════════════════════════════ */}
          {activeTab === "keys" && (
            <>
              {/* Polymarket CLOB Section */}
              <SectionTitle
                title={t("settings.polymarketCLOB")}
                subtitle={t("settings.polymarketSubtitle")}
              />
              <SecretInput
                label={t("settings.apiKey")}
                value={form.polymarket_api_key}
                onChange={(v) => updateField("polymarket_api_key", v)}
                show={showKeys["poly_key"]}
                onToggle={() => toggleShow("poly_key")}
                placeholder={t("settings.apiKeyPlaceholder")}
              />
              <SecretInput
                label={t("settings.apiSecret")}
                value={form.polymarket_secret}
                onChange={(v) => updateField("polymarket_secret", v)}
                show={showKeys["poly_secret"]}
                onToggle={() => toggleShow("poly_secret")}
                placeholder={t("settings.apiSecretPlaceholder")}
              />
              <SecretInput
                label={t("settings.passphrase")}
                value={form.polymarket_passphrase}
                onChange={(v) => updateField("polymarket_passphrase", v)}
                show={showKeys["poly_pass"]}
                onToggle={() => toggleShow("poly_pass")}
                placeholder={t("settings.passphrasePlaceholder")}
              />

              {/* AI Providers Section */}
              <div className="border-t border-bot-border/20 pt-5">
                <SectionTitle
                  title="Proveedores de IA"
                  subtitle="Configura las API keys de cada proveedor de inteligencia artificial"
                />
                <div className="space-y-2 mt-3">
                  {AI_PROVIDERS.map((provider) => {
                    const savedKey =
                      form.ai_api_keys?.[provider.id] ||
                      (provider.id === "anthropic" ? form.claude_api_key : "") ||
                      "";
                    const displayKey = pendingKeys[provider.id] ?? savedKey;
                    const isConfigured = savedKey.length > 5;
                    const isExpanded = expandedProvider === provider.id;
                    const isActive = form.ai_provider === provider.id;
                    const testStatus = keyTestStatus[provider.id] || "idle";
                    const testMsg = keyTestMessage[provider.id] || "";

                    return (
                      <div
                        key={provider.id}
                        className={`rounded-xl border transition-all duration-200 overflow-hidden ${
                          isActive
                            ? "border-bot-cyan/40 bg-bot-cyan/5"
                            : isExpanded
                              ? "border-bot-border/40 bg-bot-surface/40"
                              : "border-bot-border/20 bg-bot-surface/20 hover:border-bot-border/40"
                        }`}
                      >
                        {/* Provider Header (clickable) */}
                        <button
                          onClick={() =>
                            setExpandedProvider(isExpanded ? null : provider.id)
                          }
                          className="w-full flex items-center gap-3 px-4 py-3 text-left"
                        >
                          {/* Provider Icon with brand color */}
                          <div
                            className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0"
                            style={{
                              background: `${provider.color}15`,
                              color: provider.color,
                              border: `1px solid ${provider.color}30`,
                            }}
                          >
                            {provider.icon}
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-display font-semibold text-white">
                                {provider.name}
                              </span>
                              {isActive && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-bot-cyan/15 text-bot-cyan font-display font-bold uppercase tracking-wider">
                                  Activo
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-bot-muted/40">
                              {provider.models.length} modelos •{" "}
                              {provider.webSearchMethod}
                            </div>
                          </div>

                          {/* Status indicator */}
                          <div
                            className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                              testStatus === "valid"
                                ? "bg-emerald-500/15 text-emerald-400"
                                : testStatus === "invalid"
                                  ? "bg-red-500/15 text-red-400"
                                  : testStatus === "testing"
                                    ? "bg-amber-500/15 text-amber-400"
                                    : isConfigured
                                      ? "bg-emerald-500/15 text-emerald-400"
                                      : "bg-bot-surface/40 text-bot-muted/30"
                            }`}
                          >
                            {testStatus === "testing" ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : testStatus === "valid" || (isConfigured && testStatus !== "invalid") ? (
                              <Check className="w-3.5 h-3.5" />
                            ) : testStatus === "invalid" ? (
                              <XCircle className="w-3.5 h-3.5" />
                            ) : (
                              <Key className="w-3.5 h-3.5" />
                            )}
                          </div>

                          {/* Expand arrow */}
                          <svg
                            className={`w-4 h-4 text-bot-muted/40 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 9l-7 7-7-7"
                            />
                          </svg>
                        </button>

                        {/* Expanded Content */}
                        {isExpanded && (
                          <div className="px-4 pb-4 pt-1 border-t border-bot-border/10 space-y-3">
                            {/* API Key Input + Test Button */}
                            <div className="space-y-1">
                              <label className="text-xs text-bot-muted/50 uppercase tracking-wider font-display">
                                {provider.name} API Key
                              </label>
                              <div className="flex gap-2">
                                <div className="relative flex-1">
                                  <input
                                    type={showKeys[`ai_${provider.id}`] ? "text" : "password"}
                                    value={displayKey}
                                    onChange={(e) => updateApiKey(provider.id, e.target.value)}
                                    placeholder={provider.apiKeyPrefix}
                                    className={`w-full bg-bot-surface/50 border rounded-lg px-3 py-2.5 pr-10 text-sm text-white placeholder-bot-muted/30 focus:outline-none transition-colors font-mono ${
                                      testStatus === "valid"
                                        ? "border-emerald-500/50 focus:border-emerald-500/60"
                                        : testStatus === "invalid"
                                          ? "border-red-500/50 focus:border-red-500/60"
                                          : "border-bot-border/30 focus:border-bot-cyan/40"
                                    }`}
                                  />
                                  <button
                                    onClick={() => toggleShow(`ai_${provider.id}`)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-bot-muted hover:text-white transition-colors"
                                  >
                                    {showKeys[`ai_${provider.id}`] ? (
                                      <EyeOff className="w-4 h-4" />
                                    ) : (
                                      <Eye className="w-4 h-4" />
                                    )}
                                  </button>
                                </div>
                                {/* Verify Button */}
                                <button
                                  onClick={() => runApiKeyTest(provider.id)}
                                  disabled={testStatus === "testing" || !displayKey || displayKey.length < 5}
                                  className={`shrink-0 flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-xs font-display font-semibold border transition-all duration-200 ${
                                    testStatus === "testing"
                                      ? "bg-bot-surface/60 border-bot-border/30 text-bot-muted cursor-wait"
                                      : testStatus === "valid"
                                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
                                        : testStatus === "invalid"
                                          ? "bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20"
                                          : "bg-bot-cyan/10 border-bot-cyan/25 text-bot-cyan hover:bg-bot-cyan/20"
                                  }`}
                                >
                                  {testStatus === "testing" ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : testStatus === "valid" ? (
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                  ) : testStatus === "invalid" ? (
                                    <XCircle className="w-3.5 h-3.5" />
                                  ) : (
                                    <Zap className="w-3.5 h-3.5" />
                                  )}
                                  {testStatus === "testing"
                                    ? "Verificando..."
                                    : testStatus === "valid"
                                      ? "Válida"
                                      : testStatus === "invalid"
                                        ? "Reintentar"
                                        : "Verificar"}
                                </button>
                              </div>
                              {/* Test Result Message */}
                              {testMsg && (
                                <div
                                  className={`flex items-center gap-1.5 text-[11px] mt-1.5 px-2 py-1.5 rounded-md ${
                                    testStatus === "valid"
                                      ? "bg-emerald-500/8 text-emerald-400"
                                      : testStatus === "invalid"
                                        ? "bg-red-500/8 text-red-400"
                                        : "bg-bot-surface/40 text-bot-muted/60"
                                  }`}
                                >
                                  {testStatus === "valid" ? (
                                    <CheckCircle2 className="w-3 h-3 shrink-0" />
                                  ) : testStatus === "invalid" ? (
                                    <AlertTriangle className="w-3 h-3 shrink-0" />
                                  ) : (
                                    <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
                                  )}
                                  <span>{testMsg}</span>
                                </div>
                              )}
                            </div>
                            <div className="flex items-center justify-between">
                              <a
                                href={provider.apiKeyUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1.5 text-[11px] hover:underline transition-colors"
                                style={{ color: provider.color }}
                              >
                                <ExternalLink className="w-3 h-3" />
                                Obtener API Key en {provider.website}
                              </a>
                              {/* Free tier indicator for Google */}
                              {provider.id === "google" && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-display">
                                  🎁 Incluye free tier
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* ═══════════════════════════════════════════════ */}
          {/* TAB: TRADING                                   */}
          {/* ═══════════════════════════════════════════════ */}
          {activeTab === "trading" && (
            <>
              <SectionTitle
                title={t("settings.tradingParams")}
                subtitle={t("settings.tradingSubtitle")}
              />
              <NumberInput
                label={t("settings.initialBalance")}
                value={form.initial_balance}
                onChange={(v) => updateField("initial_balance", v)}
                min={1}
                max={100000}
                step={10}
              />
              <NumberInput
                label={t("settings.maxBetSize")}
                value={form.max_bet_size}
                onChange={(v) => updateField("max_bet_size", v)}
                min={1}
                max={10000}
                step={10}
              />
              <NumberInput
                label={t("settings.minEdge")}
                value={form.min_edge_threshold}
                onChange={(v) => updateField("min_edge_threshold", v)}
                min={0.01}
                max={1.0}
                step={0.01}
              />
              <NumberInput
                label={t("settings.maxConcurrent")}
                value={form.max_concurrent_orders}
                onChange={(v) => updateField("max_concurrent_orders", v)}
                min={1}
                max={50}
                step={1}
              />
              <NumberInput
                label={t("settings.scanInterval")}
                value={form.scan_interval_secs}
                onChange={(v) => updateField("scan_interval_secs", v)}
                min={5}
                max={3600}
                step={5}
              />

              {/* Expiry Window */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-bot-muted/50 uppercase tracking-wider font-display">
                    {t("settings.searchWindow")}
                  </label>
                  <span className="text-xs text-bot-cyan font-mono">
                    {form.max_expiry_hours}h
                    {form.max_expiry_hours >= 24
                      ? ` (${(form.max_expiry_hours / 24).toFixed(form.max_expiry_hours % 24 === 0 ? 0 : 1)} días)`
                      : ""}
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={168}
                  step={1}
                  value={form.max_expiry_hours}
                  onChange={(e) =>
                    updateField("max_expiry_hours", parseFloat(e.target.value))
                  }
                  className="w-full h-1.5 bg-bot-border rounded-full appearance-none cursor-pointer accent-bot-cyan"
                />
                <div className="flex justify-between text-[10px] text-bot-muted/30">
                  <span>1h</span>
                  <span>12h</span>
                  <span>24h (1d)</span>
                  <span>48h (2d)</span>
                  <span>168h (7d)</span>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <div>
                  <div className="text-sm text-white font-display">Auto Trading</div>
                  <div className="text-xs text-bot-muted/50">
                    {t("settings.autoTradingDesc")}
                  </div>
                </div>
                <Toggle
                  checked={form.auto_trading}
                  onChange={(v) => updateField("auto_trading", v)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-white font-display">Survival Mode</div>
                  <div className="text-xs text-bot-muted/50">
                    {t("settings.survivalModeDesc")}
                  </div>
                </div>
                <Toggle
                  checked={form.survival_mode}
                  onChange={(v) => updateField("survival_mode", v)}
                />
              </div>

              <div className="flex items-center justify-between border-t border-bot-border/20 pt-4 mt-4">
                <div>
                  <div className="text-sm text-white font-display flex items-center gap-2">
                    <span className="text-amber-400">⚠️</span>{" "}
                    {t("settings.paperTrading")}
                  </div>
                  <div className="text-xs text-bot-muted/50">
                    {t("settings.paperTradingDesc")}
                  </div>
                </div>
                <div className="px-3 py-1 bg-bot-green/10 text-bot-green border border-bot-green/20 rounded-md text-xs font-display font-bold">
                  {t("settings.paperActive")}
                </div>
              </div>
            </>
          )}

          {/* ═══════════════════════════════════════════════ */}
          {/* TAB: AI CONFIG                                 */}
          {/* ═══════════════════════════════════════════════ */}
          {activeTab === "ai" && (
            <>
              <SectionTitle
                title="Configuración de IA"
                subtitle="Selecciona el proveedor y modelo para análisis de mercados"
              />

              {/* Provider Selector — horizontal strip */}
              <div className="flex gap-2 flex-wrap">
                {AI_PROVIDERS.map((provider) => {
                  const isSelected = form.ai_provider === provider.id;
                  const hasKey = !!(
                    form.ai_api_keys?.[provider.id] ||
                    (provider.id === "anthropic" ? form.claude_api_key : "")
                  );
                  return (
                    <button
                      key={provider.id}
                      onClick={() => selectProvider(provider.id)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all duration-200 ${
                        isSelected
                          ? "border-bot-cyan/50 bg-bot-cyan/10 ring-1 ring-bot-cyan/20 shadow-sm shadow-bot-cyan/10"
                          : hasKey
                            ? "border-bot-border/30 bg-bot-surface/40 hover:border-bot-border/50"
                            : "border-bot-border/20 bg-bot-surface/20 opacity-60 hover:opacity-80"
                      }`}
                    >
                      <span
                        className="text-sm font-bold"
                        style={{ color: isSelected ? provider.color : undefined }}
                      >
                        {provider.icon}
                      </span>
                      <span
                        className={`font-display font-medium ${isSelected ? "text-white" : "text-bot-muted/70"}`}
                      >
                        {provider.name}
                      </span>
                      {!hasKey && (
                        <AlertTriangle className="w-3 h-3 text-amber-400/60" />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Warning if no API key for selected provider */}
              {!(
                form.ai_api_keys?.[form.ai_provider] ||
                (form.ai_provider === "anthropic" ? form.claude_api_key : "")
              ) && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>
                    No hay API key configurada para{" "}
                    <strong>{activeProviderDef.name}</strong>.{" "}
                    <button
                      onClick={() => {
                        setActiveTab("keys");
                        setExpandedProvider(form.ai_provider);
                      }}
                      className="underline hover:text-amber-200 transition-colors"
                    >
                      Configurar ahora →
                    </button>
                  </span>
                </div>
              )}

              {/* Provider Info Bar */}
              <div className="flex items-center gap-4 px-3 py-2 rounded-lg bg-bot-surface/30 border border-bot-border/15">
                <div className="flex items-center gap-1.5 text-[11px] text-bot-muted/50">
                  <Globe className="w-3 h-3" />
                  <span>{activeProviderDef.webSearchMethod}</span>
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-bot-muted/50">
                  <Zap className="w-3 h-3" />
                  <span>{activeProviderDef.models.length} modelos</span>
                </div>
                {activeProviderDef.models.some((m) => m.freeTier) && (
                  <div className="flex items-center gap-1.5 text-[11px] text-emerald-400/70">
                    <span>🎁</span>
                    <span>Free tier disponible</span>
                  </div>
                )}
              </div>

              {/* Model Selection */}
              <div className="space-y-2">
                <label className="text-xs text-bot-muted/50 uppercase tracking-wider font-display">
                  Seleccionar Modelo
                </label>
                <div className="space-y-2">
                  {activeProviderDef.models.map((model) => (
                    <ModelCard
                      key={model.id}
                      model={model}
                      provider={activeProviderDef}
                      isSelected={form.ai_model === model.id}
                      onSelect={() => selectModel(model.id)}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-bot-border/20">
          {/* Active config summary */}
          <div className="flex items-center gap-2 text-[11px] text-bot-muted/40">
            <span
              className="font-bold"
              style={{ color: activeProviderDef.color }}
            >
              {activeProviderDef.icon}
            </span>
            <span className="text-white/70 font-display">
              {activeProviderDef.models.find((m) => m.id === form.ai_model)
                ?.name || form.ai_model}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-bot-muted/50 hover:text-white transition-colors font-display"
            >
              {t("settings.cancel")}
            </button>
            <button
              onClick={handleSave}
              className="flex items-center gap-2 bg-bot-cyan/15 text-bot-cyan px-5 py-2 rounded-lg text-sm font-display font-semibold hover:bg-bot-cyan/25 border border-bot-cyan/20 transition-colors"
            >
              <Save className="w-4 h-4" />
              {t("settings.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Model Card Component ─────────────────────────────────

function ModelCard({
  model,
  provider,
  isSelected,
  onSelect,
}: {
  model: AIModelDef;
  provider: AIProviderDef;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const costPerCycle = estimateCycleCost(model);
  const isFreeTier = !!model.freeTier;

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-4 py-3 rounded-xl border transition-all duration-200 ${
        isSelected
          ? "bg-bot-cyan/8 border-bot-cyan/40 ring-1 ring-bot-cyan/15 shadow-sm shadow-bot-cyan/5"
          : "bg-bot-surface/30 border-bot-border/25 hover:border-bot-border/40 hover:bg-bot-surface/50"
      }`}
    >
      {/* Row 1: Name + Tags */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Radio indicator */}
          <div
            className={`w-3.5 h-3.5 rounded-full border-2 transition-colors shrink-0 ${
              isSelected
                ? "border-bot-cyan bg-bot-cyan"
                : "border-gray-600 bg-transparent"
            }`}
          >
            {isSelected && (
              <div className="w-full h-full rounded-full flex items-center justify-center">
                <div className="w-1.5 h-1.5 rounded-full bg-white" />
              </div>
            )}
          </div>

          <span
            className={`text-sm font-display font-semibold ${isSelected ? "text-white" : "text-white/80"}`}
          >
            {model.name}
          </span>

          {/* Tag */}
          <span
            className="text-[10px] px-2 py-0.5 rounded-full font-display font-medium"
            style={{
              background: isSelected
                ? `${provider.color}20`
                : "rgba(255,255,255,0.05)",
              color: isSelected ? provider.color : "rgba(255,255,255,0.35)",
            }}
          >
            {model.tag}
          </span>

          {/* Free tier badge */}
          {isFreeTier && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-display font-bold">
              🎁 FREE
            </span>
          )}

          {/* Web search indicator */}
          {model.hasWebSearch ? (
            <span title="Búsqueda web incluida">
              <Search className="w-3 h-3 text-blue-400/50" />
            </span>
          ) : (
            <span className="text-[9px] text-red-400/40" title="Sin búsqueda web">
              ⊘
            </span>
          )}
        </div>
      </div>

      {/* Row 2: Pricing + Cost estimate */}
      <div className="flex items-center gap-4 mt-1.5 ml-6">
        <span className="text-[11px] text-bot-muted/40">
          Input:{" "}
          <span className="text-amber-400/80 font-mono">
            ${model.inputPrice}/M
          </span>
        </span>
        <span className="text-[11px] text-bot-muted/40">
          Output:{" "}
          <span className="text-amber-400/80 font-mono">
            ${model.outputPrice}/M
          </span>
        </span>
        <span className="text-[11px] text-bot-muted/40">
          ~
          <span className="text-bot-green/80 font-mono">
            ${costPerCycle.toFixed(4)}
          </span>
          /ciclo
        </span>
        {model.contextWindow >= 1000000 && (
          <span className="text-[10px] text-purple-400/50">1M ctx</span>
        )}
      </div>

      {/* Row 3: Free tier details or notes */}
      {(isFreeTier || model.note) && (
        <div className="mt-1.5 ml-6">
          {isFreeTier && model.freeTier && (
            <span className="text-[10px] text-emerald-400/60">
              ✨ {model.freeTier.description}
            </span>
          )}
          {model.note && (
            <span
              className={`text-[10px] text-bot-muted/30 italic ${isFreeTier ? "ml-3" : ""}`}
            >
              {isFreeTier ? "• " : ""}
              {model.note}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

// ─── Sub-components ──────────────────────────────────────

function SectionTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-2">
      <div className="text-sm font-display font-semibold text-white">
        {title}
      </div>
      <div className="text-xs text-bot-muted/50">{subtitle}</div>
    </div>
  );
}

function SecretInput({
  label,
  value,
  onChange,
  show,
  onToggle,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggle: () => void;
  placeholder: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-bot-muted/50 uppercase tracking-wider font-display">
        {label}
      </label>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-bot-surface/50 border border-bot-border/30 rounded-lg px-3 py-2.5 pr-10 text-sm text-white placeholder-bot-muted/30 focus:outline-none focus:border-bot-cyan/40 transition-colors font-mono"
        />
        <button
          onClick={onToggle}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-bot-muted hover:text-white transition-colors"
        >
          {show ? (
            <EyeOff className="w-4 h-4" />
          ) : (
            <Eye className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs text-bot-muted/50 uppercase tracking-wider font-display">
          {label}
        </label>
        <span className="text-xs text-bot-cyan font-mono">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 bg-bot-border/40 rounded-full appearance-none cursor-pointer accent-bot-cyan"
      />
      <div className="flex justify-between text-[10px] text-bot-muted/30">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors ${
        checked ? "bg-bot-cyan" : "bg-bot-border"
      }`}
    >
      <div
        className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
          checked ? "left-6" : "left-1"
        }`}
      />
    </button>
  );
}
