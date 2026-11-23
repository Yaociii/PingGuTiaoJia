import React, { useState } from 'react';
import { Grid2x2, X } from 'lucide-react';
import { usePricerStore } from '../store/usePricerStore';

interface GridPinModalProps {
  open: boolean;
  onClose: () => void;
}

const PRESETS: Array<[number, number]> = [
  [2, 3],
  [2, 4],
  [2, 5],
  [3, 4],
  [3, 5],
];

export const GridPinModal: React.FC<GridPinModalProps> = ({ open, onClose }) => {
  const generateGridPins = usePricerStore((s) => s.generateGridPins);
  const existingCount = usePricerStore((s) => s.activeProject?.items.length ?? 0);

  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(4);
  const [replaceExisting, setReplaceExisting] = useState(true);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    generateGridPins(rows, cols, replaceExisting);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/45 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="grid-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Grid2x2 className="w-4 h-4 text-slate-700" />
            <h2 id="grid-modal-title" className="text-sm font-bold text-slate-950">
              网格一键打点
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭网格打点弹窗"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <p className="text-xs text-slate-500 leading-relaxed">
            适合排列整齐的官图抱盒平铺图，本地零延迟生成均匀网格锚点并立即平账，无需等待 AI 识图。
          </p>

          <div>
            <div className="text-[11px] font-medium text-slate-500 mb-1.5">常见抱盒规格</div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map(([r, c]) => (
                <button
                  key={`${r}x${c}`}
                  type="button"
                  onClick={() => {
                    setRows(r);
                    setCols(c);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-colors ${
                    rows === r && cols === c
                      ? 'bg-slate-950 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {r}×{c} ({r * c}枚)
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="grid-rows-input" className="block text-xs font-medium text-slate-700 mb-1">
                行数 (Rows)
              </label>
              <input
                id="grid-rows-input"
                type="number"
                min={1}
                max={10}
                value={rows}
                onChange={(e) => setRows(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-mono font-semibold tabular-nums focus:outline-none focus:border-slate-900"
              />
            </div>
            <div>
              <label htmlFor="grid-cols-input" className="block text-xs font-medium text-slate-700 mb-1">
                列数 (Cols)
              </label>
              <input
                id="grid-cols-input"
                type="number"
                min={1}
                max={10}
                value={cols}
                onChange={(e) => setCols(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-mono font-semibold tabular-nums focus:outline-none focus:border-slate-900"
              />
            </div>
          </div>

          {existingCount > 0 && (
            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={replaceExisting}
                onChange={(e) => setReplaceExisting(e.target.checked)}
                className="rounded border-slate-300 accent-slate-950"
              />
              <span>覆盖当前画布已有的 {existingCount} 个节点</span>
            </label>
          )}

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-lg text-xs font-semibold text-white bg-slate-950 hover:bg-slate-800 transition-colors"
            >
              生成 {rows * cols} 个网格打点
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
