import React, { useEffect, useState } from 'react';
import { Check, Copy, Download, Loader2, X } from 'lucide-react';
import { usePricerStore } from '../store/usePricerStore';
import {
  canvasToPngBlob,
  copyPngBlobToClipboard,
  renderAnnotatedCanvas,
  triggerBlobDownload,
} from '../core/canvasExport';

interface ExportModalProps {
  open: boolean;
  onClose: () => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({ open, onClose }) => {
  const activeProject = usePricerStore((s) => s.activeProject);
  const rebalance = usePricerStore((s) => s.rebalance);
  const exportConfig = usePricerStore((s) => s.settings.exportConfig);
  const contributeMarket = usePricerStore((s) => s.settings.contributeMarket);
  const updateExportConfig = usePricerStore((s) => s.updateExportConfig);
  const contributeCurrentProjectQuietly = usePricerStore((s) => s.contributeCurrentProjectQuietly);
  const notify = usePricerStore((s) => s.notify);

  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [rendering, setRendering] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !activeProject?.imageDataUrl) return;
    let cancelled = false;
    setRendering(true);

    void renderAnnotatedCanvas(activeProject, rebalance, exportConfig)
      .then((canvas) => {
        if (!cancelled) {
          setPreviewUrl(canvas.toDataURL('image/png'));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          notify(err instanceof Error ? err.message : '高清预览渲染失败', 'error');
        }
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, activeProject, rebalance, exportConfig, notify]);

  if (!open || !activeProject) return null;

  const handleCopyImage = async () => {
    try {
      const canvas = await renderAnnotatedCanvas(activeProject, rebalance, exportConfig);
      const blob = await canvasToPngBlob(canvas);
      const result = await copyPngBlobToClipboard(blob);
      void contributeCurrentProjectQuietly();

      if (result === 'copied') {
        setCopied(true);
        notify('高清成品图已复制到剪贴板，可直接 Ctrl+V 发群开团！', 'success');
        window.setTimeout(() => setCopied(false), 2200);
      } else {
        triggerBlobDownload(blob, `${activeProject.name || '谷子调价'}-开团图.png`);
        notify('当前浏览器限制直接写图到剪贴板，已自动为您下载高清 PNG。', 'info');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : '复制成品图失败', 'error');
    }
  };

  const handleDownloadPng = async () => {
    try {
      const canvas = await renderAnnotatedCanvas(activeProject, rebalance, exportConfig);
      const blob = await canvasToPngBlob(canvas);
      triggerBlobDownload(blob, `${activeProject.name || '谷子调价'}-开团图.png`);
      void contributeCurrentProjectQuietly();
      notify('已保存无损高清开团图 PNG。', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : '导出 PNG 失败', 'error');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl max-h-[90vh] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div>
            <h2 id="export-modal-title" className="text-sm font-bold text-slate-950">
              高清开团图导出与样式设置
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              按原图分辨率无损渲染价格胶囊与底部深色平账校验条
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭导出弹窗"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_280px] overflow-hidden">
          {/* Left: Rendered Canvas Preview */}
          <div className="bg-slate-100 p-5 flex items-center justify-center overflow-auto">
            {rendering || !previewUrl ? (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>正在合成原图分辨率预览...</span>
              </div>
            ) : (
              <img
                src={previewUrl}
                alt="导出高清成品图预览"
                referrerPolicy="no-referrer"
                className="max-h-[62vh] max-w-full rounded-lg shadow-md border border-slate-200/80 object-contain"
              />
            )}
          </div>

          {/* Right: Export Controls */}
          <div className="p-5 border-t lg:border-t-0 lg:border-l border-slate-100 flex flex-col justify-between gap-5 overflow-y-auto">
            <div className="space-y-5">
              <div>
                <div className="text-xs font-semibold text-slate-900 mb-2">胶囊显示模式</div>
                <div className="grid grid-cols-2 gap-1.5 bg-slate-100 p-1 rounded-lg">
                  <button
                    type="button"
                    onClick={() => updateExportConfig({ displayMode: 'label_and_price' })}
                    className={`py-1.5 rounded-md text-xs font-medium transition-colors ${
                      exportConfig.displayMode === 'label_and_price'
                        ? 'bg-white text-slate-950 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    名称 + 价格
                  </button>
                  <button
                    type="button"
                    onClick={() => updateExportConfig({ displayMode: 'price_only' })}
                    className={`py-1.5 rounded-md text-xs font-medium transition-colors ${
                      exportConfig.displayMode === 'price_only'
                        ? 'bg-white text-slate-950 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    仅价格
                  </button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs mb-2">
                  <label htmlFor="export-scale-slider" className="font-semibold text-slate-900">
                    标签缩放倍率
                  </label>
                  <span className="font-mono text-slate-600 tabular-nums">
                    {exportConfig.scale.toFixed(1)}x
                  </span>
                </div>
                <input
                  id="export-scale-slider"
                  type="range"
                  min={0.8}
                  max={1.4}
                  step={0.1}
                  value={exportConfig.scale}
                  onChange={(e) =>
                    updateExportConfig({ scale: Number.parseFloat(e.target.value) || 1.0 })
                  }
                  className="w-full accent-slate-950"
                />
                <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1">
                  <span>0.8x</span>
                  <span>1.1x</span>
                  <span>1.4x</span>
                </div>
              </div>

              <label className="flex items-center justify-between gap-2 text-xs text-slate-800 cursor-pointer select-none">
                <span>显示拼团标记（热烫 / 捆1 / 自留）</span>
                <input
                  type="checkbox"
                  checked={exportConfig.showTag}
                  onChange={(e) => updateExportConfig({ showTag: e.target.checked })}
                  className="rounded border-slate-300 accent-slate-950 w-4 h-4"
                />
              </label>

              {contributeMarket && (
                <p className="text-[11px] text-slate-500 leading-relaxed pt-2 border-t border-slate-100">
                  导出时将静默匿名回流本次角色调价系数至行情库（绝不上传图片与隐私）。
                </p>
              )}
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => void handleCopyImage()}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-xs font-semibold text-white bg-slate-950 hover:bg-slate-800 transition-colors"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? '已复制高清图' : '一键复制高清图到剪贴板'}</span>
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadPng()}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
              >
                <Download className="w-4 h-4" />
                <span>另存为无损 PNG</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
