import React, { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  QrCode,
  RefreshCw,
  Share2,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { usePricerStore } from '../store/usePricerStore';
import {
  cancelGroupClaimApi,
  createGroupOrderApi,
  fetchGroupOrderApi,
  syncGroupOrderApi,
} from '../api/client';
import { renderAnnotatedCanvas } from '../core/canvasExport';
import { buildBuyerBillsSummaryText } from '../core/groupExport';
import { formatMoney } from '../core/rebalancer';
import type { GroupOrderDetail, GroupOrderStatus } from '../types/pricing';

interface GroupBuyModalProps {
  open: boolean;
  onClose: () => void;
}

export const GroupBuyModal: React.FC<GroupBuyModalProps> = ({ open, onClose }) => {
  const activeProject = usePricerStore((s) => s.activeProject);
  const rebalance = usePricerStore((s) => s.rebalance);
  const exportConfig = usePricerStore((s) => s.settings.exportConfig);
  const ownerTokensByShareCode = usePricerStore((s) => s.ownerTokensByShareCode);
  const registerPublishedGroup = usePricerStore((s) => s.registerPublishedGroup);
  const notify = usePricerStore((s) => s.notify);

  const [order, setOrder] = useState<GroupOrderDetail | null>(null);
  const [isOwner, setIsOwner] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [publishing, setPublishing] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [copiedBills, setCopiedBills] = useState<boolean>(false);
  const [copiedUnclaimed, setCopiedUnclaimed] = useState<boolean>(false);
  const [activeSubTab, setActiveSubTab] = useState<'stock' | 'claims' | 'bills'>('stock');

  const currentShareCode = activeProject?.publishedGroup?.shareCode?.trim().toUpperCase() || '';
  const currentOwnerToken = currentShareCode
    ? ownerTokensByShareCode[currentShareCode]
    : undefined;

  const fullShareUrl = useMemo(() => {
    const code = order?.shareCode || currentShareCode;
    if (!code || typeof window === 'undefined') return '';
    return `${window.location.origin}/g/${code}`;
  }, [order?.shareCode, currentShareCode]);

  const loadOrder = useCallback(
    async (code: string, token?: string) => {
      if (!code) return;
      setLoading(true);
      try {
        const res = await fetchGroupOrderApi({ shareCode: code, ownerToken: token });
        setOrder(res.order);
        setIsOwner(res.isOwner);
      } catch {
        // Published group may have been cleared on server restart; allow fresh publish
        setOrder(null);
        setIsOwner(false);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // Initial fetch & SSE live subscription when modal is open and shareCode exists
  useEffect(() => {
    if (!open || !currentShareCode) {
      if (!currentShareCode) {
        setOrder(null);
        setIsOwner(false);
      }
      return;
    }

    void loadOrder(currentShareCode, currentOwnerToken);

    if (typeof EventSource === 'undefined') return;
    const es = new EventSource(`/api/v1/groups/${encodeURIComponent(currentShareCode)}/events`);
    const handleEvent = (ev: MessageEvent) => {
      if (currentOwnerToken) {
        // Re-fetch with owner Bearer token so buyer contacts stay unmasked for organizer
        void fetchGroupOrderApi({
          shareCode: currentShareCode,
          ownerToken: currentOwnerToken,
        })
          .then((res) => {
            setOrder(res.order);
            setIsOwner(res.isOwner);
          })
          .catch(() => {
            // ignore transient error
          });
      } else {
        try {
          const parsed = JSON.parse(ev.data) as { share_code?: string };
          if (parsed?.share_code) {
            void loadOrder(currentShareCode, undefined);
          }
        } catch {
          // ignore
        }
      }
    };

    es.addEventListener('update', handleEvent);
    return () => {
      es.close();
    };
  }, [open, currentShareCode, currentOwnerToken, loadOrder]);

  // Generate QR code DataURL whenever fullShareUrl changes
  useEffect(() => {
    if (!open || !fullShareUrl) {
      setQrDataUrl('');
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(fullShareUrl, {
      width: 176,
      margin: 1,
      color: { dark: '#0F172A', light: '#FFFFFF' },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [open, fullShareUrl]);

  if (!open || !activeProject) return null;

  const claimableLocalItems = rebalance.items.filter(
    (it) => it.quantity > 0 && it.tag !== '自留'
  );

  const handlePublishNewGroup = async () => {
    if (claimableLocalItems.length === 0) {
      notify('当前没有可认领商品（需数量 > 0 且非自留）。', 'warning');
      return;
    }
    setPublishing(true);
    try {
      let annotatedDataUrl = '';
      if (activeProject.imageDataUrl) {
        const canvas = await renderAnnotatedCanvas(activeProject, rebalance, exportConfig);
        annotatedDataUrl = canvas.toDataURL('image/jpeg', 0.86);
      }

      const res = await createGroupOrderApi({
        title: activeProject.name || '谷子拼团',
        ipName: activeProject.ipName,
        annotatedImageDataUrl: annotatedDataUrl,
        items: rebalance.items,
      });

      registerPublishedGroup(res.shareCode, res.ownerToken);
      setOrder(res.order);
      setIsOwner(true);
      notify(`在线拼团已发布！分享码 ${res.shareCode}，团员扫码即可自助排谷。`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : '发布在线拼团失败', 'error');
    } finally {
      setPublishing(false);
    }
  };

  const handleSyncFromCanvas = async (nextStatus?: GroupOrderStatus) => {
    if (!order || !currentOwnerToken) {
      notify('当前会话无团长管理凭证，请点击「重新发布新团」生成新链接。', 'warning');
      return;
    }
    setSyncing(true);
    try {
      let annotatedDataUrl: string | undefined;
      if (!nextStatus && activeProject.imageDataUrl) {
        const canvas = await renderAnnotatedCanvas(activeProject, rebalance, exportConfig);
        annotatedDataUrl = canvas.toDataURL('image/jpeg', 0.86);
      }

      const updated = await syncGroupOrderApi({
        shareCode: order.shareCode,
        ownerToken: currentOwnerToken,
        status: nextStatus ?? order.status,
        annotatedImageDataUrl: annotatedDataUrl,
        items: nextStatus ? undefined : rebalance.items,
      });
      setOrder(updated);
      notify(
        nextStatus
          ? `拼团状态已切换为「${
              nextStatus === 'open' ? '开放排谷' : nextStatus === 'locked' ? '已锁单核账' : '二调已结清'
            }」。`
          : '已将最新单价、二调数量与标注图同步至在线排谷页！',
        'success'
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : '同步拼团数据失败', 'error');
    } finally {
      setSyncing(false);
    }
  };

  const handleCancelClaim = async (claimId: string) => {
    if (!order || !currentOwnerToken) return;
    try {
      const updated = await cancelGroupClaimApi({
        shareCode: order.shareCode,
        claimId,
        ownerToken: currentOwnerToken,
      });
      setOrder(updated);
      notify('已撤销该条认领记录并释放库存。', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : '撤销认领失败', 'error');
    }
  };

  const handleCopyLink = async () => {
    if (!fullShareUrl) return;
    try {
      await navigator.clipboard.writeText(
        `【${activeProject.name}】在线实时看图排谷（防撞车实时余量）：${fullShareUrl}`
      );
      setCopiedLink(true);
      notify('已复制在线排谷邀请链接，可直接发至微信/QQ群。', 'success');
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      notify('剪贴板受限，请手动复制上方链接。', 'warning');
    }
  };

  const handleCopyBuyerBills = async () => {
    if (!order) return;
    try {
      await navigator.clipboard.writeText(buildBuyerBillsSummaryText(order));
      setCopiedBills(true);
      notify('已复制分人肾表（含二调退补汇总）到剪贴板！', 'success');
      window.setTimeout(() => setCopiedBills(false), 2000);
    } catch {
      notify('剪贴板受限，请手动复制肾表内容。', 'warning');
    }
  };

  const handleCopyUnclaimedNotice = async () => {
    if (!order) return;
    const remaining = order.items.filter((it) => it.remainingQty > 0);
    const text =
      remaining.length === 0
        ? `【${order.title}】全团已满团！感谢各位老师支持！`
        : `【${order.title} 余量掉落招领】\n目前还可排：${remaining
            .map((it) => `${it.label} ¥${formatMoney(it.price)}(余${it.remainingQty})`)
            .join('、')}\n自助排谷直达：${fullShareUrl}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedUnclaimed(true);
      notify('已复制未满余量招领文案！', 'success');
      window.setTimeout(() => setCopiedUnclaimed(false), 2000);
    } catch {
      notify('剪贴板受限，请稍后重试。', 'warning');
    }
  };

  const totalStock = order ? order.items.reduce((s, it) => s + it.totalQty, 0) : 0;
  const claimedStock = order ? order.items.reduce((s, it) => s + it.claimedQty, 0) : 0;
  const remainingStock = Math.max(0, totalStock - claimedStock);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-buy-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl max-h-[90vh] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <Users className="w-4 h-4 text-slate-800" />
            <div>
              <h2 id="group-buy-modal-title" className="text-sm font-bold text-slate-950">
                内置多人实时在线拼谷与肾表工作台
              </h2>
              <p className="text-xs text-slate-500">
                一键生成移动端 H5 排谷页 · 原子防超卖锁库存 · 自动汇总分人肾表与盲抽二调退补
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭多人拼谷工作台"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="py-16 flex items-center justify-center gap-2 text-xs text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>正在同步在线拼团实时数据...</span>
            </div>
          ) : !order ? (
            /* Empty / Pre-publish State */
            <div className="max-w-xl mx-auto py-8 text-center space-y-5">
              <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-800 flex items-center justify-center mx-auto">
                <Share2 className="w-5 h-5" />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-base font-bold text-slate-950">
                  将「{activeProject.name}」发布为实时在线拼团
                </h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  发布后将生成专属排谷短链与二维码。团员无需注册即可在手机浏览器查看高清标价图并点击认领，服务端自动防撞车锁余量，团长端实时生成分人肾表。
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600 flex items-center justify-center gap-4 tabular-nums">
                <span>
                  可认领款式 <strong className="font-mono text-slate-950">{claimableLocalItems.length}</strong> 款
                </span>
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
                <span>
                  总可排件数{' '}
                  <strong className="font-mono text-slate-950">
                    {claimableLocalItems.reduce((s, it) => s + it.quantity, 0)}
                  </strong>{' '}
                  件
                </span>
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
                <span>
                  目标总额{' '}
                  <strong className="font-mono text-slate-950">
                    ¥{formatMoney(rebalance.targetTotal)}
                  </strong>
                </span>
              </div>

              <button
                type="button"
                disabled={publishing || claimableLocalItems.length === 0}
                onClick={() => void handlePublishNewGroup()}
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-xs font-semibold text-white bg-slate-950 hover:bg-slate-800 disabled:opacity-45 transition-colors whitespace-nowrap shrink-0"
              >
                {publishing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <QrCode className="w-4 h-4" />
                )}
                <span>{publishing ? '正在合成开团图并创建链接...' : '一键发布在线拼团'}</span>
              </button>
            </div>
          ) : (
            /* Live Published Dashboard */
            <div className="space-y-5">
              {/* Top Share Card + QR Code + Organizer Controls */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-5 items-center">
                <div className="space-y-3 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-bold text-slate-950 text-sm">{order.title}</span>
                    <span className="text-slate-300" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono text-slate-600">分享码 {order.shareCode}</span>
                    <span className="text-slate-300" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono text-slate-700 tabular-nums">
                      已排 {claimedStock} / {totalStock} 件（余 {remainingStock} 件）
                    </span>
                  </div>

                  {/* Share URL bar */}
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      aria-label="在线排谷分享链接"
                      value={fullShareUrl}
                      className="flex-1 min-w-[220px] px-3 py-1.5 rounded-lg border border-slate-200 bg-white font-mono text-xs text-slate-800 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void handleCopyLink()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-slate-950 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                    >
                      {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedLink ? '已复制链接' : '复制排谷链接'}</span>
                    </button>
                    <a
                      href={fullShareUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>打开排谷页</span>
                    </a>
                  </div>

                  {/* Status Segmented Control & Sync Actions */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    {isOwner ? (
                      <div className="inline-flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
                        {(
                          [
                            ['open', '开放排谷'],
                            ['locked', '锁单核账'],
                            ['settled', '二调结清'],
                          ] as const
                        ).map(([st, label]) => (
                          <button
                            key={st}
                            type="button"
                            disabled={syncing}
                            onClick={() => void handleSyncFromCanvas(st)}
                            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                              order.status === st
                                ? 'bg-white text-slate-950 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-amber-700">
                        当前处于只读查看模式（如需管理或重置链接，可点击右侧重新发布新团）
                      </span>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      {isOwner && (
                        <button
                          type="button"
                          disabled={syncing}
                          onClick={() => void handleSyncFromCanvas()}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-800 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-45 transition-colors whitespace-nowrap shrink-0"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                          <span>同步当前单价与二调数量</span>
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={publishing}
                        onClick={() => void handlePublishNewGroup()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-200/60 transition-colors whitespace-nowrap shrink-0"
                      >
                        <span>重新发布新团</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Right: QR Code */}
                <div className="flex flex-col items-center justify-center p-2.5 bg-white rounded-xl border border-slate-200 shrink-0 mx-auto lg:mx-0">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={`在线拼团 ${order.shareCode} 扫码排谷二维码`}
                      referrerPolicy="no-referrer"
                      className="w-32 h-32 object-contain"
                    />
                  ) : (
                    <div className="w-32 h-32 flex items-center justify-center bg-slate-50 text-slate-400">
                      <QrCode className="w-6 h-6" />
                    </div>
                  )}
                  <span className="text-[11px] text-slate-500 mt-1">手机扫码直达排谷</span>
                </div>
              </div>

              {/* Sub-navigation Tabs: 余量监控 / 认领流水 / 分人肾表 */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-2.5">
                <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setActiveSubTab('stock')}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      activeSubTab === 'stock'
                        ? 'bg-white text-slate-950 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    角色余量监控（余 {remainingStock}）
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveSubTab('bills')}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      activeSubTab === 'bills'
                        ? 'bg-white text-slate-950 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    分人肾表（{order.buyerBills.length} 人）
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveSubTab('claims')}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      activeSubTab === 'claims'
                        ? 'bg-white text-slate-950 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    认领明细流水（{order.claims.length} 条）
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyUnclaimedNotice()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
                  >
                    {copiedUnclaimed ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>复制余量招领文案</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyBuyerBills()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-slate-950 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    {copiedBills ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>一键复制分人肾表</span>
                  </button>
                </div>
              </div>

              {activeSubTab === 'stock' && (
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                        <th className="py-2.5 px-3">角色 / 款式</th>
                        <th className="py-2.5 px-3">拼团标记</th>
                        <th className="py-2.5 px-3 text-right">现单价</th>
                        <th className="py-2.5 px-3 text-right">已排 / 总数</th>
                        <th className="py-2.5 px-3 text-right">剩余可排</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {order.items.map((it) => (
                        <tr key={it.id} className="hover:bg-slate-50/70">
                          <td className="py-2.5 px-3 font-medium text-slate-900">{it.label}</td>
                          <td className="py-2.5 px-3 text-slate-500">{it.tag || '—'}</td>
                          <td className="py-2.5 px-3 text-right font-mono font-semibold text-slate-950 tabular-nums">
                            ¥{formatMoney(it.price)}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-slate-700 tabular-nums">
                            {it.claimedQty} / {it.totalQty}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-semibold tabular-nums">
                            {it.remainingQty === 0 ? (
                              <span className="text-emerald-700">✓ 已满</span>
                            ) : (
                              <span className="text-amber-700">余 {it.remainingQty} 件</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {activeSubTab === 'bills' && (
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                        <th className="py-2.5 px-3">团员昵称 / CN</th>
                        <th className="py-2.5 px-3">联系方式</th>
                        <th className="py-2.5 px-3">认领明细</th>
                        <th className="py-2.5 px-3 text-right">总件数</th>
                        <th className="py-2.5 px-3 text-right">应付总额</th>
                        <th className="py-2.5 px-3 text-right">二调退补</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {order.buyerBills.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="py-10 text-center text-slate-400">
                            暂无团员认领记录，复制上方排谷链接发群即可开始实时收单
                          </td>
                        </tr>
                      ) : (
                        order.buyerBills.map((bill, idx) => (
                          <tr key={`${bill.buyerName}-${idx}`} className="hover:bg-slate-50/70">
                            <td className="py-2.5 px-3 font-semibold text-slate-950 whitespace-nowrap">
                              {bill.buyerName}
                            </td>
                            <td className="py-2.5 px-3 font-mono text-slate-600 whitespace-nowrap">
                              {bill.buyerContact}
                            </td>
                            <td className="py-2.5 px-3 text-slate-700">
                              {bill.items
                                .map((line) => `${line.label}×${line.qty}`)
                                .join('、')}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono text-slate-800 tabular-nums">
                              {bill.totalQty}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-950 tabular-nums">
                              ¥{formatMoney(bill.totalAmount)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                              {Math.abs(bill.deltaTotal) < 0.01 ? (
                                <span className="text-slate-400">持平</span>
                              ) : bill.deltaTotal > 0 ? (
                                <span className="text-rose-600">需补 +¥{formatMoney(bill.deltaTotal)}</span>
                              ) : (
                                <span className="text-blue-600">
                                  应退 -¥{formatMoney(Math.abs(bill.deltaTotal))}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {activeSubTab === 'claims' && (
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                        <th className="py-2.5 px-3">时间</th>
                        <th className="py-2.5 px-3">团员昵称</th>
                        <th className="py-2.5 px-3">联系方式</th>
                        <th className="py-2.5 px-3">认领款式</th>
                        <th className="py-2.5 px-3 text-right">小计</th>
                        {isOwner && <th className="py-2.5 px-3 text-right">团长操作</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {order.claims.length === 0 ? (
                        <tr>
                          <td
                            colSpan={isOwner ? 6 : 5}
                            className="py-10 text-center text-slate-400"
                          >
                            暂无认领记录
                          </td>
                        </tr>
                      ) : (
                        order.claims
                          .slice()
                          .reverse()
                          .map((c) => (
                            <tr key={c.id} className="hover:bg-slate-50/70">
                              <td className="py-2.5 px-3 font-mono text-slate-500 whitespace-nowrap">
                                {c.createdAt.slice(11, 19)}
                              </td>
                              <td className="py-2.5 px-3 font-medium text-slate-900 whitespace-nowrap">
                                {c.buyerName}
                              </td>
                              <td className="py-2.5 px-3 font-mono text-slate-600 whitespace-nowrap">
                                {c.buyerContact}
                              </td>
                              <td className="py-2.5 px-3 text-slate-800">
                                {c.itemLabel} ×{c.qty}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono font-semibold text-slate-950 tabular-nums">
                                ¥{formatMoney(c.unitPrice * c.qty)}
                              </td>
                              {isOwner && (
                                <td className="py-2.5 px-3 text-right">
                                  <button
                                    type="button"
                                    aria-label={`撤销 ${c.buyerName} 的 ${c.itemLabel} 认领`}
                                    onClick={() => void handleCancelClaim(c.id)}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 text-[11px] font-medium whitespace-nowrap shrink-0"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    <span>撤单释放</span>
                                  </button>
                                </td>
                              )}
                            </tr>
                          ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
