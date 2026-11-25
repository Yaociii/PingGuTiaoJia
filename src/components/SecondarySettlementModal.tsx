import React, { useEffect, useMemo, useState } from 'react';
import { Calculator, Check, Copy, Layers, X } from 'lucide-react';
import { usePricerStore } from '../store/usePricerStore';
import { calcSecondarySettlement, formatMoney } from '../core/rebalancer';

interface SecondarySettlementModalProps {
  open: boolean;
  onClose: () => void;
}

export const SecondarySettlementModal: React.FC<SecondarySettlementModalProps> = ({
  open,
  onClose,
}) => {
  const activeProject = usePricerStore((s) => s.activeProject);
  const rebalance = usePricerStore((s) => s.rebalance);
  const updateItemField = usePricerStore((s) => s.updateItemField);
  const updateItemPriceAndLock = usePricerStore((s) => s.updateItemPriceAndLock);
  const applyBlindBoxPreset = usePricerStore((s) => s.applyBlindBoxPreset);
  const notify = usePricerStore((s) => s.notify);

  const [copied, setCopied] = useState(false);
  const [boxCount, setBoxCount] = useState<number>(3);
  const [expectedTotalQty, setExpectedTotalQty] = useState<number>(0);
  const [scaleTargetTotal, setScaleTargetTotal] = useState<boolean>(true);

  const items = rebalance.items;

  // Initialize expectedTotalQty when modal opens or project switches
  useEffect(() => {
    if (!open || !activeProject) return;
    const sumQty = activeProject.items.reduce((acc, it) => acc + Math.max(0, it.quantity), 0);
    setExpectedTotalQty(sumQty > 0 ? sumQty : activeProject.items.length);
  }, [open, activeProject?.id]);

  const settlement = useMemo(
    () => calcSecondarySettlement(items, activeProject?.name || '本团'),
    [items, activeProject?.name]
  );

  const actualTotalQty = useMemo(
    () => items.reduce((sum, it) => sum + Math.max(0, it.quantity), 0),
    [items]
  );
  const diffQty = actualTotalQty - expectedTotalQty;

  if (!open || !activeProject) return null;

  const handleApplyBoxesPreset = () => {
    const safeBoxes = Math.max(1, Math.min(99, Math.floor(boxCount || 1)));
    setBoxCount(safeBoxes);
    const nextExpected = items.length * safeBoxes;
    setExpectedTotalQty(nextExpected);
    applyBlindBoxPreset({
      mode: 'boxes',
      boxCount: safeBoxes,
      scaleTargetTotal,
      snapshotPrepaid: true,
    });
    notify(
      `已按 ${safeBoxes} 端盒均分出货量（每款 ${safeBoxes} 件，预期共 ${nextExpected} 件）并快照原预收价。`,
      'success'
    );
  };

  const handleApplyDrawsPreset = () => {
    const safeDraws = Math.max(1, Math.min(999, Math.floor(expectedTotalQty || items.length)));
    setExpectedTotalQty(safeDraws);
    applyBlindBoxPreset({
      mode: 'total_draws',
      totalDraws: safeDraws,
      snapshotPrepaid: true,
    });
    notify(`已将 ${safeDraws} 抽均匀分配至各款式并快照原预收价。`, 'success');
  };

  const handleCopyAnnouncement = async () => {
    try {
      await navigator.clipboard.writeText(settlement.announcementText);
      setCopied(true);
      notify('已复制二调结算群公告到剪贴板。', 'success');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      notify('剪贴板写入受限，请手动全选复制下方公告文本。', 'warning');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/45 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settlement-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl max-h-[90vh] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <Calculator className="w-4 h-4 text-slate-700" />
            <h2 id="settlement-modal-title" className="text-sm font-bold text-slate-950">
              盲抽配比二调与退补结算
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭盲抽二调弹窗"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Phase 2: Box-Count Preset & Quick Even Distribution */}
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label
                    htmlFor="settlement-box-count"
                    className="block text-[11px] font-semibold text-slate-600 mb-1"
                  >
                    端盒数（boxCount）
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      id="settlement-box-count"
                      type="number"
                      min={1}
                      max={99}
                      value={boxCount}
                      onChange={(e) => {
                        const v = Math.max(1, Math.min(99, Number.parseInt(e.target.value, 10) || 1));
                        setBoxCount(v);
                        setExpectedTotalQty(items.length * v);
                      }}
                      className="w-20 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-mono font-semibold text-slate-950 tabular-nums focus:outline-none focus:border-slate-900"
                    />
                    <span className="text-xs text-slate-500 whitespace-nowrap">
                      盒 × {items.length} 款
                    </span>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="settlement-expected-qty"
                    className="block text-[11px] font-semibold text-slate-600 mb-1"
                  >
                    预期总件数（散抽可改）
                  </label>
                  <input
                    id="settlement-expected-qty"
                    type="number"
                    min={1}
                    max={999}
                    value={expectedTotalQty}
                    onChange={(e) => {
                      const v = Math.max(0, Math.min(999, Number.parseInt(e.target.value, 10) || 0));
                      setExpectedTotalQty(v);
                    }}
                    className="w-24 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-mono font-semibold text-slate-950 tabular-nums focus:outline-none focus:border-slate-900"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleApplyBoxesPreset}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-white bg-slate-950 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>按端盒数一键均分</span>
                </button>
                {expectedTotalQty > 0 && expectedTotalQty !== items.length * boxCount && (
                  <button
                    type="button"
                    onClick={handleApplyDrawsPreset}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-slate-800 bg-white border border-slate-200 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
                  >
                    <span>按预期总件数均分</span>
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/80 text-xs">
              <label className="inline-flex items-center gap-2 text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={scaleTargetTotal}
                  onChange={(e) => setScaleTargetTotal(e.target.checked)}
                  className="rounded border-slate-300 accent-slate-950 w-3.5 h-3.5"
                />
                <span>均分时按端盒倍数同步重算目标总价，并自动快照当前单价为原预收价</span>
              </label>
              <span className="text-[11px] text-slate-500">
                提示：先一键均分基准数量，再用行内 [-1] / [+1] / [置0未出] 微调盲抽偏差
              </span>
            </div>
          </div>

          {/* Persistent Real-time Quantity Verification & Financial Balance Strip */}
          <div
            role="status"
            aria-live="polite"
            className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white flex flex-wrap items-center justify-between gap-3 text-xs tabular-nums"
          >
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="font-mono font-semibold text-slate-900">
                当前录入总件数 {actualTotalQty} / 预期总件数 {expectedTotalQty}（差额{' '}
                {diffQty > 0 ? `+${diffQty}` : `${diffQty}`}）
              </span>
              <span className="text-slate-300" aria-hidden="true">
                ·
              </span>
              {diffQty === 0 ? (
                <span className="font-medium text-emerald-700">✓ 出货件数核对一致</span>
              ) : diffQty > 0 ? (
                <span className="font-medium text-amber-700">
                  ⚠ 比预期多录 {diffQty} 件，请核对复数角色
                </span>
              ) : (
                <span className="font-medium text-rose-700">
                  ⚠ 比预期少录 {Math.abs(diffQty)} 件，请核对漏录款式
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 flex-wrap text-slate-600">
              <span>
                目标总价{' '}
                <strong className="font-mono text-slate-950">
                  ¥{formatMoney(rebalance.targetTotal)}
                </strong>
              </span>
              <span className="text-slate-300" aria-hidden="true">
                ·
              </span>
              <span>
                原预收{' '}
                <strong className="font-mono text-slate-950">
                  ¥{formatMoney(settlement.totalPrepaid)}
                </strong>
              </span>
              <span className="text-slate-300" aria-hidden="true">
                ·
              </span>
              <span>
                二调合计{' '}
                <strong className="font-mono text-slate-950">
                  ¥{formatMoney(settlement.totalFinal)}
                </strong>
              </span>
              <span className="text-slate-300" aria-hidden="true">
                ·
              </span>
              <span className="font-mono font-semibold">
                {rebalance.status === 'OK' ? (
                  <span className="text-emerald-700">✓ 二调总账平齐</span>
                ) : (
                  <span className="text-amber-700">
                    ⚠ 余差 {rebalance.residual > 0 ? '+' : ''}¥{formatMoney(rebalance.residual)}
                  </span>
                )}
              </span>
            </div>
          </div>

          {/* Interactive Secondary Adjustment Table with Quick Steppers */}
          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                  <th className="py-2.5 px-3">角色 / 款式</th>
                  <th className="py-2.5 px-3 text-right">实际出货数（极速微调）</th>
                  <th className="py-2.5 px-3 text-right">原预收单价 (¥)</th>
                  <th className="py-2.5 px-3 text-right">二调单价 (¥)</th>
                  <th className="py-2.5 px-3 text-right">单件退补</th>
                  <th className="py-2.5 px-3 text-right">小计退补</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item) => {
                  const prepaid = item.prepaidPrice ?? settlement.avgPrice;
                  const delta = Math.round((item.price - prepaid) * 100) / 100;
                  const subDelta = Math.round(delta * item.quantity * 100) / 100;

                  return (
                    <tr
                      key={item.id}
                      className={
                        item.quantity === 0 ? 'bg-slate-50/70 text-slate-400' : 'hover:bg-slate-50/60'
                      }
                    >
                      <td className="py-2 px-3 font-medium text-slate-900 whitespace-nowrap">
                        {item.label}
                        {item.quantity === 0 && (
                          <span className="ml-2 text-[11px] text-slate-400">（未出货）</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <div className="inline-flex items-center justify-end gap-1">
                          <button
                            type="button"
                            disabled={item.quantity <= 0}
                            aria-label={`${item.label} 数量减1`}
                            onClick={() =>
                              updateItemField(item.id, { quantity: Math.max(0, item.quantity - 1) })
                            }
                            className="px-2 py-1 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-35 disabled:pointer-events-none font-mono font-semibold whitespace-nowrap shrink-0"
                          >
                            -1
                          </button>
                          <input
                            type="number"
                            min={0}
                            max={999}
                            aria-label={`${item.label} 实际数量`}
                            value={item.quantity}
                            onChange={(e) => {
                              const q = Math.max(0, Math.min(999, Number.parseInt(e.target.value, 10) || 0));
                              updateItemField(item.id, { quantity: q });
                            }}
                            className="w-14 px-1.5 py-1 rounded border border-slate-200 text-center font-mono font-semibold tabular-nums bg-white text-slate-900 focus:outline-none focus:border-slate-900"
                          />
                          <button
                            type="button"
                            aria-label={`${item.label} 数量加1`}
                            onClick={() =>
                              updateItemField(item.id, { quantity: Math.min(999, item.quantity + 1) })
                            }
                            className="px-2 py-1 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 font-mono font-semibold whitespace-nowrap shrink-0"
                          >
                            +1
                          </button>
                          <button
                            type="button"
                            disabled={item.quantity === 0}
                            aria-label={`${item.label} 置0未出`}
                            onClick={() => updateItemField(item.id, { quantity: 0 })}
                            className="px-2 py-1 rounded border border-slate-200 bg-slate-50 text-[11px] font-medium text-slate-600 hover:text-rose-700 hover:border-rose-200 hover:bg-rose-50 disabled:opacity-35 disabled:pointer-events-none whitespace-nowrap shrink-0"
                          >
                            置0未出
                          </button>
                        </div>
                      </td>
                      <td className="py-2 px-3 text-right">
                        <input
                          type="number"
                          min={0}
                          step={0.5}
                          aria-label={`${item.label} 原预收单价`}
                          value={item.prepaidPrice ?? settlement.avgPrice}
                          onChange={(e) => {
                            const val = Math.max(0, Number.parseFloat(e.target.value) || 0);
                            updateItemField(item.id, { prepaidPrice: val });
                          }}
                          className="w-20 px-2 py-1 rounded border border-slate-200 text-right font-mono tabular-nums bg-white text-slate-900 focus:outline-none focus:border-slate-900"
                        />
                      </td>
                      <td className="py-2 px-3 text-right">
                        <input
                          type="number"
                          min={0}
                          step={activeProject.cost.step}
                          disabled={item.quantity === 0}
                          aria-label={`${item.label} 二调单价`}
                          value={item.price}
                          onChange={(e) => {
                            const val = Number.parseFloat(e.target.value);
                            if (Number.isFinite(val)) {
                              updateItemPriceAndLock(item.id, val);
                            }
                          }}
                          className="w-20 px-2 py-1 rounded border border-slate-200 text-right font-mono font-bold tabular-nums bg-white text-slate-950 disabled:bg-slate-100 disabled:text-slate-400 focus:outline-none focus:border-slate-900"
                        />
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                        {item.quantity === 0 ? (
                          <span className="text-slate-400">全额退预收</span>
                        ) : delta > 0 ? (
                          <span className="text-rose-600 font-semibold">补 +¥{formatMoney(delta)}</span>
                        ) : delta < 0 ? (
                          <span className="text-blue-600 font-semibold">
                            退 -¥{formatMoney(Math.abs(delta))}
                          </span>
                        ) : (
                          <span className="text-slate-500">持平</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                        {item.quantity === 0 ? (
                          '—'
                        ) : subDelta > 0 ? (
                          <span className="text-rose-700">+¥{formatMoney(subDelta)}</span>
                        ) : subDelta < 0 ? (
                          <span className="text-blue-700">-¥{formatMoney(Math.abs(subDelta))}</span>
                        ) : (
                          <span className="text-slate-500">¥0</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Copyable Group Announcement */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label htmlFor="announcement-preview" className="text-xs font-semibold text-slate-900">
                可复制群公告预览
              </label>
              <button
                type="button"
                onClick={() => void handleCopyAnnouncement()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-slate-950 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? '已复制群公告' : '一键复制群公告'}</span>
              </button>
            </div>
            <textarea
              id="announcement-preview"
              readOnly
              rows={7}
              value={settlement.announcementText}
              className="w-full p-3.5 rounded-xl border border-slate-200 bg-slate-50 font-mono text-xs text-slate-800 leading-relaxed focus:outline-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
