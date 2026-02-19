import { useState } from "react";
import { X, Key, Bot, Sliders, Shield, Save, Eye, EyeOff } from "lucide-react";
import { BotConfig, defaultConfig } from "../types";
import { CLAUDE_MODELS } from "../services/claudeAI";
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
  const { t } = useTranslation();

  const toggleShow = (field: string) => {
    setShowKeys((prev) => ({ ...prev, [field]: !prev[field] }));
  };

  const updateField = (field: keyof BotConfig, value: any) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = () => {
    onSave(form);
  };

  const tabs = [
    { id: "keys" as const, label: t("settings.tabKeys"), icon: Key },
    { id: "trading" as const, label: t("settings.tabTrading"), icon: Sliders },
    { id: "ai" as const, label: t("settings.tabAI"), icon: Bot },
  ];

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50">
      <div className="glass-card rounded-2xl w-[600px] max-h-[80vh] flex flex-col shadow-card-hover border border-bot-border/30">
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
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 custom-scrollbar">
          {activeTab === "keys" && (
            <>
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

              <div className="border-t border-bot-border/20 pt-5">
                <SectionTitle
                  title={t("settings.claudeAI")}
                  subtitle={t("settings.claudeSubtitle")}
                />
                <SecretInput
                  label={t("settings.claudeApiKey")}
                  value={form.claude_api_key}
                  onChange={(v) => updateField("claude_api_key", v)}
                  show={showKeys["claude_key"]}
                  onToggle={() => toggleShow("claude_key")}
                  placeholder={t("settings.claudeApiKeyPlaceholder")}
                />
              </div>
            </>
          )}

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
                    {form.max_expiry_hours}h{form.max_expiry_hours >= 24 ? ` (${(form.max_expiry_hours / 24).toFixed(form.max_expiry_hours % 24 === 0 ? 0 : 1)} días)` : ""}
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={168}
                  step={1}
                  value={form.max_expiry_hours}
                  onChange={(e) => updateField("max_expiry_hours", parseFloat(e.target.value))}
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
                    <span className="text-amber-400">⚠️</span> {t("settings.paperTrading")}
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

          {activeTab === "ai" && (
            <>
              <SectionTitle
                title={t("settings.aiConfig")}
                subtitle={t("settings.aiConfigSubtitle")}
              />
              <div className="space-y-2">
                <label className="text-xs text-bot-muted/50 uppercase tracking-wider font-display">
                  {t("settings.claudeModel")}
                </label>
                <div className="space-y-2">
                  {CLAUDE_MODELS.map((m) => {
                    const selected = form.claude_model === m.id;
                    return (
                      <button
                        key={m.id}
                        onClick={() => updateField("claude_model", m.id)}
                        className={`w-full text-left px-4 py-3 rounded-lg border transition-all ${
                          selected
                            ? "bg-bot-cyan/10 border-bot-cyan/40 ring-1 ring-bot-cyan/20"
                            : "bg-bot-surface/40 border-bot-border/30 hover:border-bot-cyan/20 hover:bg-bot-surface/60"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className={`w-3 h-3 rounded-full border-2 ${
                              selected ? "border-bot-cyan bg-bot-cyan" : "border-gray-600"
                            }`} />
                            <span className={`text-sm font-display font-semibold ${selected ? "text-bot-cyan" : "text-white"}`}>
                              {m.name}
                            </span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-display font-medium ${
                              selected ? "bg-bot-cyan/15 text-bot-cyan" : "bg-bot-surface/60 text-bot-muted/40"
                            }`}>
                              {m.tag}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 mt-1 ml-5">
                          <span className="text-[11px] text-bot-muted/40">
                            {t("settings.input")} <span className="text-amber-400/80 font-mono">${m.inputPrice}/M</span>
                          </span>
                          <span className="text-[11px] text-bot-muted/40">
                            {t("settings.output")} <span className="text-amber-400/80 font-mono">${m.outputPrice}/M</span>
                          </span>
                          <span className="text-[11px] text-bot-muted/40">
                            ~<span className="text-bot-green/80 font-mono">${((m.inputPrice * 1500 + m.outputPrice * 800) / 1_000_000).toFixed(4)}</span>{t("settings.perCycle")}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-bot-border/20">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-bot-muted/50 hover:text-white transition-colors font-display"
          >
            {t("settings.cancel")}
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-2 bg-bot-cyan/15 text-bot-cyan px-5 py-2 rounded-lg text-sm font-display font-semibold hover:bg-bot-cyan/25 border border-bot-cyan/20 transition-colors">
            <Save className="w-4 h-4" />
            {t("settings.save")}
          </button>
        </div>
      </div>
    </div>
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
      <div className="text-sm font-display font-semibold text-white">{title}</div>
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
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
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
