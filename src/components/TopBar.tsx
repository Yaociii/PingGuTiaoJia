import React from 'react';
import {
  Calculator,
  Database,
  Download,
  Grid2x2,
  Loader2,
  MousePointerClick,
  PanelLeft,
  PlusCircle,
  Redo2,
  Sparkles,
  Undo2,
  Wand2,
} from 'lucide-react';
import { usePricerStore } from '../store/usePricerStore';
import type { SettingsModalTab } from './SettingsMarketModal';

interface TopBarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenGridModal: () => void;
  onOpenSettlementModal: () => void;
  onOpenExportModal: () => void;
  onOpenSettingsModal: (defaultTab?: SettingsModalTab) => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  sidebarOpen,
  onToggleSidebar,
  onOpenGridModal,
  onOpenSettlementModal,
  onOpenExportModal,
  onOpenSettingsModal,
}) => {
  const activeProject = usePricerStore((s) => s.activeProject);
  const canvasMode = usePricerStore((s) => s.canvasMode);
  const setCanvasMode = usePricerStore((s) => s.setCanvasMode);
  const isDetecting = usePricerStore((s) => s.isDetecting);
  const isAutoPricing = usePricerStore((s) => s.isAutoPricing);
  const runAiDetect = usePricerStore((s) => s.runAiDetect);
  const runAiAutoPrice = usePricerStore((s) => s.runAiAutoPrice);
  const pastCount = usePricerStore((s) => s.past.length);
  const futureCount = usePricerStore((s) => s.future.length);
  const undo = usePricerStore((s) => s.undo);
  const redo = usePricerStore((s) => s.redo);

  const hasImage = Boolean(activeProject?.imageDataUrl);
  const canAutoPrice = Boolean(activeProject && activeProject.items.length >= 2);

  return (
    <header className="h-14 shrink-0 bg-white border-b border-[#E4E7EC] px-4 flex items-center justify-between gap-4 z-20">
      {/* Zone 1: Brand & Contextual Breadcrumb */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={sidebarOpen ? '收起拼团侧边栏' : '展开拼团侧边栏'}
          className="p-2 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors shrink-0"
        >
          <PanelLeft className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-[15px] font-bold tracking-tight text-slate-950 whitespace-nowrap shrink-0">
            Gacha Pricer
          </span>
          {activeProject && (
            <>
              <span className="text-slate-300 select-none shrink-0" aria-hidden="true">
                /
              </span>
              <span className="text-sm font-medium text-slate-600 truncate max-w-[150px] xl:max-w-[230px]">
                {activeProject.name}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Zone 2: Studio Workbench Controls (single-line) */}
      <nav aria-label="画布工具栏" className="hidden lg:flex items-center gap-1">
        <button
          type="button"
          onClick={() => void runAiDetect()}
          disabled={!hasImage || isDetecting}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 disabled:opacity-45 disabled:pointer-events-none transition-colors whitespace-nowrap shrink-0"
        >
          {isDetecting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Sparkles className="w-3.5 h-3.5" />
          )}
          <span>{isDetecting ? '识图中...' : 'AI 识图'}</span>
        </button>

        <button
          type="button"
          onClick={() => void runAiAutoPrice()}
          disabled={!canAutoPrice || isAutoPricing}
          title="结合角色热度与历史行情自动分配权重并平账（已锁定单品保持原价）"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-45 disabled:pointer-events-none transition-colors whitespace-nowrap shrink-0"
        >
          {isAutoPricing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Wand2 className="w-3.5 h-3.5" />
          )}
          <span>{isAutoPricing ? '调价中...' : 'AI 调价'}</span>
        </button>

        <button
          type="button"
          onClick={onOpenGridModal}
          disabled={!hasImage}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-100 disabled:opacity-40 disabled:pointer-events-none transition-colors whitespace-nowrap shrink-0"
        >
          <Grid2x2 className="w-3.5 h-3.5" />
          <span>网格打点</span>
        </button>

        <button
          type="button"
          onClick={() => setCanvasMode(canvasMode === 'add_pin' ? 'select' : 'add_pin')}
          disabled={!hasImage}
          aria-pressed={canvasMode === 'add_pin'}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 disabled:pointer-events-none ${
            canvasMode === 'add_pin'
              ? 'bg-slate-900 text-white'
              : 'text-slate-700 hover:text-slate-950 hover:bg-slate-100'
          }`}
        >
          {canvasMode === 'add_pin' ? (
            <MousePointerClick className="w-3.5 h-3.5" />
          ) : (
            <PlusCircle className="w-3.5 h-3.5" />
          )}
          <span>{canvasMode === 'add_pin' ? '点图加点中' : '手动加点'}</span>
        </button>

        <span className="h-4 w-px bg-slate-200 mx-0.5" aria-hidden="true" />

        <button
          type="button"
          onClick={onOpenSettlementModal}
          disabled={!activeProject || activeProject.items.length === 0}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-100 disabled:opacity-40 disabled:pointer-events-none transition-colors whitespace-nowrap shrink-0"
        >
          <Calculator className="w-3.5 h-3.5" />
          <span>盲抽二调</span>
        </button>

        <button
          type="button"
          onClick={() => onOpenSettingsModal('market')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
        >
          <Database className="w-3.5 h-3.5" />
          <span>行情库</span>
        </button>

        <span className="h-4 w-px bg-slate-200 mx-0.5" aria-hidden="true" />

        <button
          type="button"
          onClick={undo}
          disabled={pastCount === 0}
          aria-label="撤回上一步"
          title="撤回 (Ctrl+Z)"
          className="p-1.5 rounded-lg text-slate-600 hover:text-slate-950 hover:bg-slate-100 disabled:opacity-30 disabled:pointer-events-none transition-colors shrink-0"
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={futureCount === 0}
          aria-label="重做下一步"
          title="重做 (Ctrl+Y)"
          className="p-1.5 rounded-lg text-slate-600 hover:text-slate-950 hover:bg-slate-100 disabled:opacity-30 disabled:pointer-events-none transition-colors shrink-0"
        >
          <Redo2 className="w-4 h-4" />
        </button>
      </nav>

      {/* Zone 3: Single Primary CTA */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onOpenExportModal}
          disabled={!hasImage}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-slate-950 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none transition-colors whitespace-nowrap shrink-0"
        >
          <Download className="w-3.5 h-3.5" />
          <span>导出成品图</span>
        </button>
      </div>
    </header>
  );
};
