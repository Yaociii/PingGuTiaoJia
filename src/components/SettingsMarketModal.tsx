import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { usePricerStore } from '../store/usePricerStore';
import {
  fetchMarketStatsApi,
  fetchServerHealth,
  testAiConnectionApi,
} from '../api/client';
import type {
  AiProtocol,
  AiTestConnectionResult,
  MarketStatItem,
  QuotaInfo,
  ServerHealthInfo,
} from '../types/pricing';

export type SettingsModalTab = 'ai' | 'market' | 'settings';

interface SettingsMarketModalProps {
  open: boolean;
  defaultTab: SettingsModalTab;
  onClose: () => void;
}

interface VendorPreset {
  id: string;
  label: string;
  protocol: Exclude<AiProtocol, 'server_default'>;
  baseUrl: string;
  model: string;
}

const PROTOCOL_OPTIONS: Array<{
  id: AiProtocol;
  label: string;
  hint: string;
}> = [
  {
    id: 'server_default',
    label: '内置默认 (Gemini)',
    hint: '使用服务端环境变量，消耗邀请码额度',
  },
  {
    id: 'openai_compatible',
    label: 'OpenAI 兼容',
    hint: 'OpenAI / 通义千问 / 智谱 / OpenRouter / 中转站',
  },
  {
    id: 'gemini',
    label: 'Gemini 原生',
    hint: 'Google AI Studio 自有 Key 或代理地址',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    hint: 'Claude Messages 多模态视觉接口',
  },
];

const VENDOR_PRESETS: VendorPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  {
    id: 'qwen',
    label: '通义千问 VL',
    protocol: 'openai_compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen2.5-vl-72b-instruct',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM-4V',
    protocol: 'openai_compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-plus',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash',
  },
  {
    id: 'anthropic',
    label: 'Claude Sonnet',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
  },
];

const PROTOCOL_PLACEHOLDERS: Record<
  AiProtocol,
  { baseUrl: string; model: string; apiKey: string }
> = {
  server_default: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '填写自有 Key 将自动切换为自定义优先模式',
  },
  openai_compatible: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini / qwen2.5-vl-72b-instruct',
    apiKey: 'sk-...',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash',
    apiKey: 'AIza...',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    apiKey: 'sk-ant-...',
  },
};

function inferCustomProtocol(apiKey: string, baseUrl: string): Exclude<AiProtocol, 'server_default'> {
  const key = apiKey.trim();
  const url = baseUrl.trim().toLowerCase();
  if (key.startsWith('sk-ant-') || url.includes('anthropic.com')) {
    return 'anthropic';
  }
  if (key.startsWith('AIza') || url.includes('generativelanguage.googleapis.com')) {
    return 'gemini';
  }
  return 'openai_compatible';
}

interface AiConfigFormProps {
  compact?: boolean;
  onTestResult?: (result: AiTestConnectionResult | null) => void;
}

const AiConfigForm: React.FC<AiConfigFormProps> = ({ compact = false }) => {
  const settings = usePricerStore((s) => s.settings);
  const updateAiConfig = usePricerStore((s) => s.updateAiConfig);
  const notify = usePricerStore((s) => s.notify);

  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestConnectionResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const { aiConfig } = settings;
  const placeholders = PROTOCOL_PLACEHOLDERS[aiConfig.protocol];
  const isCustomActive = aiConfig.protocol !== 'server_default';

  const handleProtocolChange = (protocol: AiProtocol) => {
    setTestResult(null);
    setTestError(null);
    if (protocol === 'server_default') {
      updateAiConfig({ protocol });
      return;
    }
    const presetForProto = VENDOR_PRESETS.find((p) => p.protocol === protocol);
    const shouldSwapDefaults =
      aiConfig.protocol !== protocol &&
      presetForProto &&
      (!aiConfig.baseUrl.trim() ||
        VENDOR_PRESETS.some((p) => p.baseUrl === aiConfig.baseUrl.trim()));
    updateAiConfig({
      protocol,
      ...(shouldSwapDefaults && presetForProto
        ? { baseUrl: presetForProto.baseUrl, model: presetForProto.model }
        : {}),
    });
  };

  const handleApplyPreset = (preset: VendorPreset) => {
    setTestResult(null);
    setTestError(null);
    updateAiConfig({
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      model: preset.model,
    });
  };

  const handleApiKeyChange = (value: string) => {
    setTestResult(null);
    setTestError(null);
    if (aiConfig.protocol === 'server_default' && value.trim()) {
      updateAiConfig({
        protocol: inferCustomProtocol(value, aiConfig.baseUrl),
        apiKey: value,
      });
      return;
    }
    updateAiConfig({ apiKey: value });
  };

  const handleBaseUrlChange = (value: string) => {
    setTestResult(null);
    setTestError(null);
    if (aiConfig.protocol === 'server_default' && aiConfig.apiKey.trim()) {
      updateAiConfig({
        protocol: inferCustomProtocol(aiConfig.apiKey, value),
        baseUrl: value,
      });
      return;
    }
    updateAiConfig({ baseUrl: value });
  };

  const handleModelChange = (value: string) => {
    setTestResult(null);
    setTestError(null);
    updateAiConfig({ model: value });
  };

  const handleClearKey = () => {
    setTestResult(null);
    setTestError(null);
    updateAiConfig({ apiKey: '', protocol: 'server_default' });
    notify('已清除本地保存的 API Key，并切换回默认服务。', 'info');
  };

  const handleSaveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const nextProtocol =
      aiConfig.protocol === 'server_default' && aiConfig.apiKey.trim()
        ? inferCustomProtocol(aiConfig.apiKey, aiConfig.baseUrl)
        : aiConfig.protocol;

    updateAiConfig({
      protocol: nextProtocol,
      apiKey: aiConfig.apiKey.trim(),
      baseUrl: aiConfig.baseUrl.trim(),
      model: aiConfig.model.trim(),
    });
    setSavedNotice(true);
    window.setTimeout(() => setSavedNotice(false), 2600);
    notify(
      nextProtocol === 'server_default'
        ? '已保存设置：当前使用内置默认 Gemini 服务。'
        : `已保存自定义 AI 配置（${nextProtocol}）至浏览器本地存储，请求时将优先使用。`,
      'success'
    );
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const effectiveConfig =
        aiConfig.protocol === 'server_default' && aiConfig.apiKey.trim()
          ? {
              ...aiConfig,
              protocol: inferCustomProtocol(aiConfig.apiKey, aiConfig.baseUrl),
            }
          : aiConfig;

      if (effectiveConfig.protocol !== aiConfig.protocol) {
        updateAiConfig({ protocol: effectiveConfig.protocol });
      }

      const res = await testAiConnectionApi({
        inviteCode: settings.inviteCode,
        aiConfig: effectiveConfig,
      });
      setTestResult(res);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : '连接测试失败');
    } finally {
      setTesting(false);
    }
  };

  return (
    <form onSubmit={handleSaveSubmit} className={compact ? 'space-y-3.5' : 'space-y-5'}>
      {compact ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-semibold text-slate-900">
              自定义 AI 接口配置（识图与自动调价优先使用）
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              配置自动持久化至浏览器 localStorage，优先于服务端环境变量。
            </p>
          </div>
          <select
            aria-label="AI 接口协议"
            value={aiConfig.protocol}
            onChange={(e) => handleProtocolChange(e.target.value as AiProtocol)}
            className="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-800 focus:outline-none focus:border-slate-900"
          >
            {PROTOCOL_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-xs font-semibold text-slate-900">接口协议类型</span>
              <span className="text-[11px] text-slate-500">
                {isCustomActive
                  ? '当前优先使用用户自定义配置（不消耗默认邀请码额度）'
                  : '当前使用服务端默认配置'}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {PROTOCOL_OPTIONS.map((opt) => {
                const selected = aiConfig.protocol === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleProtocolChange(opt.id)}
                    aria-pressed={selected}
                    className={`text-left p-2.5 rounded-xl border transition-colors ${
                      selected
                        ? 'border-slate-950 bg-slate-950 text-white'
                        : 'border-slate-200 bg-white text-slate-800 hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <div className="text-xs font-semibold whitespace-nowrap truncate">
                      {opt.label}
                    </div>
                    <div
                      className={`mt-1 text-[10px] leading-snug line-clamp-2 ${
                        selected ? 'text-slate-300' : 'text-slate-500'
                      }`}
                    >
                      {opt.hint}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-medium text-slate-500 mb-1.5">
              常用视觉模型预设（一键填充 Base URL 与模型名）
            </div>
            <div className="flex flex-wrap gap-1.5">
              {VENDOR_PRESETS.map((preset) => {
                const isCurrent =
                  aiConfig.protocol === preset.protocol &&
                  aiConfig.baseUrl.trim() === preset.baseUrl &&
                  aiConfig.model.trim() === preset.model;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleApplyPreset(preset)}
                    className={`px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      isCurrent
                        ? 'border-slate-900 bg-slate-100 text-slate-950'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-950'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Core Configuration Inputs: API Key, API Base URL, Model Name */}
      <div className={compact ? 'grid grid-cols-1 md:grid-cols-3 gap-3' : 'space-y-3.5'}>
        <div>
          <label
            htmlFor={compact ? 'market-ai-api-key' : 'ai-api-key'}
            className="block text-xs font-semibold text-slate-900 mb-1"
          >
            API Key
          </label>
          <div className="relative flex items-center">
            <input
              id={compact ? 'market-ai-api-key' : 'ai-api-key'}
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={aiConfig.apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
              placeholder={placeholders.apiKey}
              className="w-full pl-3 pr-16 py-2 rounded-lg border border-slate-200 text-xs font-mono text-slate-900 bg-white focus:outline-none focus:border-slate-900"
            />
            <div className="absolute right-1.5 flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                className="p-1.5 rounded text-slate-400 hover:text-slate-700"
              >
                {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
              {aiConfig.apiKey && (
                <button
                  type="button"
                  onClick={handleClearKey}
                  aria-label="清除本地密钥"
                  title="清除本地密钥"
                  className="p-1.5 rounded text-slate-400 hover:text-rose-600"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className={compact ? '' : 'grid grid-cols-1 sm:grid-cols-2 gap-3.5'}>
          <div>
            <label
              htmlFor={compact ? 'market-ai-base-url' : 'ai-base-url'}
              className="block text-xs font-semibold text-slate-900 mb-1"
            >
              API Base URL
            </label>
            <input
              id={compact ? 'market-ai-base-url' : 'ai-base-url'}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={aiConfig.baseUrl}
              onChange={(e) => handleBaseUrlChange(e.target.value)}
              placeholder={placeholders.baseUrl}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs font-mono text-slate-900 bg-white focus:outline-none focus:border-slate-900"
            />
          </div>

          {!compact && (
            <div>
              <label
                htmlFor="ai-model-name"
                className="block text-xs font-semibold text-slate-900 mb-1"
              >
                Model Name（模型名称）
              </label>
              <input
                id="ai-model-name"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={aiConfig.model}
                onChange={(e) => handleModelChange(e.target.value)}
                placeholder={placeholders.model}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs font-mono text-slate-900 bg-white focus:outline-none focus:border-slate-900"
              />
            </div>
          )}
        </div>

        {compact && (
          <div>
            <label
              htmlFor="market-ai-model-name"
              className="block text-xs font-semibold text-slate-900 mb-1"
            >
              Model Name（模型名称）
            </label>
            <input
              id="market-ai-model-name"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={aiConfig.model}
              onChange={(e) => handleModelChange(e.target.value)}
              placeholder={placeholders.model}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-xs font-mono text-slate-900 bg-white focus:outline-none focus:border-slate-900"
            />
          </div>
        )}
      </div>

      {/* Action Row */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-950 text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Save className="w-3.5 h-3.5" />
            <span>保存配置</span>
          </button>
          <button
            type="button"
            onClick={() => void handleTestConnection()}
            disabled={testing}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium border border-slate-200 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            {testing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <PlugZap className="w-3.5 h-3.5" />
            )}
            <span>{testing ? '测试中...' : '测试连接'}</span>
          </button>
          {savedNotice && (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-700 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>已保存至本地</span>
            </span>
          )}
        </div>

        {!compact && (
          <p className="text-[11px] text-slate-400">
            密钥仅存于浏览器 localStorage，服务端绝不落盘保存；Base URL 仅支持公网 https:// 地址。
          </p>
        )}
      </div>

      {/* Live Connection Test Result / Error */}
      {testResult && (
        <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex flex-wrap items-center justify-between gap-2 tabular-nums">
          <div className="flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>
              连接成功 · <span className="font-mono">{testResult.providerUsed}</span>
            </span>
          </div>
          <div className="text-emerald-700 font-mono">
            {testResult.latencyMs}ms · 回复：{testResult.replyPreview}
          </div>
        </div>
      )}
      {testError && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700 leading-relaxed"
        >
          {testError}
        </div>
      )}
    </form>
  );
};

export const SettingsMarketModal: React.FC<SettingsMarketModalProps> = ({
  open,
  defaultTab,
  onClose,
}) => {
  const settings = usePricerStore((s) => s.settings);
  const updateSettings = usePricerStore((s) => s.updateSettings);
  const setQuota = usePricerStore((s) => s.setQuota);

  const [activeTab, setActiveTab] = useState<SettingsModalTab>(defaultTab);
  const [health, setHealth] = useState<ServerHealthInfo | null>(null);
  const [stats, setStats] = useState<MarketStatItem[]>([]);
  const [quota, setLocalQuota] = useState<QuotaInfo | null>(null);
  const [searchText, setSearchText] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('全部');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (open) setActiveTab(defaultTab);
  }, [open, defaultTab]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [h, m] = await Promise.all([
        fetchServerHealth(),
        fetchMarketStatsApi({
          inviteCode: settings.inviteCode,
          ipName: searchText,
          category: categoryFilter,
        }),
      ]);
      setHealth(h);
      setStats(m.stats);
      setLocalQuota(m.quota);
      setQuota(m.quota);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '读取服务端行情数据失败');
    } finally {
      setLoading(false);
    }
  }, [settings.inviteCode, searchText, categoryFilter, setQuota]);

  useEffect(() => {
    if (!open) return;
    void loadData();
  }, [open, loadData]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/45 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-market-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl max-h-[88vh] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-4 shrink-0">
          <div className="flex flex-wrap items-center gap-4 min-w-0">
            <h2 id="settings-market-title" className="text-sm font-bold text-slate-950 whitespace-nowrap">
              AI 配置与行情库
            </h2>
            <div className="inline-flex p-0.5 bg-slate-100 rounded-lg" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'ai'}
                onClick={() => setActiveTab('ai')}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  activeTab === 'ai'
                    ? 'bg-white text-slate-950 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>AI 密钥与协议</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'market'}
                onClick={() => setActiveTab('market')}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  activeTab === 'market'
                    ? 'bg-white text-slate-950 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                <span>Market · 行情库</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'settings'}
                onClick={() => setActiveTab('settings')}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  activeTab === 'settings'
                    ? 'bg-white text-slate-950 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Settings className="w-3.5 h-3.5" />
                <span>邀请码与隐私</span>
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="关闭设置与行情库弹窗"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'ai' && (
            <div className="space-y-6">
              <AiConfigForm compact={false} />

              <div className="pt-4 border-t border-slate-100 text-xs text-slate-600 space-y-1.5">
                <div className="font-semibold text-slate-900">多协议兼容与优先级说明</div>
                <p className="text-[11px] leading-relaxed text-slate-500">
                  1. 当选择任意自定义协议（OpenAI 兼容 / Gemini 原生 / Anthropic Claude）并填写 API Key 后，后端{' '}
                  <span className="font-mono text-slate-700">AI 识图</span> 与{' '}
                  <span className="font-mono text-slate-700">AI 自动调价</span>{' '}
                  会优先使用您的配置，不读取服务端环境变量，也不消耗默认邀请码的每日次数。
                </p>
                <p className="text-[11px] leading-relaxed text-slate-500">
                  2. 识图功能需要模型具备视觉多模态能力（如 <span className="font-mono">gpt-4o-mini</span>、
                  <span className="font-mono">qwen2.5-vl-72b-instruct</span>、
                  <span className="font-mono">glm-4v-plus</span>、
                  <span className="font-mono">gemini-2.5-flash</span>、
                  <span className="font-mono">claude-sonnet-4-20250514</span>）；AI 自动调价支持任意主流文本或视觉模型。
                </p>
              </div>
            </div>
          )}

          {activeTab === 'market' && (
            <div className="space-y-6">
              {/* Custom API Config Form persisted to localStorage inside Market tab */}
              <div className="p-4 rounded-xl bg-slate-50/70 border border-slate-200">
                <AiConfigForm compact={true} />
              </div>

              {/* Historical Market Stats Table */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="搜索作品 IP 或角色俗称..."
                      aria-label="搜索历史行情库"
                      value={searchText}
                      onChange={(e) => setSearchText(e.target.value)}
                      className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 text-xs focus:outline-none focus:border-slate-900"
                    />
                  </div>
                  <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg">
                    {['全部', '吧唧', '立牌', '色纸', '通用'].map((cat) => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setCategoryFilter(cat)}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                          categoryFilter === cat
                            ? 'bg-white text-slate-950 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                </div>

                {errorMsg ? (
                  <div className="p-4 rounded-xl bg-rose-50 text-xs text-rose-700">{errorMsg}</div>
                ) : (
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                          <th className="py-2.5 px-3.5">作品 IP</th>
                          <th className="py-2.5 px-3.5">角色俗称</th>
                          <th className="py-2.5 px-3.5">品类</th>
                          <th className="py-2.5 px-3.5 text-right">历史均价系数</th>
                          <th className="py-2.5 px-3.5 text-right">沉淀样本</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {stats.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-8 text-center text-slate-400">
                              {loading ? '正在加载行情库...' : '暂无匹配的历史行情记录'}
                            </td>
                          </tr>
                        ) : (
                          stats.map((row) => (
                            <tr key={row.id} className="hover:bg-slate-50/70">
                              <td className="py-2.5 px-3.5 font-medium text-slate-900">{row.ipName}</td>
                              <td className="py-2.5 px-3.5 text-slate-800">{row.characterName}</td>
                              <td className="py-2.5 px-3.5 text-slate-500">{row.category}</td>
                              <td className="py-2.5 px-3.5 text-right font-mono font-semibold tabular-nums">
                                <span
                                  className={
                                    row.avgWeightRatio >= 1.15
                                      ? 'text-rose-600'
                                      : row.avgWeightRatio <= 0.85
                                        ? 'text-blue-600'
                                        : 'text-slate-800'
                                  }
                                >
                                  ×{row.avgWeightRatio.toFixed(2)}
                                </span>
                              </td>
                              <td className="py-2.5 px-3.5 text-right font-mono text-slate-500 tabular-nums">
                                {row.sampleCount} 团
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-[11px] text-slate-400">
                  当角色历史样本量 ≥ 3 团时，AI 识图与 AI 自动调价将优先融合真实行情权重（并在价格胶囊上显示行情库标识）。
                </p>
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-6 max-w-xl">
              <div>
                <label htmlFor="invite-code-input" className="block text-xs font-semibold text-slate-900 mb-1.5">
                  访问邀请码（X-Access-Token）
                </label>
                <div className="flex gap-2">
                  <input
                    id="invite-code-input"
                    type="text"
                    value={settings.inviteCode}
                    onChange={(e) => updateSettings({ inviteCode: e.target.value })}
                    placeholder="dev-local-001"
                    className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-xs font-mono text-slate-900 focus:outline-none focus:border-slate-900"
                  />
                  <button
                    type="button"
                    onClick={() => void loadData()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-950 text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                    <span>校验额度</span>
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-500">
                  用于访问历史行情库及内置默认服务；默认内置本地联调码{' '}
                  <span className="font-mono text-slate-700">dev-local-001</span>。若您填写了自有 API Key，则不消耗此额度。
                </p>
              </div>

              <div className="pt-4 border-t border-slate-100">
                <label className="flex items-start justify-between gap-4 cursor-pointer select-none">
                  <div>
                    <div className="text-xs font-semibold text-slate-900">
                      匿名贡献成团调价行情（推荐开启）
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500 leading-relaxed">
                      在您导出或复制成品图时，仅上报作品 IP、角色俗称与最终单价相对均价的权重比例，帮助提升后续识图准确度；绝不上传原图与任何团员隐私，且同一工程自动幂等去重。
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.contributeMarket}
                    onChange={(e) => updateSettings({ contributeMarket: e.target.checked })}
                    className="mt-1 w-4 h-4 accent-slate-950 shrink-0"
                  />
                </label>
              </div>

              <div className="pt-4 border-t border-slate-100 space-y-2 text-xs">
                <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  <span>默认后端服务与今日额度</span>
                </div>
                {errorMsg ? (
                  <p className="text-rose-600">{errorMsg}</p>
                ) : (
                  <div className="grid grid-cols-2 gap-3 pt-1 text-slate-600 tabular-nums">
                    <div>
                      默认视觉引擎：
                      <span className="font-mono text-slate-900">
                        {health ? `${health.provider} / ${health.model}` : '检测中...'}
                      </span>
                    </div>
                    <div>
                      今日默认剩余：
                      <span className="font-mono font-semibold text-slate-900">
                        {quota ? `${quota.remainingToday} / ${quota.dailyLimit} 次` : '未绑定有效邀请码'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
