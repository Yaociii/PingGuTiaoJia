import React, { useCallback, useEffect, useState } from 'react';
import { Database, RefreshCw, Search, Settings, ShieldCheck, X } from 'lucide-react';
import { usePricerStore } from '../store/usePricerStore';
import { fetchMarketStatsApi, fetchServerHealth } from '../api/client';
import type { MarketStatItem, QuotaInfo, ServerHealthInfo } from '../types/pricing';

interface SettingsMarketModalProps {
  open: boolean;
  defaultTab: 'settings' | 'market';
  onClose: () => void;
}

export const SettingsMarketModal: React.FC<SettingsMarketModalProps> = ({
  open,
  defaultTab,
  onClose,
}) => {
  const settings = usePricerStore((s) => s.settings);
  const updateSettings = usePricerStore((s) => s.updateSettings);
  const setQuota = usePricerStore((s) => s.setQuota);

  const [activeTab, setActiveTab] = useState<'settings' | 'market'>(defaultTab);
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
        className="w-full max-w-3xl max-h-[85vh] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <h2 id="settings-market-title" className="text-sm font-bold text-slate-950">
              行情库与服务设置
            </h2>
            <div className="inline-flex p-0.5 bg-slate-100 rounded-lg" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'market'}
                onClick={() => setActiveTab('market')}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  activeTab === 'market'
                    ? 'bg-white text-slate-950 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                <span>历史行情库</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'settings'}
                onClick={() => setActiveTab('settings')}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  activeTab === 'settings'
                    ? 'bg-white text-slate-950 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Settings className="w-3.5 h-3.5" />
                <span>服务与邀请码</span>
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="关闭行情库与服务设置弹窗"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'settings' ? (
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
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-950 text-white hover:bg-slate-800 transition-colors"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                    <span>校验额度</span>
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-500">
                  用于调用后端 AI 识图与历史行情库；默认内置本地联调码 <span className="font-mono text-slate-700">dev-local-001</span>。
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

              {/* Real Server Connection & Quota Status */}
              <div className="pt-4 border-t border-slate-100 space-y-2 text-xs">
                <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  <span>后端服务状态与今日额度</span>
                </div>
                {errorMsg ? (
                  <p className="text-rose-600">{errorMsg}</p>
                ) : (
                  <div className="grid grid-cols-2 gap-3 pt-1 text-slate-600 tabular-nums">
                    <div>
                      视觉模型引擎：
                      <span className="font-mono text-slate-900">
                        {health ? `${health.provider} / ${health.model}` : '检测中...'}
                      </span>
                    </div>
                    <div>
                      今日剩余识图：
                      <span className="font-mono font-semibold text-slate-900">
                        {quota ? `${quota.remainingToday} / ${quota.dailyLimit} 次` : '—'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
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
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
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
                当角色历史样本量 ≥ 3 团时，AI 识图后将自动优先采用真实行情权重（并在价格胶囊上显示行情库标识）。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
