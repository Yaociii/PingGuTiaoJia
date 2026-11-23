import React, { useMemo, useState } from 'react';
import { Calculator, Check, Copy, X } from 'lucide-react';
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
  const notify = usePricerStore((s) => s.notify);

  const [copied, setCopied] = useState(false);

  const items = rebalance.items;
  const settlement = useMemo(
    () => calcSecondarySettlement(items, activeProject?.name || '本团'),
    [items, activeProject?.name]
  );

  if (!open || !activeProject) return null;

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
        className="w-full max-w-4xl max-h-[88vh] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden"
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

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Summary strip */}
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-100 text-xs tabular-nums">
            <div className="flex items-center gap-4 flex-wrap">
              <span className="text-slate-500">
                目标总价{' '}
                <strong className="font-mono text-sm text-slate-950">
                  ¥{formatMoney(rebalance.targetTotal)}
                </strong>
              </span>
              <span className="text-slate-300" aria-hidden="true">
                ·
              </span>
              <span className="text-slate-500">
                原预收合计{' '}
                <strong className="font-mono text-sm text-slate-950">
                  ¥{formatMoney(settlement.totalPrepaid)}
                </strong>
              </span>
              <span className="text-slate-300" aria-hidden="true">
                ·
              </span>
              <span className="text-slate-500">
                二调合计{' '}
                <strong className="font-mono text-sm text-slate-950">
                  ¥{formatMoney(settlement.totalFinal)}
                </strong>
              </span>
            </div>
            <div className="font-mono font-semibold text-xs">
              {rebalance.status === 'OK' ? (
                <span className="text-emerald-700">✓ 二调总账严丝合缝</span>
              ) : (
                <span className="text-amber-700">
                  ⚠ 存在余差 {rebalance.residual > 0 ? '+' : ''}¥{formatMoney(rebalance.residual)}
                </span>
              )}
            </div>
          </div>

          {/* Interactive Secondary Adjustment Table */}
          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                  <th className="py-2.5 px-3">角色 / 款式</th>
                  <th className="py-2.5 px-3 text-right">实际出货数</th>
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
                      className={item.quantity === 0 ? 'bg-slate-50/70 text-slate-400' : 'hover:bg-slate-50/60'}
                    >
                      <td className="py-2 px-3 font-medium text-slate-900">
                        {item.label}
                        {item.quantity === 0 && (
                          <span className="ml-2 text-[11px] text-slate-400">（未出货）</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <input
                          type="number"
                          min={0}
                          max={20}
                          aria-label={`${item.label} 实际数量`}
                          value={item.quantity}
                          onChange={(e) => {
                            const q = Math.max(0, Number.parseInt(e.target.value, 10) || 0);
                            updateItemField(item.id, { quantity: q });
                          }}
                          className="w-16 px-2 py-1 rounded border border-slate-200 text-right font-mono tabular-nums bg-white text-slate-900 focus:outline-none focus:border-slate-900"
                        />
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
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
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
                      <td className="py-2 px-3 text-right font-mono font-semibold tabular-nums">
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
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-slate-950 hover:bg-slate-800 transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? '已复制群公告' : '一键复制群公告'}</span>
              </button>
            </div>
            <textarea
              id="announcement-preview"
              readOnly
              rows={8}
              value={settlement.announcementText}
              className="w-full p-3.5 rounded-xl border border-slate-200 bg-slate-50 font-mono text-xs text-slate-800 leading-relaxed focus:outline-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
