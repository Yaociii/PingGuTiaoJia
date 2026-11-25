import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  Database,
  ExternalLink,
  Lock,
  RefreshCw,
  Scissors,
  Trash2,
  Unlock,
  Upload,
  X,
} from 'lucide-react';
import { usePricerStore } from '../store/usePricerStore';
import { calcEffectiveAvgPrice, formatMoney } from '../core/rebalancer';
import {
  copyPngBlobToClipboard,
  cropSingleItemToBlob,
  getPriceTemperature,
  triggerBlobDownload,
} from '../core/canvasExport';
import { PIN_TAGS, type GoodItem, type PinTag } from '../types/pricing';
import { sanitizeSafeHref } from '../api/client';

export const PricingCanvas: React.FC = () => {
  const initialized = usePricerStore((s) => s.initialized);
  const activeProject = usePricerStore((s) => s.activeProject);
  const rebalance = usePricerStore((s) => s.rebalance);
  const selectedItemId = usePricerStore((s) => s.selectedItemId);
  const setSelectedItemId = usePricerStore((s) => s.setSelectedItemId);
  const canvasMode = usePricerStore((s) => s.canvasMode);
  const setCanvasMode = usePricerStore((s) => s.setCanvasMode);
  const addPinAt = usePricerStore((s) => s.addPinAt);
  const movePinPosition = usePricerStore((s) => s.movePinPosition);
  const adjustItemPriceStep = usePricerStore((s) => s.adjustItemPriceStep);
  const updateItemPriceAndLock = usePricerStore((s) => s.updateItemPriceAndLock);
  const toggleItemLock = usePricerStore((s) => s.toggleItemLock);
  const updateItemField = usePricerStore((s) => s.updateItemField);
  const deleteItem = usePricerStore((s) => s.deleteItem);
  const loadImageIntoActiveProject = usePricerStore((s) => s.loadImageIntoActiveProject);
  const lookupItemIds = usePricerStore((s) => s.lookupItemIds);
  const runSingleItemPriceLookup = usePricerStore((s) => s.runSingleItemPriceLookup);
  const exportConfig = usePricerStore((s) => s.settings.exportConfig);
  const notify = usePricerStore((s) => s.notify);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [showPopoverSources, setShowPopoverSources] = useState(false);
  const [draggingPin, setDraggingPin] = useState<{
    id: string;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);

  const items = rebalance.items;
  const avgPrice = calcEffectiveAvgPrice(items);
  const selectedItem: GoodItem | null = items.find((it) => it.id === selectedItemId) ?? null;
  const validQty = items.reduce((sum, it) => sum + (it.quantity > 0 ? it.quantity : 0), 0);

  useEffect(() => {
    setShowPopoverSources(false);
  }, [selectedItemId]);

  // Pointer drag handling for moving capsules without modifying box
  useEffect(() => {
    if (!draggingPin) return;

    const handlePointerMove = (e: PointerEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      const dist = Math.hypot(
        e.clientX - draggingPin.startClientX,
        e.clientY - draggingPin.startClientY
      );
      if (dist < 4 && !draggingPin.moved) return;

      const rect = stage.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / Math.max(1, rect.width);
      const ny = (e.clientY - rect.top) / Math.max(1, rect.height);
      if (!draggingPin.moved) {
        setDraggingPin((prev) => (prev ? { ...prev, moved: true } : null));
      }
      movePinPosition(draggingPin.id, nx, ny, false);
    };

    const handlePointerUp = () => {
      setDraggingPin(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [draggingPin, movePinPosition]);

  const handleImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      notify('请选择 PNG / JPG / WEBP 图片文件。', 'warning');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        void loadImageIntoActiveProject(reader.result, file.name);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (canvasMode === 'add_pin' && stageRef.current) {
      const rect = stageRef.current.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / Math.max(1, rect.width);
      const ny = (e.clientY - rect.top) / Math.max(1, rect.height);
      addPinAt(nx, ny);
      return;
    }
    if (e.target === e.currentTarget) {
      setSelectedItemId(null);
    }
  };

  const handleCropSingleItem = async (item: GoodItem) => {
    if (!activeProject?.imageDataUrl) return;
    try {
      const blob = await cropSingleItemToBlob(activeProject.imageDataUrl, item);
      const result = await copyPngBlobToClipboard(blob);
      if (result === 'copied') {
        notify(`已将「${item.label}」单谷裁图复制到剪贴板，可直接去查价。`, 'success');
      } else {
        triggerBlobDownload(blob, `${item.label || '单谷'}-裁图.png`);
        notify(`浏览器剪贴板受限，已为您下载「${item.label}」单谷裁图。`, 'info');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : '单谷裁切失败', 'error');
    }
  };

  const isSelectedLookingUp = selectedItem ? lookupItemIds.includes(selectedItem.id) : false;

  return (
    <main
      className="flex-1 min-w-0 flex flex-col studio-dot-grid relative overflow-hidden"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingFile(true);
      }}
      onDragLeave={() => setIsDraggingFile(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDraggingFile(false);
        const file = e.dataTransfer.files?.[0];
        if (file) handleImageFile(file);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleImageFile(file);
          e.target.value = '';
        }}
      />

      {/* Top subtle floating mode bar when image exists */}
      {activeProject?.imageDataUrl && (
        <div className="px-5 pt-3 pb-1 flex items-center justify-between gap-4 text-xs text-slate-500">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate">
              {canvasMode === 'add_pin'
                ? '加点模式：点击图中任意谷子位置即可新增价格胶囊'
                : '提示：拖拽胶囊可防挡脸，点击胶囊查看二手参考市价并快捷锁价平账'}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {canvasMode === 'add_pin' && (
              <button
                type="button"
                onClick={() => setCanvasMode('select')}
                className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-900 text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                完成加点
              </button>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-slate-600 bg-white border border-slate-200 hover:text-slate-950 hover:border-slate-300 transition-colors whitespace-nowrap shrink-0"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>更换原图</span>
            </button>
          </div>
        </div>
      )}

      {/* Main viewport stage */}
      <div className="flex-1 min-h-0 flex items-center justify-center p-4 lg:p-6 overflow-auto">
        {!initialized ? (
          <div className="w-full max-w-2xl aspect-[4/3] rounded-2xl bg-white/80 border border-slate-200 animate-pulse" />
        ) : !activeProject?.imageDataUrl ? (
          <div
            className={`w-full max-w-lg rounded-2xl border-2 border-dashed p-10 text-center bg-white transition-colors ${
              isDraggingFile ? 'border-rose-500 bg-rose-50/40' : 'border-slate-300'
            }`}
          >
            <div className="mx-auto w-12 h-12 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center mb-4">
              <ClipboardPaste className="w-6 h-6" />
            </div>
            <h1 className="text-lg font-bold text-slate-950">粘贴截图或拖入谷子平铺图</h1>
            <p className="mt-2 text-sm text-slate-500 leading-relaxed">
              直接从 QQ / 微信截图后按 <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono text-xs text-slate-700">Ctrl+V</kbd> 粘贴，即可使用 AI 识图、闲鱼/煤炉自动比价与总价平账。
            </p>
            <div className="mt-6 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold text-white bg-slate-950 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <Upload className="w-4 h-4" />
                <span>选择本地图片</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center max-w-full">
            {/* Image + Overlay Container */}
            <div
              ref={stageRef}
              data-testid="pricing-canvas-stage"
              onClick={handleStageClick}
              className={`relative inline-block rounded-t-xl overflow-visible bg-white shadow-sm border border-slate-200/90 select-none ${
                canvasMode === 'add_pin' ? 'cursor-crosshair' : 'cursor-default'
              }`}
            >
              <img
                src={activeProject.imageDataUrl}
                alt={activeProject.name}
                referrerPolicy="no-referrer"
                draggable={false}
                className="block max-h-[calc(100vh-205px)] max-w-full w-auto h-auto rounded-t-xl pointer-events-none"
              />

              {/* Interactive Draggable Price Capsules */}
              {items.map((item) => {
                const isSelected = item.id === selectedItemId;
                const temp = getPriceTemperature(item.price, avgPrice, item.quantity);

                let capsuleTone =
                  'bg-white text-slate-950 border-slate-900/20 hover:border-slate-900/50';
                if (temp === 'hot') {
                  capsuleTone = 'bg-[#E11D48] text-white border-white/50';
                } else if (temp === 'cold') {
                  capsuleTone = 'bg-[#2563EB] text-white border-white/50';
                } else if (temp === 'zero') {
                  capsuleTone = 'bg-slate-600 text-slate-200 border-white/30 opacity-85';
                }

                const priceLabel = item.quantity <= 0 ? '未出' : `¥${formatMoney(item.price)}`;
                const showName = exportConfig.displayMode === 'label_and_price' && Boolean(item.label);

                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`pin-${item.id}`}
                    aria-label={`调整 ${item.label} 价格 ${priceLabel}${item.locked ? ' 已锁定' : ''}`}
                    style={{
                      left: `${item.x * 100}%`,
                      top: `${item.y * 100}%`,
                    }}
                    onPointerDown={(e) => {
                      if (canvasMode === 'add_pin') return;
                      e.stopPropagation();
                      setDraggingPin({
                        id: item.id,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        moved: false,
                      });
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (draggingPin?.moved) return;
                      setSelectedItemId(isSelected ? null : item.id);
                    }}
                    className={`absolute -translate-x-1/2 -translate-y-1/2 inline-flex items-center gap-1 px-2.5 py-1 rounded-full border shadow-md text-xs font-bold whitespace-nowrap transition-transform cursor-grab active:cursor-grabbing focus-visible:outline-none ${capsuleTone} ${
                      isSelected ? 'ring-3 ring-slate-950/90 scale-105 z-30' : 'z-10 hover:scale-105'
                    }`}
                  >
                    {item.locked && <Lock className="w-3 h-3 shrink-0 opacity-90" />}
                    {showName && <span className="max-w-[78px] truncate">{item.label}</span>}
                    <span className="font-mono tabular-nums">{priceLabel}</span>
                    {item.quantity > 1 && (
                      <span className="font-mono text-[10px] opacity-90">×{item.quantity}</span>
                    )}
                    {exportConfig.showTag && item.tag && item.quantity > 0 && (
                      <span className="ml-0.5 px-1.5 py-0.2 rounded-full text-[10px] font-semibold bg-black/20 text-current">
                        {item.tag}
                      </span>
                    )}
                    {(item.weightSource === 'market_lookup' || item.weightSource === 'market_db') && (
                      <span
                        title={
                          item.marketPrice?.marketPriceMedian
                            ? `闲鱼/煤炉参考中位价 ¥${formatMoney(item.marketPrice.marketPriceMedian)}`
                            : '热度来自历史成团行情库'
                        }
                        className="inline-flex items-center opacity-85"
                      >
                        <Database className="w-2.5 h-2.5" />
                      </span>
                    )}
                  </button>
                );
              })}

              {/* Anchored Quick-Price & Market Traceability Popover */}
              {selectedItem && (
                <div
                  role="dialog"
                  aria-label={`${selectedItem.label} 快捷调价`}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    left: `${Math.min(75, Math.max(25, selectedItem.x * 100))}%`,
                    top:
                      selectedItem.y > 0.52
                        ? `calc(${selectedItem.y * 100}% - 28px)`
                        : `calc(${selectedItem.y * 100}% + 26px)`,
                  }}
                  className={`absolute -translate-x-1/2 ${
                    selectedItem.y > 0.52 ? '-translate-y-full' : ''
                  } w-[296px] bg-white rounded-xl border border-slate-200 shadow-xl p-3.5 z-40 text-left`}
                >
                  <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-100">
                    <input
                      type="text"
                      aria-label="编辑角色名称"
                      value={selectedItem.label}
                      onChange={(e) => updateItemField(selectedItem.id, { label: e.target.value })}
                      className="text-sm font-semibold text-slate-950 bg-transparent border border-transparent hover:border-slate-200 focus:border-slate-400 focus:bg-slate-50 rounded px-1.5 py-0.5 w-full focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setSelectedItemId(null)}
                      aria-label="关闭快捷调价弹窗"
                      className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 shrink-0"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* V2.0 Market Reference Summary & Re-lookup */}
                  <div className="mt-2.5 pb-2.5 border-b border-slate-100 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <div className="text-slate-600 tabular-nums min-w-0 truncate">
                        {selectedItem.marketPrice?.marketPriceMedian !== null &&
                        selectedItem.marketPrice?.marketPriceMedian !== undefined ? (
                          <>
                            <span className="font-semibold text-emerald-700">
                              闲鱼/煤炉均价 ¥{formatMoney(selectedItem.marketPrice.marketPriceMedian)}
                            </span>
                            <span className="text-slate-400">
                              {' '}
                              · 样本 {selectedItem.marketPrice.sampleCount} 条
                            </span>
                          </>
                        ) : (
                          <span className="text-slate-500">暂无近期二手市价样本</span>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={isSelectedLookingUp}
                        onClick={() =>
                          void runSingleItemPriceLookup(selectedItem.id, {
                            seriesHint: selectedItem.seriesHint,
                            jpKeywords: selectedItem.jpKeywords,
                            forceRefresh: true,
                          })
                        }
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-800 hover:text-slate-950 whitespace-nowrap shrink-0"
                      >
                        <RefreshCw
                          className={`w-3 h-3 ${isSelectedLookingUp ? 'animate-spin' : ''}`}
                        />
                        <span>{isSelectedLookingUp ? '比价中' : '重新比价'}</span>
                      </button>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        aria-label="微调系列或柄图关键词"
                        placeholder="补充系列特征（如：原画展吧唧）"
                        value={selectedItem.seriesHint ?? ''}
                        onChange={(e) =>
                          updateItemField(selectedItem.id, { seriesHint: e.target.value })
                        }
                        className="flex-1 px-2 py-1 rounded border border-slate-200 text-[11px] text-slate-800 focus:outline-none focus:border-slate-900"
                      />
                      {selectedItem.marketPrice && selectedItem.marketPrice.sources.length > 0 && (
                        <button
                          type="button"
                          aria-expanded={showPopoverSources}
                          onClick={() => setShowPopoverSources((v) => !v)}
                          className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-[11px] font-medium text-slate-700 whitespace-nowrap shrink-0"
                        >
                          {showPopoverSources ? '收起来源' : '查看来源'}
                        </button>
                      )}
                    </div>

                    {showPopoverSources && selectedItem.marketPrice && (
                      <div className="pt-1 space-y-1 max-h-28 overflow-y-auto">
                        {selectedItem.marketPrice.sources.map((src, idx) => {
                          const safeHref = sanitizeSafeHref(src.url);
                          return (
                            <div
                              key={`${src.platform}-${idx}`}
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
                                    <span className="truncate max-w-[130px]">{src.title}</span>
                                    <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                                  </a>
                                ) : (
                                  <span>{src.title}</span>
                                )}
                              </div>
                              <span className="font-mono tabular-nums text-slate-900 shrink-0">
                                ¥{formatMoney(src.cnyPrice)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Quick Step Price Buttons (Auto-Lock!) */}
                  <div className="mt-2.5">
                    <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1.5">
                      <span>单价（修改即自动锁定）</span>
                      <span className="font-mono tabular-nums">
                        权重 {selectedItem.weight.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => adjustItemPriceStep(selectedItem.id, -5)}
                        className="px-2 py-1.5 rounded-md text-xs font-mono font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
                      >
                        -5
                      </button>
                      <button
                        type="button"
                        onClick={() => adjustItemPriceStep(selectedItem.id, -1)}
                        className="px-2 py-1.5 rounded-md text-xs font-mono font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
                      >
                        -1
                      </button>
                      <div className="relative flex-1">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-mono">
                          ¥
                        </span>
                        <input
                          type="number"
                          min={0}
                          step={activeProject.cost.step}
                          aria-label="快捷输入单价"
                          value={selectedItem.price}
                          onChange={(e) => {
                            const val = Number.parseFloat(e.target.value);
                            if (Number.isFinite(val)) {
                              updateItemPriceAndLock(selectedItem.id, val);
                            }
                          }}
                          className="w-full pl-5 pr-2 py-1.5 rounded-md border border-slate-200 text-xs font-mono font-bold text-slate-950 text-center tabular-nums focus:outline-none focus:border-slate-900"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => adjustItemPriceStep(selectedItem.id, 1)}
                        className="px-2 py-1.5 rounded-md text-xs font-mono font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
                      >
                        +1
                      </button>
                      <button
                        type="button"
                        onClick={() => adjustItemPriceStep(selectedItem.id, 5)}
                        className="px-2 py-1.5 rounded-md text-xs font-mono font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
                      >
                        +5
                      </button>
                    </div>
                  </div>

                  {/* Tags selector */}
                  <div className="mt-2.5">
                    <div className="text-[11px] text-slate-500 mb-1">拼团标记</div>
                    <div className="grid grid-cols-6 gap-1">
                      {PIN_TAGS.map((tag: PinTag) => {
                        const active = selectedItem.tag === tag;
                        return (
                          <button
                            key={tag || 'none'}
                            type="button"
                            onClick={() => updateItemField(selectedItem.id, { tag })}
                            className={`py-1 rounded text-[11px] font-medium transition-colors whitespace-nowrap ${
                              active
                                ? 'bg-slate-900 text-white'
                                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                            }`}
                          >
                            {tag || '无'}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Action footer: Lock / Crop / Delete */}
                  <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between gap-1.5">
                    <button
                      type="button"
                      onClick={() => toggleItemLock(selectedItem.id)}
                      className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        selectedItem.locked
                          ? 'bg-amber-50 text-amber-800 hover:bg-amber-100'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                      }`}
                    >
                      {selectedItem.locked ? (
                        <>
                          <Lock className="w-3 h-3" />
                          <span>已锁定</span>
                        </>
                      ) : (
                        <>
                          <Unlock className="w-3 h-3" />
                          <span>锁定</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleCropSingleItem(selectedItem)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Scissors className="w-3 h-3" />
                      <span>裁切查价</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => deleteItem(selectedItem.id)}
                      aria-label={`删除 ${selectedItem.label}`}
                      className="p-1.5 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Dark Reconciliation Footer Bar directly beneath image */}
            <div
              data-testid="reconciliation-bar"
              className="w-full bg-[#0F172A] text-slate-100 rounded-b-xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 border-x border-b border-slate-900"
            >
              <div className="flex items-center gap-3 text-xs tabular-nums flex-wrap">
                <span className="font-semibold text-white">
                  {activeProject.ipName || '未填作品'}
                </span>
                <span className="text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span className="text-slate-300">
                  有效 <strong className="font-mono text-white">{validQty}</strong> 件
                </span>
                <span className="text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span className="text-slate-300">
                  均价 <strong className="font-mono text-white">¥{formatMoney(avgPrice)}</strong>
                </span>
                <span className="text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span className="text-slate-300">
                  预期总价{' '}
                  <strong className="font-mono text-white">
                    ¥{formatMoney(rebalance.targetTotal)}
                  </strong>
                </span>
                <span className="text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span className="text-slate-300">
                  当前合计{' '}
                  <strong className="font-mono text-white">
                    ¥{formatMoney(rebalance.actualTotal)}
                  </strong>
                </span>
              </div>

              <div className="shrink-0">
                {rebalance.status === 'OK' && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>严丝合缝</span>
                  </span>
                )}
                {rebalance.status === 'LOCKED_EXCEEDS_TARGET' && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-400">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>锁定超额 +¥{formatMoney(rebalance.exceedAmount)}</span>
                  </span>
                )}
                {(rebalance.status === 'RESIDUAL_NONZERO' ||
                  rebalance.status === 'NO_UNLOCKED_ITEMS') && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>
                      余差 {rebalance.residual > 0 ? '+' : ''}¥{formatMoney(rebalance.residual)}
                    </span>
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
};
