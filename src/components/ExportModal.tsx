import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  X,
} from 'lucide-react';
import { usePricerStore } from '../store/usePricerStore';
import {
  canvasToPngBlob,
  copyPngBlobToClipboard,
  renderAnnotatedCanvas,
  triggerBlobDownload,
} from '../core/canvasExport';
import {
  TEMPLATE_PRESETS,
  buildGroupCsvContent,
  buildGroupExportRows,
  buildGroupXlsxBlob,
  renderGroupTemplateText,
  type GroupTemplatePresetId,
} from '../core/groupExport';
import { formatMoney } from '../core/rebalancer';

interface ExportModalProps {
  open: boolean;
  onClose: () => void;
}

type ExportTab = 'image' | 'spreadsheet_text';

export const ExportModal: React.FC<ExportModalProps> = ({ open, onClose }) => {
  const activeProject = usePricerStore((s) => s.activeProject);
  const rebalance = usePricerStore((s) => s.rebalance);
  const exportConfig = usePricerStore((s) => s.settings.exportConfig);
  const contributeMarket = usePricerStore((s) => s.settings.contributeMarket);
  const updateExportConfig = usePricerStore((s) => s.updateExportConfig);
  const contributeCurrentProjectQuietly = usePricerStore((s) => s.contributeCurrentProjectQuietly);
  const notify = usePricerStore((s) => s.notify);

  const [activeTab, setActiveTab] = useState<ExportTab>('image');
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [rendering, setRendering] = useState(false);
  const [copiedImage, setCopiedImage] = useState(false);

  // External export states
  const [presetId, setPresetId] = useState<GroupTemplatePresetId>('miniapp_batch');
  const [lineTemplate, setLineTemplate] = useState<string>(
    TEMPLATE_PRESETS.miniapp_batch.lineTemplate
  );
  const [includeHeaderFooter, setIncludeHeaderFooter] = useState<boolean>(
    TEMPLATE_PRESETS.miniapp_batch.includeHeaderFooter
  );
  const [copiedText, setCopiedText] = useState(false);

  useEffect(() => {
    if (!open || activeTab !== 'image' || !activeProject?.imageDataUrl) return;
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
  }, [open, activeTab, activeProject, rebalance, exportConfig, notify]);

  const exportRows = useMemo(
    () => (activeProject ? buildGroupExportRows(rebalance.items, activeProject.ipName) : []),
    [activeProject, rebalance.items]
  );

  const renderedTemplateText = useMemo(() => {
    if (!activeProject) return '';
    return renderGroupTemplateText({
      projectName: activeProject.name || '谷子拼团',
      ipName: activeProject.ipName,
      items: rebalance.items,
      lineTemplate,
      includeHeaderFooter,
    });
  }, [activeProject, rebalance.items, lineTemplate, includeHeaderFooter]);

  if (!open || !activeProject) return null;

  const handleSelectPreset = (nextPreset: GroupTemplatePresetId) => {
    setPresetId(nextPreset);
    if (nextPreset !== 'custom') {
      setLineTemplate(TEMPLATE_PRESETS[nextPreset].lineTemplate);
      setIncludeHeaderFooter(TEMPLATE_PRESETS[nextPreset].includeHeaderFooter);
    }
  };

  const handleCopyImage = async () => {
    try {
      const canvas = await renderAnnotatedCanvas(activeProject, rebalance, exportConfig);
      const blob = await canvasToPngBlob(canvas);
      const result = await copyPngBlobToClipboard(blob);
      void contributeCurrentProjectQuietly();

      if (result === 'copied') {
        setCopiedImage(true);
        notify('高清成品图已复制到剪贴板，可直接 Ctrl+V 发群开团！', 'success');
        window.setTimeout(() => setCopiedImage(false), 2200);
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

  const handleDownloadXlsx = () => {
    try {
      const blob = buildGroupXlsxBlob(rebalance.items, activeProject.ipName);
      triggerBlobDownload(blob, `${activeProject.name || '谷子调价'}-拼团清单.xlsx`);
      void contributeCurrentProjectQuietly();
      notify('已导出标准 Excel (.xlsx) 拼团商品清单。', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : '导出 Excel 失败', 'error');
    }
  };

  const handleDownloadCsv = () => {
    try {
      const csvText = buildGroupCsvContent(rebalance.items, activeProject.ipName);
      const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
      triggerBlobDownload(blob, `${activeProject.name || '谷子调价'}-拼团清单.csv`);
      void contributeCurrentProjectQuietly();
      notify('已导出 UTF-8 BOM 标准 CSV 表格，Excel 双击可直接打开。', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : '导出 CSV 失败', 'error');
    }
  };

  const handleCopyTemplateText = async () => {
    try {
      await navigator.clipboard.writeText(renderedTemplateText);
      setCopiedText(true);
      void contributeCurrentProjectQuietly();
      notify('拼团文本已复制到剪贴板，可直接粘贴至小程序或群聊。', 'success');
      window.setTimeout(() => setCopiedText(false), 2000);
    } catch {
      notify('剪贴板受限，请手动全选复制右侧预览框文本。', 'warning');
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
        className="w-full max-w-5xl max-h-[90vh] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header with Segmented Export Tabs */}
        <div className="px-6 py-3.5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div>
            <h2 id="export-modal-title" className="text-sm font-bold text-slate-950">
              开团成果导出中心
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              支持无损高清标注图、第三方小程序 Excel 清单与多格式群排表文本
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div
              role="tablist"
              aria-label="导出模式切换"
              className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'image'}
                onClick={() => setActiveTab('image')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'image'
                    ? 'bg-white text-slate-950 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <ImageIcon className="w-3.5 h-3.5" />
                <span>高清开团图</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'spreadsheet_text'}
                onClick={() => setActiveTab('spreadsheet_text')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'spreadsheet_text'
                    ? 'bg-white text-slate-950 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>外部拼谷导出（Excel / 群模板）</span>
              </button>
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
        </div>

        {activeTab === 'image' ? (
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_288px] overflow-hidden">
            {/* Left: Rendered Canvas Preview */}
            <div className="bg-slate-100 p-5 flex items-center justify-center overflow-auto">
              {!activeProject.imageDataUrl ? (
                <div className="text-xs text-slate-500 text-center space-y-2">
                  <p>当前拼团尚未载入底图，请切换至「外部拼谷导出」下载 Excel 或复制排表文本。</p>
                </div>
              ) : rendering || !previewUrl ? (
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

            {/* Right: Image Export Controls */}
            <div className="p-5 border-t lg:border-t-0 lg:border-l border-slate-100 flex flex-col justify-between gap-5 overflow-y-auto">
              <div className="space-y-5">
                <div>
                  <div className="text-xs font-semibold text-slate-900 mb-2">胶囊显示模式</div>
                  <div className="grid grid-cols-2 gap-1.5 bg-slate-100 p-1 rounded-lg">
                    <button
                      type="button"
                      onClick={() => updateExportConfig({ displayMode: 'label_and_price' })}
                      className={`py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
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
                      className={`py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
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
                  disabled={!activeProject.imageDataUrl}
                  onClick={() => void handleCopyImage()}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-xs font-semibold text-white bg-slate-950 hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                >
                  {copiedImage ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  <span>{copiedImage ? '已复制高清图' : '一键复制高清图到剪贴板'}</span>
                </button>
                <button
                  type="button"
                  disabled={!activeProject.imageDataUrl}
                  onClick={() => void handleDownloadPng()}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                >
                  <Download className="w-4 h-4" />
                  <span>另存为无损 PNG</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-100 overflow-y-auto">
            {/* Left Column: Standard 5-Column Excel / CSV Export */}
            <div className="p-6 flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xs font-bold text-slate-950">
                    1. 第三方拼团表格导出（Excel / CSV）
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    自动剔除「自留」与 0 数量项，适配拼谷小程序与快团团表格批量导入
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={exportRows.length === 0}
                    onClick={handleDownloadXlsx}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-slate-950 hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" />
                    <span>下载 Excel (.xlsx)</span>
                  </button>
                  <button
                    type="button"
                    disabled={exportRows.length === 0}
                    onClick={handleDownloadCsv}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>下载 CSV</span>
                  </button>
                </div>
              </div>

              <div className="border border-slate-200 rounded-xl overflow-hidden flex-1 max-h-[52vh] overflow-y-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                      <th className="py-2 px-3">商品名称/角色</th>
                      <th className="py-2 px-2.5 text-right">单价</th>
                      <th className="py-2 px-2.5 text-right">总数量</th>
                      <th className="py-2 px-2.5">捆绑/标签</th>
                      <th className="py-2 px-3">备注</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {exportRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-slate-400">
                          暂无可导出的有效商品（非自留且数量 &gt; 0）
                        </td>
                      </tr>
                    ) : (
                      exportRows.map((row, idx) => (
                        <tr key={`${row.label}-${idx}`} className="hover:bg-slate-50/70">
                          <td className="py-2 px-3 font-medium text-slate-900 whitespace-nowrap">
                            {row.label}
                          </td>
                          <td className="py-2 px-2.5 text-right font-mono font-semibold text-slate-950 tabular-nums">
                            ¥{formatMoney(row.price)}
                          </td>
                          <td className="py-2 px-2.5 text-right font-mono text-slate-700 tabular-nums">
                            {row.quantity}
                          </td>
                          <td className="py-2 px-2.5 text-slate-600 whitespace-nowrap">
                            {row.tag || '—'}
                          </td>
                          <td className="py-2 px-3 text-slate-500 truncate max-w-[160px]">
                            {row.note || '—'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Right Column: Multi-Format Customizable Template Text */}
            <div className="p-6 flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xs font-bold text-slate-950 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-slate-700" />
                    <span>2. 多格式排表与小程序批量文本</span>
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    支持变量：<code className="font-mono text-slate-700">{'{{label}}'}</code>{' '}
                    <code className="font-mono text-slate-700">{'{{price}}'}</code>{' '}
                    <code className="font-mono text-slate-700">{'{{quantity}}'}</code>{' '}
                    <code className="font-mono text-slate-700">{'{{tag}}'}</code>
                  </p>
                </div>

                <button
                  type="button"
                  disabled={!renderedTemplateText}
                  onClick={() => void handleCopyTemplateText()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-slate-950 hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                >
                  {copiedText ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedText ? '已复制文本' : '一键复制文本'}</span>
                </button>
              </div>

              {/* Preset Buttons */}
              <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 p-1 rounded-lg">
                <button
                  type="button"
                  onClick={() => handleSelectPreset('miniapp_batch')}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    presetId === 'miniapp_batch'
                      ? 'bg-white text-slate-950 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  小程序批量识别格式
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectPreset('chat_solitaire')}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    presetId === 'chat_solitaire'
                      ? 'bg-white text-slate-950 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  QQ / 微信群排表接龙
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectPreset('custom')}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    presetId === 'custom'
                      ? 'bg-white text-slate-950 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  自定义变量模板
                </button>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="export-line-template"
                  className="block text-[11px] font-semibold text-slate-700"
                >
                  单行渲染模板
                </label>
                <input
                  id="export-line-template"
                  type="text"
                  value={lineTemplate}
                  onChange={(e) => {
                    setPresetId('custom');
                    setLineTemplate(e.target.value);
                  }}
                  className="w-full px-3 py-1.5 rounded-lg border border-slate-200 font-mono text-xs text-slate-900 focus:outline-none focus:border-slate-900"
                />
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={includeHeaderFooter}
                    onChange={(e) => setIncludeHeaderFooter(e.target.checked)}
                    className="rounded border-slate-300 accent-slate-950 w-3.5 h-3.5"
                  />
                  <span>附带团头标题、自留声明与群接龙规则说明</span>
                </label>
              </div>

              <div className="flex-1 flex flex-col">
                <label
                  htmlFor="export-template-preview"
                  className="block text-[11px] font-semibold text-slate-700 mb-1.5"
                >
                  实时文本预览
                </label>
                <textarea
                  id="export-template-preview"
                  readOnly
                  rows={10}
                  value={renderedTemplateText}
                  className="w-full flex-1 p-3.5 rounded-xl border border-slate-200 bg-slate-50 font-mono text-xs text-slate-800 leading-relaxed focus:outline-none"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
