import { useEffect, useState } from 'react';
import {
  Calculator,
  Database,
  Grid2x2,
  Loader2,
  PlusCircle,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { usePricerStore } from './store/usePricerStore';
import { TopBar } from './components/TopBar';
import { ProjectSidebar } from './components/ProjectSidebar';
import { PricingCanvas } from './components/PricingCanvas';
import { InspectorPanel } from './components/InspectorPanel';
import { GridPinModal } from './components/GridPinModal';
import { SecondarySettlementModal } from './components/SecondarySettlementModal';
import { ExportModal } from './components/ExportModal';
import { SettingsMarketModal, type SettingsModalTab } from './components/SettingsMarketModal';

export default function App() {
  const initWorkspace = usePricerStore((s) => s.initWorkspace);
  const loadImageIntoActiveProject = usePricerStore((s) => s.loadImageIntoActiveProject);
  const undo = usePricerStore((s) => s.undo);
  const redo = usePricerStore((s) => s.redo);
  const selectedItemId = usePricerStore((s) => s.selectedItemId);
  const deleteItem = usePricerStore((s) => s.deleteItem);
  const toast = usePricerStore((s) => s.toast);
  const clearToast = usePricerStore((s) => s.clearToast);
  const activeProject = usePricerStore((s) => s.activeProject);
  const canvasMode = usePricerStore((s) => s.canvasMode);
  const setCanvasMode = usePricerStore((s) => s.setCanvasMode);
  const isDetecting = usePricerStore((s) => s.isDetecting);
  const isAutoPricing = usePricerStore((s) => s.isAutoPricing);
  const runAiDetect = usePricerStore((s) => s.runAiDetect);
  const runAiAutoPrice = usePricerStore((s) => s.runAiAutoPrice);

  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 1024
  );
  const [mobilePane, setMobilePane] = useState<'canvas' | 'inspector'>('canvas');
  const [gridModalOpen, setGridModalOpen] = useState(false);
  const [settlementModalOpen, setSettlementModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [settingsModal, setSettingsModal] = useState<{
    open: boolean;
    tab: SettingsModalTab;
  }>({ open: false, tab: 'ai' });

  // Bootstrap workspace & projects from IndexedDB (with seeded flagship demo)
  useEffect(() => {
    void initWorkspace();
  }, [initWorkspace]);

  // Global Ctrl+V clipboard image paste + Ctrl+Z / Ctrl+Y Undo/Redo + Delete selected pin
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            const reader = new FileReader();
            reader.onload = () => {
              if (typeof reader.result === 'string') {
                void loadImageIntoActiveProject(reader.result);
              }
            };
            reader.readAsDataURL(blob);
            return;
          }
        }
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditingText =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !isEditingText) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y' && !isEditingText) {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedItemId && !isEditingText) {
        e.preventDefault();
        deleteItem(selectedItemId);
      }
    };

    window.addEventListener('paste', handlePaste);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('paste', handlePaste);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [loadImageIntoActiveProject, undo, redo, selectedItemId, deleteItem]);

  const hasImage = Boolean(activeProject?.imageDataUrl);
  const canAutoPrice = Boolean(activeProject && activeProject.items.length >= 2);

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-[#F6F7F9] text-slate-900">
      <TopBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onOpenGridModal={() => setGridModalOpen(true)}
        onOpenSettlementModal={() => setSettlementModalOpen(true)}
        onOpenExportModal={() => setExportModalOpen(true)}
        onOpenSettingsModal={(tab = 'ai') => setSettingsModal({ open: true, tab })}
      />

      {/* Compact mobile/tablet quick action bar (< lg) */}
      <div className="lg:hidden flex items-center justify-between gap-2 px-3 py-1.5 bg-white border-b border-[#E4E7EC] shrink-0">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <button
            type="button"
            onClick={() => void runAiDetect()}
            disabled={!hasImage || isDetecting}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-rose-700 bg-rose-50 whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            {isDetecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            <span>AI 识图</span>
          </button>
          <button
            type="button"
            onClick={() => void runAiAutoPrice()}
            disabled={!canAutoPrice || isAutoPricing}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-700 bg-indigo-50 whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            {isAutoPricing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
            <span>AI 调价</span>
          </button>
          <button
            type="button"
            onClick={() => setGridModalOpen(true)}
            disabled={!hasImage}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            <Grid2x2 className="w-3.5 h-3.5" />
            <span>网格</span>
          </button>
          <button
            type="button"
            onClick={() => setCanvasMode(canvasMode === 'add_pin' ? 'select' : 'add_pin')}
            disabled={!hasImage}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 ${
              canvasMode === 'add_pin' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'
            }`}
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>加点</span>
          </button>
          <button
            type="button"
            onClick={() => setSettlementModalOpen(true)}
            disabled={!activeProject || activeProject.items.length === 0}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            <Calculator className="w-3.5 h-3.5" />
            <span>二调</span>
          </button>
          <button
            type="button"
            onClick={() => setSettingsModal({ open: true, tab: 'market' })}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 whitespace-nowrap shrink-0"
          >
            <Database className="w-3.5 h-3.5" />
            <span>行情库</span>
          </button>
        </div>

        <div className="md:hidden inline-flex p-0.5 bg-slate-100 rounded-lg shrink-0">
          <button
            type="button"
            onClick={() => setMobilePane('canvas')}
            className={`px-2.5 py-1 rounded text-[11px] font-medium whitespace-nowrap ${
              mobilePane === 'canvas' ? 'bg-white text-slate-950 shadow-xs' : 'text-slate-600'
            }`}
          >
            画布
          </button>
          <button
            type="button"
            onClick={() => setMobilePane('inspector')}
            className={`px-2.5 py-1 rounded text-[11px] font-medium whitespace-nowrap ${
              mobilePane === 'inspector' ? 'bg-white text-slate-950 shadow-xs' : 'text-slate-600'
            }`}
          >
            明细
          </button>
        </div>
      </div>

      {/* Main 3-Column Studio Workspace */}
      <div className="flex-1 min-h-0 flex overflow-hidden relative">
        <div className={sidebarOpen ? 'fixed inset-y-14 left-0 z-30 md:static md:inset-auto h-[calc(100vh-56px)] md:h-full shadow-xl md:shadow-none' : 'hidden'}>
          <ProjectSidebar
            open={sidebarOpen}
            onOpenSettings={() => setSettingsModal({ open: true, tab: 'ai' })}
          />
        </div>
        <div className={`${mobilePane === 'canvas' ? 'flex' : 'hidden'} md:flex flex-1 min-w-0 h-full`}>
          <PricingCanvas />
        </div>
        <div className={`${mobilePane === 'inspector' ? 'flex w-full' : 'hidden'} md:flex md:w-auto h-full`}>
          <InspectorPanel />
        </div>
      </div>

      {/* Modals */}
      <GridPinModal open={gridModalOpen} onClose={() => setGridModalOpen(false)} />
      <SecondarySettlementModal
        open={settlementModalOpen}
        onClose={() => setSettlementModalOpen(false)}
      />
      <ExportModal open={exportModalOpen} onClose={() => setExportModalOpen(false)} />
      <SettingsMarketModal
        open={settingsModal.open}
        defaultTab={settingsModal.tab}
        onClose={() => setSettingsModal((s) => ({ ...s, open: false }))}
      />

      {/* Clean non-blocking Toast Notice */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl shadow-lg border text-xs font-medium flex items-center gap-2.5 max-w-md ${
            toast.tone === 'error'
              ? 'bg-rose-950 text-rose-50 border-rose-800'
              : toast.tone === 'success'
                ? 'bg-slate-950 text-white border-slate-800'
                : toast.tone === 'warning'
                  ? 'bg-amber-950 text-amber-50 border-amber-800'
                  : 'bg-slate-900 text-slate-100 border-slate-800'
          }`}
        >
          <span>{toast.message}</span>
          <button
            type="button"
            onClick={clearToast}
            aria-label="关闭提示"
            className="p-0.5 rounded opacity-70 hover:opacity-100"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
