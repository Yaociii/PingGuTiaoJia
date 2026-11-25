import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  Scissors,
  Search,
  Trash2,
  Unlock,
} from 'lucide-react';
import { usePricerStore } from '../store/usePricerStore';
import { calcTargetTotal, formatMoney } from '../core/rebalancer';
import {
  GAMMA_MAX,
  GAMMA_MIN,
  MERCH_CATEGORIES,
  PIN_TAGS,
  WEIGHT_MAX,
  WEIGHT_MIN,
  type MerchCategory,
  type PinTag,
  type PriceFreshness,
  type PriceStep,
} from '../types/pricing';
import {
  copyPngBlobToClipboard,
  cropSingleItemToBlob,
  triggerBlobDownload,
} from '../core/canvasExport';
import { sanitizeSafeHref } from '../api/client';

function formatFreshnessText(f?: PriceFreshness): string {
  if (f === 'fresh') return '30天内';
  if (f === 'recent') return '90天内';
  return '待更新';
}

export const InspectorPanel: React.FC = () => {
  const activeProject = usePricerStore((s) => s.activeProject);
  const rebalance = usePricerStore((s) => s.rebalance);
  const selectedItemId = usePricerStore((s) => s.selectedItemId);
  const setSelectedItemId = usePricerStore((s) => s.setSelectedItemId);
  const updateProjectMeta = usePricerStore((s) => s.updateProjectMeta);
  const updateCostConfig = usePricerStore((s) => s.updateCostConfig);
  const updateItemPriceAndLock = usePricerStore((s) => s.updateItemPriceAndLock);
  const adjustItemPriceStep = usePricerStore((s) => s.adjustItemPriceStep);
  const toggleItemLock = usePricerStore((s) => s.toggleItemLock);
  const updateItemField = usePricerStore((s) => s.updateItemField);
  const deleteItem = usePricerStore((s) => s.deleteItem);
  const unlockAllItems = usePricerStore((s) => s.unlockAllItems);
  const resetEqualWeights = usePricerStore((s) => s.resetEqualWeights);
  const isLookingUpPrices = usePricerStore((s) => s.isLookingUpPrices);
  const lookupItemIds = usePricerStore((s) => s.lookupItemIds);
  const runBatchPriceLookup = usePricerStore((s) => s.runBatchPriceLookup);
  const runSingleItemPriceLookup = usePricerStore((s) => s.runSingleItemPriceLookup);
  const notify = usePricerStore((s) => s.notify);

  const initialized = usePricerStore((s) => s.initialized);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!initialized) {
    return (
      <aside className="w-full md:w-[356px] shrink-0 bg-white border-l border-[#E4E7EC] p-5 space-y-4">
        <div className="h-8 rounded-lg bg-slate-100 animate-pulse" />
        <div className="h-10 rounded-lg bg-slate-100 animate-pulse" />
        <div className="h-px bg-slate-100" />
        <div className="space-y-2.5">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-11 rounded-lg bg-slate-100/80 animate-pulse" />
          ))}
        </div>
      </aside>
    );
  }

  if (!activeProject) {
    return (
      <aside className="w-full md:w-[356px] shrink-0 bg-white border-l border-[#E4E7EC] p-6 text-sm text-slate-400">
        暂无打开的拼团工程。
      </aside>
    );
  }

  const { cost } = activeProject;
  const gamma = cost.gamma ?? 1.0;
  const items = rebalance.items;
  const lockedCount = items.filter((it) => it.locked && it.quantity > 0).length;
  const computedTarget = calcTargetTotal(cost);

  const handleCrop = async (itemId: string) => {
    const item = items.find((it) => it.id === itemId);
    if (!item || !activeProject.imageDataUrl) return;
    try {
      const blob = await cropSingleItemToBlob(activeProject.imageDataUrl, item);
      const status = await copyPngBlobToClipboard(blob);
      if (status === 'copied') {
        notify(`已复制「${item.label}」单谷裁图到剪贴板。`, 'success');
      } else {
        triggerBlobDownload(blob, `${item.label || '单谷'}-裁图.png`);
        notify(`已下载「${item.label}」单谷裁图。`, 'info');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : '裁图失败', 'error');
    }
  };

  return (
    <aside
      aria-label="成本核算与调价明细"
      className="w-full md:w-[356px] shrink-0 bg-white border-l border-[#E4E7EC] flex flex-col h-full"
    >
      {/* Section 1: Project Meta, Cost Calculator & Gamma Slider */}
      <div className="p-4 border-b border-[#EEF0F4] space-y-3 shrink-0">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="ip-name-input" className="block text-[11px] font-medium text-slate-500 mb-1">
              作品 IP
            </label>
            <input
              id="ip-name-input"
              type="text"
              placeholder="如：排球少年"
              value={activeProject.ipName}
              onChange={(e) => updateProjectMeta({ ipName: e.target.value })}
              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-slate-900"
            />
          </div>
          <div>
            <label htmlFor="category-select" className="block text-[11px] font-medium text-slate-500 mb-1">
              谷子品类
            </label>
            <select
              id="category-select"
              value={activeProject.category}
              onChange={(e) => updateProjectMeta({ category: e.target.value as MerchCategory })}
              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-900 bg-white focus:outline-none focus:border-slate-900"
            >
              {MERCH_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Mode Segmented Switch */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-medium text-slate-500">成本核算方式</span>
            <div className="inline-flex p-0.5 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => updateCostConfig({ mode: 'direct' })}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  cost.mode === 'direct'
                    ? 'bg-white text-slate-950 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                直接总价
              </button>
              <button
                type="button"
                onClick={() => updateCostConfig({ mode: 'foreign' })}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  cost.mode === 'foreign'
                    ? 'bg-white text-slate-950 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                外币汇率
              </button>
            </div>
          </div>

          {cost.mode === 'direct' ? (
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <label htmlFor="target-total-input" className="sr-only">
                  预期总价
                </label>
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-mono text-slate-400">
                  ¥
                </span>
                <input
                  id="target-total-input"
                  type="number"
                  min={0}
                  step={cost.step}
                  value={cost.targetTotal}
                  onChange={(e) => {
                    const val = Number.parseFloat(e.target.value);
                    updateCostConfig({ targetTotal: Number.isFinite(val) ? Math.max(0, val) : 0 });
                  }}
                  className="w-full pl-7 pr-3 py-1.5 rounded-lg border border-slate-200 text-base font-mono font-bold text-slate-950 tabular-nums focus:outline-none focus:border-slate-900"
                />
              </div>
              <div className="flex items-center bg-slate-100 p-0.5 rounded-lg shrink-0" role="group" aria-label="调价步长">
                {([0.5, 1, 5] as PriceStep[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => updateCostConfig({ step: s })}
                    className={`px-2 py-1 rounded-md text-xs font-mono font-semibold transition-colors whitespace-nowrap shrink-0 ${
                      cost.step === s
                        ? 'bg-white text-slate-950 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="foreign-price" className="block text-[11px] text-slate-500 mb-0.5">
                    外币原价 (如 JPY)
                  </label>
                  <input
                    id="foreign-price"
                    type="number"
                    min={0}
                    value={cost.foreignPrice}
                    onChange={(e) =>
                      updateCostConfig({ foreignPrice: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-mono tabular-nums focus:outline-none focus:border-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="exchange-rate" className="block text-[11px] text-slate-500 mb-0.5">
                    汇率
                  </label>
                  <input
                    id="exchange-rate"
                    type="number"
                    min={0}
                    step={0.001}
                    value={cost.exchangeRate}
                    onChange={(e) =>
                      updateCostConfig({ exchangeRate: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-mono tabular-nums focus:outline-none focus:border-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="shipping-fee" className="block text-[11px] text-slate-500 mb-0.5">
                    运费 (¥)
                  </label>
                  <input
                    id="shipping-fee"
                    type="number"
                    min={0}
                    value={cost.shippingFee}
                    onChange={(e) =>
                      updateCostConfig({ shippingFee: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-mono tabular-nums focus:outline-none focus:border-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="fee-rate" className="block text-[11px] text-slate-500 mb-0.5">
                    手续费率 (%)
                  </label>
                  <input
                    id="fee-rate"
                    type="number"
                    min={0}
                    step={0.1}
                    value={Math.round(cost.feeRate * 1000) / 10}
                    onChange={(e) =>
                      updateCostConfig({ feeRate: Math.max(0, (Number(e.target.value) || 0) / 100) })
                    }
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-mono tabular-nums focus:outline-none focus:border-slate-900"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <div className="text-xs text-slate-600 tabular-nums">
                  折合总价{' '}
                  <strong className="font-mono text-sm text-slate-950">
                    ¥{formatMoney(computedTarget)}
                  </strong>
                </div>
                <div className="flex items-center bg-slate-100 p-0.5 rounded-lg" role="group" aria-label="调价步长">
                  {([0.5, 1, 5] as PriceStep[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => updateCostConfig({ step: s })}
                      className={`px-2 py-1 rounded text-[11px] font-mono font-semibold transition-colors whitespace-nowrap shrink-0 ${
                        cost.step === s
                          ? 'bg-white text-slate-950 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* V2.0 Price Spread Gamma Slider */}
        <div className="pt-2 border-t border-slate-100">
          <div className="flex items-center justify-between text-[11px] mb-1">
            <label htmlFor="gamma-slider" className="font-medium text-slate-600">
              冷烫温差系数 γ
            </label>
            <div className="flex items-center gap-1.5">
              <span className="font-mono font-semibold text-slate-900 tabular-nums">
                {gamma.toFixed(2)}
              </span>
              {Math.abs(gamma - 1.0) > 0.01 && (
                <button
                  type="button"
                  onClick={() => updateCostConfig({ gamma: 1.0 })}
                  className="text-[10px] font-medium text-slate-500 hover:text-slate-900 underline whitespace-nowrap shrink-0"
                >
                  重置1.0
                </button>
              )}
            </div>
          </div>
          <input
            id="gamma-slider"
            type="range"
            min={GAMMA_MIN}
            max={GAMMA_MAX}
            step={0.05}
            value={gamma}
            onChange={(e) => {
              const val = Number.parseFloat(e.target.value);
              if (Number.isFinite(val)) {
                updateCostConfig({ gamma: val });
              }
            }}
            className="w-full h-1.5 accent-slate-900 cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-slate-400 font-mono tabular-nums mt-0.5">
            <span>0.5 缓和均摊</span>
            <span>1.0 标准</span>
            <span>2.5 强拉冷烫</span>
          </div>
        </div>
      </div>

      {/* Section 2 Header: Goods List Toolbar + Batch Market Price Lookup */}
      <div className="px-4 py-2 border-b border-[#EEF0F4] flex items-center justify-between gap-2 shrink-0 bg-slate-50/60">
        <div className="text-xs text-slate-600 tabular-nums whitespace-nowrap">
          <span className="font-semibold text-slate-900">单品明细</span>
          <span className="mx-1 text-slate-300" aria-hidden="true">
            ·
          </span>
          <span>{items.length} 项</span>
          {lockedCount > 0 && (
            <>
              <span className="mx-1 text-slate-300" aria-hidden="true">
                ·
              </span>
              <span className="text-amber-700 font-medium">已锁 {lockedCount}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => void runBatchPriceLookup(false)}
            disabled={items.length === 0 || isLookingUpPrices}
            title="并发检索闲鱼/煤炉近期单出市价并按真实市价比例重算未锁定项"
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold text-slate-800 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
          >
            {isLookingUpPrices ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Search className="w-3 h-3" />
            )}
            <span>{isLookingUpPrices ? '比价中' : '全团比价'}</span>
          </button>
          <button
            type="button"
            onClick={unlockAllItems}
            disabled={lockedCount === 0}
            className="px-1.5 py-1 rounded text-[11px] font-medium text-slate-600 hover:text-slate-950 hover:bg-slate-200/70 disabled:opacity-35 transition-colors whitespace-nowrap shrink-0"
          >
            全解锁
          </button>
          <button
            type="button"
            onClick={resetEqualWeights}
            disabled={items.length === 0}
            title="重置全部为均价权重"
            className="inline-flex items-center gap-0.5 px-1.5 py-1 rounded text-[11px] font-medium text-slate-600 hover:text-slate-950 hover:bg-slate-200/70 disabled:opacity-35 transition-colors whitespace-nowrap shrink-0"
          >
            <RotateCcw className="w-3 h-3" />
            <span>均分</span>
          </button>
        </div>
      </div>

      {/* Section 2 Body: Scrollable High-Density Item Rows */}
      <div className="flex-1 overflow-y-auto divide-y divide-[#EEF0F4]">
        {items.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 leading-relaxed">
            画布暂无打点单品。
            <br />
            点击顶部「AI 识图」「网格打点」或「手动加点」开始排价。
          </div>
        ) : (
          items.map((item) => {
            const isSelected = item.id === selectedItemId;
            const isExpanded = expandedId === item.id;
            const isItemLookingUp = lookupItemIds.includes(item.id);
            const mp = item.marketPrice;

            return (
              <div
                key={item.id}
                className={`transition-colors ${
                  isSelected ? 'bg-slate-100/90' : 'hover:bg-slate-50/80'
                }`}
              >
                <div className="px-3 py-2.5 flex items-center gap-1.5">
                  {/* Expand details toggle */}
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : item.id)}
                    aria-label={`展开 ${item.label} 详情与比价来源`}
                    aria-expanded={isExpanded}
                    className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 shrink-0"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5" />
                    )}
                  </button>

                  {/* Lock toggle */}
                  <button
                    type="button"
                    onClick={() => toggleItemLock(item.id)}
                    aria-label={`${item.locked ? '解锁' : '锁定'} ${item.label}`}
                    className={`p-1.5 rounded-md transition-colors shrink-0 ${
                      item.locked
                        ? 'text-amber-700 bg-amber-50 hover:bg-amber-100'
                        : 'text-slate-400 hover:text-slate-700 hover:bg-slate-200/60'
                    }`}
                  >
                    {item.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                  </button>

                  {/* Name & clean unboxed metadata line */}
                  <div
                    className="min-w-0 flex-1 cursor-pointer"
                    onClick={() => setSelectedItemId(item.id)}
                  >
                    <div className="flex items-center gap-1 min-w-0">
                      <input
                        type="text"
                        aria-label={`角色名 ${item.label}`}
                        value={item.label}
                        onChange={(e) => updateItemField(item.id, { label: e.target.value })}
                        onClick={(e) => e.stopPropagation()}
                        className="min-w-0 flex-1 text-xs font-semibold text-slate-900 bg-transparent focus:bg-white focus:ring-1 focus:ring-slate-300 rounded px-1 -mx-1 py-0.5 focus:outline-none truncate"
                      />
                      {item.tag && item.quantity > 0 && (
                        <span className="text-[11px] font-medium text-slate-600 shrink-0 whitespace-nowrap">
                          {item.tag}
                        </span>
                      )}
                      {item.quantity !== 1 && (
                        <span
                          className={`text-[11px] font-mono font-semibold shrink-0 whitespace-nowrap ${
                            item.quantity === 0 ? 'text-slate-400' : 'text-rose-600'
                          }`}
                        >
                          {item.quantity === 0 ? '未出' : `×${item.quantity}`}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 flex items-center gap-1 font-mono tabular-nums whitespace-nowrap overflow-hidden">
                      <span className="shrink-0">w:{item.weight.toFixed(2)}</span>
                      {mp?.marketPriceMedian !== null && mp?.marketPriceMedian !== undefined ? (
                        <>
                          <span aria-hidden="true" className="shrink-0">·</span>
                          <span className="text-emerald-700 font-sans font-medium truncate">
                            市价 ¥{formatMoney(mp.marketPriceMedian)} ({mp.sampleCount}条)
                          </span>
                        </>
                      ) : item.weightSource === 'market_db' ? (
                        <>
                          <span aria-hidden="true" className="shrink-0">·</span>
                          <span className="text-emerald-700 font-sans shrink-0">历史行情</span>
                        </>
                      ) : null}
                    </div>
                  </div>

                  {/* Stepper + Direct Price Input */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => adjustItemPriceStep(item.id, -cost.step)}
                      aria-label={`${item.label} 减价 ${cost.step}`}
                      className="w-6 h-7 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-mono text-xs font-semibold transition-colors"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={0}
                      step={cost.step}
                      aria-label={`${item.label} 单价`}
                      value={item.price}
                      onChange={(e) => {
                        const val = Number.parseFloat(e.target.value);
                        if (Number.isFinite(val)) {
                          updateItemPriceAndLock(item.id, val);
                        }
                      }}
                      className="w-14 h-7 px-1 rounded border border-slate-200 text-xs font-mono font-bold text-slate-950 text-right tabular-nums focus:outline-none focus:border-slate-900 bg-white"
                    />
                    <button
                      type="button"
                      onClick={() => adjustItemPriceStep(item.id, cost.step)}
                      aria-label={`${item.label} 加价 ${cost.step}`}
                      className="w-6 h-7 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-mono text-xs font-semibold transition-colors"
                    >
                      +
                    </button>
                  </div>
                </div>

                {/* Expanded Item Advanced Controls + Market Traceability */}
                {isExpanded && (
                  <div className="px-4 pb-3.5 pt-2 bg-slate-50/70 space-y-2.5 text-xs border-t border-slate-100">
                    {/* Market Reference Traceability Block */}
                    <div className="space-y-1.5 pb-2 border-b border-slate-200/70">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[11px] text-slate-600 tabular-nums">
                          {mp && mp.marketPriceMedian !== null ? (
                            <>
                              <strong className="text-slate-900">
                                参考中位 ¥{formatMoney(mp.marketPriceMedian)}
                              </strong>
                              {mp.marketPriceRange && (
                                <span>
                                  {' '}
                                  (¥{formatMoney(mp.marketPriceRange[0])}~¥{formatMoney(mp.marketPriceRange[1])})
                                </span>
                              )}
                              <span> · {mp.sampleCount}条样本 · {formatFreshnessText(mp.freshness)}</span>
                            </>
                          ) : (
                            <span className="text-slate-500">
                              暂无外部二手单出样本，可补充系列关键词后重新比价
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          disabled={isItemLookingUp}
                          onClick={() =>
                            void runSingleItemPriceLookup(item.id, {
                              seriesHint: item.seriesHint,
                              jpKeywords: item.jpKeywords,
                              forceRefresh: true,
                            })
                          }
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold text-slate-800 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-45 whitespace-nowrap shrink-0"
                        >
                          <RefreshCw className={`w-3 h-3 ${isItemLookingUp ? 'animate-spin' : ''}`} />
                          <span>{isItemLookingUp ? '查询中' : '重新比价'}</span>
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-1.5">
                        <div>
                          <label className="block text-[10px] text-slate-500 mb-0.5">
                            系列 / 柄图特征
                          </label>
                          <input
                            type="text"
                            placeholder="如：原画展吧唧"
                            value={item.seriesHint ?? ''}
                            onChange={(e) => updateItemField(item.id, { seriesHint: e.target.value })}
                            className="w-full px-2 py-1 rounded border border-slate-200 bg-white text-[11px] text-slate-900"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-500 mb-0.5">
                            煤炉日文检索词
                          </label>
                          <input
                            type="text"
                            placeholder="如：ハイキュー 孤爪研磨 缶バッジ"
                            value={item.jpKeywords ?? ''}
                            onChange={(e) => updateItemField(item.id, { jpKeywords: e.target.value })}
                            className="w-full px-2 py-1 rounded border border-slate-200 bg-white text-[11px] text-slate-900"
                          />
                        </div>
                      </div>

                      {mp && mp.sources.length > 0 && (
                        <div className="pt-1 space-y-1">
                          <div className="text-[10px] font-medium text-slate-500">
                            比价参考来源明细：
                          </div>
                          {mp.sources.slice(0, 4).map((src, sIdx) => {
                            const safeHref = sanitizeSafeHref(src.url);
                            return (
                              <div
                                key={`${src.platform}-${sIdx}`}
                                className="flex items-center justify-between gap-2 text-[11px] text-slate-600"
                              >
                                <div className="min-w-0 truncate">
                                  <span className="font-medium text-slate-800">{src.platform}</span>
                                  <span className="mx-1 text-slate-300">·</span>
                                  {safeHref ? (
                                    <a
                                      href={safeHref}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="hover:text-slate-950 hover:underline inline-flex items-center gap-0.5"
                                    >
                                      <span className="truncate max-w-[140px]">{src.title}</span>
                                      <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                                    </a>
                                  ) : (
                                    <span>{src.title}</span>
                                  )}
                                </div>
                                <span className="font-mono tabular-nums text-slate-800 shrink-0">
                                  {src.currency === 'JPY'
                                    ? `¥${src.rawPrice}円≈¥${formatMoney(src.cnyPrice)}`
                                    : `¥${formatMoney(src.cnyPrice)}`}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Weight (0.1 ~ 10.0), Quantity & Tag */}
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[10px] text-slate-500 mb-0.5">
                          权重 (0.1~10)
                        </label>
                        <input
                          type="number"
                          step={0.05}
                          min={WEIGHT_MIN}
                          max={WEIGHT_MAX}
                          value={item.weight}
                          onChange={(e) => {
                            const v = Number.parseFloat(e.target.value);
                            if (Number.isFinite(v)) updateItemField(item.id, { weight: v });
                          }}
                          className="w-full px-2 py-1 rounded border border-slate-200 bg-white font-mono text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-500 mb-0.5">数量 (二调)</label>
                        <input
                          type="number"
                          min={0}
                          max={99}
                          step={1}
                          value={item.quantity}
                          onChange={(e) => {
                            const v = Number.parseInt(e.target.value, 10);
                            if (Number.isFinite(v)) updateItemField(item.id, { quantity: Math.max(0, v) });
                          }}
                          className="w-full px-2 py-1 rounded border border-slate-200 bg-white font-mono text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-500 mb-0.5">拼团标记</label>
                        <select
                          value={item.tag}
                          onChange={(e) => updateItemField(item.id, { tag: e.target.value as PinTag })}
                          className="w-full px-1.5 py-1 rounded border border-slate-200 bg-white text-xs"
                        >
                          {PIN_TAGS.map((t) => (
                            <option key={t || 'none'} value={t}>
                              {t || '无'}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] text-slate-500 mb-0.5">保底价 (¥)</label>
                        <input
                          type="number"
                          min={0}
                          placeholder="不限"
                          value={item.minPrice ?? ''}
                          onChange={(e) => {
                            const raw = e.target.value.trim();
                            updateItemField(item.id, {
                              minPrice: raw === '' ? undefined : Math.max(0, Number(raw) || 0),
                            });
                          }}
                          className="w-full px-2 py-1 rounded border border-slate-200 bg-white font-mono text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-500 mb-0.5">封顶价 (¥)</label>
                        <input
                          type="number"
                          min={0}
                          placeholder="不限"
                          value={item.maxPrice ?? ''}
                          onChange={(e) => {
                            const raw = e.target.value.trim();
                            updateItemField(item.id, {
                              maxPrice: raw === '' ? undefined : Math.max(0, Number(raw) || 0),
                            });
                          }}
                          className="w-full px-2 py-1 rounded border border-slate-200 bg-white font-mono text-xs tabular-nums"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => void handleCrop(item.id)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 whitespace-nowrap shrink-0"
                      >
                        <Scissors className="w-3 h-3" />
                        <span>裁切查价</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteItem(item.id)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 whitespace-nowrap shrink-0"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>删除单品</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};
