import { create } from 'zustand';
import {
  GAMMA_MAX,
  GAMMA_MIN,
  WEIGHT_MAX,
  WEIGHT_MIN,
  type AiProtocol,
  type AiProviderConfig,
  type AppSettings,
  type CostConfig,
  type ExportConfig,
  type GachaProject,
  type GoodItem,
  type MerchCategory,
  type PinTag,
  type ProjectSummary,
  type QuotaInfo,
  type RebalanceResult,
} from '../types/pricing';
import {
  calcEffectiveAvgPrice,
  calcTargetTotal,
  clampGamma,
  clampWeight,
  distributeBlindBoxQuantities,
  rebalanceItems,
} from '../core/rebalancer';
import {
  deleteProjectFromStorage,
  listProjectSummaries,
  loadProjectFromStorage,
  saveProjectToStorage,
} from '../core/projectStorage';
import { createSeedDemoProjects } from '../core/demoProjects';
import { createThumbnailDataUrl, loadImageElement, prepareImageBlobForDetect } from '../core/canvasExport';
import {
  autoPriceGoodsApi,
  contributeMarketApi,
  detectGoodsApi,
  lookupMarketPricesApi,
} from '../api/client';

const SETTINGS_STORAGE_KEY = 'gacha_pricer_settings_v1';
const MAX_HISTORY = 50;
const VALID_PROTOCOLS: AiProtocol[] = ['server_default', 'openai_compatible', 'gemini', 'anthropic'];

interface HistorySnapshot {
  cost: CostConfig;
  items: GoodItem[];
  name: string;
  ipName: string;
  category: MerchCategory;
}

export interface ToastNotice {
  id: number;
  tone: 'info' | 'success' | 'warning' | 'error';
}

export interface ToastNoticeFull extends ToastNotice {
  message: string;
}

const DEFAULT_AI_CONFIG: AiProviderConfig = {
  protocol: 'server_default',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
};

function loadPersistedSettings(): AppSettings {
  const defaults: AppSettings = {
    inviteCode: 'dev-local-001',
    contributeMarket: true,
    exportConfig: {
      displayMode: 'label_and_price',
      scale: 1.0,
      showTag: true,
    },
    aiConfig: { ...DEFAULT_AI_CONFIG },
  };
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const savedProto = parsed.aiConfig?.protocol;
    const protocol: AiProtocol =
      savedProto && VALID_PROTOCOLS.includes(savedProto) ? savedProto : 'server_default';
    return {
      inviteCode:
        typeof parsed.inviteCode === 'string' && parsed.inviteCode.trim()
          ? parsed.inviteCode
          : defaults.inviteCode,
      contributeMarket:
        typeof parsed.contributeMarket === 'boolean'
          ? parsed.contributeMarket
          : defaults.contributeMarket,
      exportConfig: {
        displayMode:
          parsed.exportConfig?.displayMode === 'price_only' ? 'price_only' : 'label_and_price',
        scale:
          typeof parsed.exportConfig?.scale === 'number'
            ? Math.min(1.4, Math.max(0.8, parsed.exportConfig.scale))
            : 1.0,
        showTag:
          typeof parsed.exportConfig?.showTag === 'boolean' ? parsed.exportConfig.showTag : true,
      },
      aiConfig: {
        protocol,
        apiKey: typeof parsed.aiConfig?.apiKey === 'string' ? parsed.aiConfig.apiKey : '',
        baseUrl:
          typeof parsed.aiConfig?.baseUrl === 'string' && parsed.aiConfig.baseUrl.trim()
            ? parsed.aiConfig.baseUrl
            : DEFAULT_AI_CONFIG.baseUrl,
        model:
          typeof parsed.aiConfig?.model === 'string' && parsed.aiConfig.model.trim()
            ? parsed.aiConfig.model
            : DEFAULT_AI_CONFIG.model,
      },
    };
  } catch {
    return defaults;
  }
}

function savePersistedSettings(settings: AppSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage errors
  }
}

function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `gp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function snapshotOf(project: GachaProject): HistorySnapshot {
  return {
    cost: { ...project.cost },
    items: project.items.map((it) => ({ ...it })),
    name: project.name,
    ipName: project.ipName,
    category: project.category,
  };
}

function computeRebalance(project: GachaProject | null): RebalanceResult {
  if (!project) {
    return {
      items: [],
      targetTotal: 0,
      actualTotal: 0,
      residual: 0,
      status: 'OK',
      exceedAmount: 0,
    };
  }
  const target = calcTargetTotal(project.cost);
  return rebalanceItems(project.items, target, project.cost.step, project.cost.gamma ?? 1.0);
}

type EditableItemPatch = Partial<
  Pick<
    GoodItem,
    | 'label'
    | 'seriesHint'
    | 'itemType'
    | 'jpKeywords'
    | 'weight'
    | 'quantity'
    | 'tag'
    | 'minPrice'
    | 'maxPrice'
    | 'prepaidPrice'
    | 'locked'
  >
>;

interface PricerState {
  initialized: boolean;
  projects: ProjectSummary[];
  activeProject: GachaProject | null;
  rebalance: RebalanceResult;
  selectedItemId: string | null;
  canvasMode: 'select' | 'add_pin';
  isDetecting: boolean;
  isAutoPricing: boolean;
  isLookingUpPrices: boolean;
  lookupItemIds: string[];
  /** Session-only organizer Bearer tokens held strictly in JS memory */
  ownerTokensByShareCode: Record<string, string>;
  quota: QuotaInfo | null;
  settings: AppSettings;
  past: HistorySnapshot[];
  future: HistorySnapshot[];
  toast: ToastNoticeFull | null;

  // Actions
  initWorkspace: () => Promise<void>;
  notify: (message: string, tone?: ToastNotice['tone']) => void;
  clearToast: () => void;

  selectProject: (projectId: string) => Promise<void>;
  createBlankProject: () => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  loadImageIntoActiveProject: (imageDataUrl: string, suggestedName?: string) => Promise<void>;

  updateProjectMeta: (patch: { name?: string; ipName?: string; category?: MerchCategory }) => void;
  updateCostConfig: (patch: Partial<CostConfig>) => void;

  setSelectedItemId: (id: string | null) => void;
  setCanvasMode: (mode: 'select' | 'add_pin') => void;

  addPinAt: (x: number, y: number) => void;
  generateGridPins: (rows: number, cols: number, replaceExisting: boolean) => void;
  movePinPosition: (id: string, x: number, y: number, commitHistory?: boolean) => void;
  updateItemPriceAndLock: (id: string, price: number) => void;
  adjustItemPriceStep: (id: string, delta: number) => void;
  toggleItemLock: (id: string) => void;
  updateItemField: (id: string, patch: EditableItemPatch) => void;
  deleteItem: (id: string) => void;
  unlockAllItems: () => void;
  resetEqualWeights: () => void;

  applyBlindBoxPreset: (options: {
    mode: 'boxes' | 'total_draws';
    boxCount?: number;
    totalDraws?: number;
    scaleTargetTotal?: boolean;
    snapshotPrepaid?: boolean;
  }) => void;

  runAiDetect: () => Promise<void>;
  runAiAutoPrice: () => Promise<void>;
  runBatchPriceLookup: (forceRefresh?: boolean) => Promise<void>;
  runSingleItemPriceLookup: (
    itemId: string,
    overrides?: {
      seriesHint?: string;
      itemType?: string;
      jpKeywords?: string;
      forceRefresh?: boolean;
    }
  ) => Promise<void>;
  contributeCurrentProjectQuietly: () => Promise<void>;

  registerPublishedGroup: (shareCode: string, ownerToken: string) => void;

  undo: () => void;
  redo: () => void;

  updateSettings: (patch: Partial<AppSettings>) => void;
  updateAiConfig: (patch: Partial<AiProviderConfig>) => void;
  updateExportConfig: (patch: Partial<ExportConfig>) => void;
  setQuota: (quota: QuotaInfo | null) => void;
}

let persistTimer: number | null = null;
let toastCounter = 1;

function scheduleProjectSave(project: GachaProject, onSaved: (summary: ProjectSummary) => void) {
  if (typeof window === 'undefined') return;
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
  }
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void saveProjectToStorage(project).then(onSaved);
  }, 180);
}

export const usePricerStore = create<PricerState>((set, get) => {
  const applyMutation = (
    updater: (project: GachaProject) => GachaProject,
    options?: { pushHistory?: boolean; rebalanceNow?: boolean }
  ) => {
    const state = get();
    const current = state.activeProject;
    if (!current) return;

    const pushHistory = options?.pushHistory !== false;
    const rebalanceNow = options?.rebalanceNow !== false;

    const prevSnap = pushHistory ? snapshotOf(current) : null;
    const updatedRaw = updater(current);
    const updatedWithTime: GachaProject = {
      ...updatedRaw,
      updatedAt: new Date().toISOString(),
    };

    const rebalanced = rebalanceNow
      ? computeRebalance(updatedWithTime)
      : {
          ...state.rebalance,
          items: updatedWithTime.items,
        };

    const finalProject: GachaProject = {
      ...updatedWithTime,
      items: rebalanced.items,
    };

    const nextPast = prevSnap
      ? [...state.past.slice(-(MAX_HISTORY - 1)), prevSnap]
      : state.past;

    set({
      activeProject: finalProject,
      rebalance: rebalanced,
      past: nextPast,
      future: prevSnap ? [] : state.future,
    });

    scheduleProjectSave(finalProject, (summary) => {
      set((s) => ({
        projects: [summary, ...s.projects.filter((p) => p.id !== summary.id)],
      }));
    });
  };

  return {
    initialized: false,
    projects: [],
    activeProject: null,
    rebalance: {
      items: [],
      targetTotal: 0,
      actualTotal: 0,
      residual: 0,
      status: 'OK',
      exceedAmount: 0,
    },
    selectedItemId: null,
    canvasMode: 'select',
    isDetecting: false,
    isAutoPricing: false,
    isLookingUpPrices: false,
    lookupItemIds: [],
    ownerTokensByShareCode: {},
    quota: null,
    settings: loadPersistedSettings(),
    past: [],
    future: [],
    toast: null,

    notify: (message, tone = 'info') => {
      const id = ++toastCounter;
      set({ toast: { id, tone, message } });
      if (typeof window !== 'undefined') {
        window.setTimeout(() => {
          set((s) => (s.toast?.id === id ? { toast: null } : s));
        }, 4200);
      }
    },

    clearToast: () => set({ toast: null }),

    initWorkspace: async () => {
      if (get().initialized) return;
      let summaries = await listProjectSummaries();

      if (summaries.length === 0) {
        const demos = createSeedDemoProjects();
        const savedSummaries: ProjectSummary[] = [];
        for (const demo of demos) {
          savedSummaries.push(await saveProjectToStorage(demo));
        }
        summaries = savedSummaries.sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      }

      const firstId = summaries[0]?.id;
      const active = firstId ? await loadProjectFromStorage(firstId) : null;
      const rebalanced = computeRebalance(active);

      set({
        initialized: true,
        projects: summaries,
        activeProject: active ? { ...active, items: rebalanced.items } : null,
        rebalance: rebalanced,
        selectedItemId: null,
        past: [],
        future: [],
      });
    },

    selectProject: async (projectId) => {
      const loaded = await loadProjectFromStorage(projectId);
      if (!loaded) {
        get().notify('无法加载该拼团工程。', 'error');
        return;
      }
      const rebalanced = computeRebalance(loaded);
      set({
        activeProject: { ...loaded, items: rebalanced.items },
        rebalance: rebalanced,
        selectedItemId: null,
        canvasMode: 'select',
        past: [],
        future: [],
      });
    },

    createBlankProject: async () => {
      const now = new Date().toISOString();
      const blank: GachaProject = {
        version: 1,
        id: createUuid(),
        name: `新拼团 ${new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`,
        ipName: '',
        category: '吧唧',
        updatedAt: now,
        naturalWidth: 0,
        naturalHeight: 0,
        imageDataUrl: '',
        cost: {
          mode: 'direct',
          targetTotal: 200,
          foreignPrice: 4000,
          exchangeRate: 0.048,
          shippingFee: 30,
          feeRate: 0.01,
          step: 1,
          gamma: 1.0,
        },
        items: [],
      };
      const summary = await saveProjectToStorage(blank);
      set((s) => ({
        projects: [summary, ...s.projects.filter((p) => p.id !== summary.id)],
        activeProject: blank,
        rebalance: computeRebalance(blank),
        selectedItemId: null,
        canvasMode: 'select',
        past: [],
        future: [],
      }));
      get().notify('已新建空白拼团，按 Ctrl+V 可直接粘贴截图。', 'info');
    },

    deleteProject: async (projectId) => {
      await deleteProjectFromStorage(projectId);
      const remaining = get().projects.filter((p) => p.id !== projectId);
      const wasActive = get().activeProject?.id === projectId;

      if (wasActive) {
        if (remaining.length > 0) {
          const nextProj = await loadProjectFromStorage(remaining[0].id);
          const rebalanced = computeRebalance(nextProj);
          set({
            projects: remaining,
            activeProject: nextProj ? { ...nextProj, items: rebalanced.items } : null,
            rebalance: rebalanced,
            selectedItemId: null,
            past: [],
            future: [],
          });
        } else {
          set({ projects: [], activeProject: null, selectedItemId: null, past: [], future: [] });
          await get().createBlankProject();
        }
      } else {
        set({ projects: remaining });
      }
      get().notify('已删除该拼团记录。', 'info');
    },

    loadImageIntoActiveProject: async (imageDataUrl, suggestedName) => {
      try {
        const img = await loadImageElement(imageDataUrl);
        const thumbDataUrl = await createThumbnailDataUrl(imageDataUrl, 320);

        if (!get().activeProject) {
          await get().createBlankProject();
        }

        const current = get().activeProject!;
        const updated: GachaProject = {
          ...current,
          name:
            suggestedName && (!current.imageDataUrl || current.name.startsWith('新拼团'))
              ? suggestedName.replace(/\.[^.]+$/, '').slice(0, 32)
              : current.name,
          imageDataUrl,
          thumbDataUrl,
          naturalWidth: img.naturalWidth || 1200,
          naturalHeight: img.naturalHeight || 900,
          updatedAt: new Date().toISOString(),
        };

        const rebalanced = computeRebalance(updated);
        const finalProj = { ...updated, items: rebalanced.items };
        const summary = await saveProjectToStorage(finalProj);

        set((s) => ({
          activeProject: finalProj,
          rebalance: rebalanced,
          projects: [summary, ...s.projects.filter((p) => p.id !== summary.id)],
        }));
        get().notify('图片已载入画布，可点击「AI 识图」或「网格打点」。', 'success');
      } catch (err) {
        get().notify(err instanceof Error ? err.message : '图片载入失败', 'error');
      }
    },

    updateProjectMeta: (patch) => {
      applyMutation((proj) => ({ ...proj, ...patch }), { pushHistory: false, rebalanceNow: false });
    },

    updateCostConfig: (patch) => {
      applyMutation((proj) => {
        const nextCost: CostConfig = { ...proj.cost, ...patch };
        if (patch.gamma !== undefined) {
          nextCost.gamma = Math.min(GAMMA_MAX, Math.max(GAMMA_MIN, clampGamma(patch.gamma)));
        }
        if (nextCost.mode === 'foreign') {
          nextCost.targetTotal = calcTargetTotal(nextCost);
        }
        return { ...proj, cost: nextCost };
      });
    },

    setSelectedItemId: (id) => set({ selectedItemId: id }),
    setCanvasMode: (mode) => set({ canvasMode: mode }),

    addPinAt: (x, y) => {
      const clampedX = Math.min(0.97, Math.max(0.03, Math.round(x * 10000) / 10000));
      const clampedY = Math.min(0.96, Math.max(0.04, Math.round(y * 10000) / 10000));
      const newId = createUuid();
      applyMutation((proj) => {
        const newItem: GoodItem = {
          id: newId,
          x: clampedX,
          y: clampedY,
          label: `谷子${proj.items.length + 1}`,
          weight: 1.0,
          quantity: 1,
          price: 0,
          locked: false,
          tag: '',
          weightSource: 'manual',
        };
        return { ...proj, items: [...proj.items, newItem] };
      });
      set({ selectedItemId: newId });
    },

    generateGridPins: (rows, cols, replaceExisting) => {
      const safeRows = Math.min(10, Math.max(1, Math.floor(rows)));
      const safeCols = Math.min(10, Math.max(1, Math.floor(cols)));
      applyMutation((proj) => {
        const baseCount = replaceExisting ? 0 : proj.items.length;
        const generated: GoodItem[] = [];
        for (let r = 0; r < safeRows; r++) {
          for (let c = 0; c < safeCols; c++) {
            const x = ((c + 0.5) / safeCols) * 0.84 + 0.08;
            const y = ((r + 0.72) / safeRows) * 0.84 + 0.08;
            const idx = baseCount + r * safeCols + c + 1;
            generated.push({
              id: createUuid(),
              x: Math.round(x * 10000) / 10000,
              y: Math.round(Math.min(0.95, y) * 10000) / 10000,
              label: `谷子${idx}`,
              weight: 1.0,
              quantity: 1,
              price: 0,
              locked: false,
              tag: '',
              weightSource: 'manual',
            });
          }
        }
        return {
          ...proj,
          items: replaceExisting ? generated : [...proj.items, ...generated],
        };
      });
      set({ selectedItemId: null, canvasMode: 'select' });
      get().notify(`已生成 ${safeRows}×${safeCols} 共 ${safeRows * safeCols} 个网格打点并自动平账。`, 'success');
    },

    movePinPosition: (id, x, y, commitHistory = false) => {
      const clampedX = Math.min(0.97, Math.max(0.03, Math.round(x * 10000) / 10000));
      const clampedY = Math.min(0.96, Math.max(0.04, Math.round(y * 10000) / 10000));
      applyMutation(
        (proj) => ({
          ...proj,
          items: proj.items.map((it) => (it.id === id ? { ...it, x: clampedX, y: clampedY } : it)),
        }),
        { pushHistory: commitHistory, rebalanceNow: false }
      );
    },

    updateItemPriceAndLock: (id, price) => {
      const safePrice = Math.max(0, Number.isFinite(price) ? Math.round(price * 100) / 100 : 0);
      applyMutation((proj) => ({
        ...proj,
        items: proj.items.map((it) =>
          it.id === id ? { ...it, price: safePrice, locked: true } : it
        ),
      }));
    },

    adjustItemPriceStep: (id, delta) => {
      const current = get().activeProject?.items.find((it) => it.id === id);
      if (!current) return;
      const nextPrice = Math.max(0, Math.round((current.price + delta) * 100) / 100);
      get().updateItemPriceAndLock(id, nextPrice);
    },

    toggleItemLock: (id) => {
      applyMutation((proj) => ({
        ...proj,
        items: proj.items.map((it) => (it.id === id ? { ...it, locked: !it.locked } : it)),
      }));
    },

    updateItemField: (id, patch) => {
      const onlyMeta =
        patch.weight === undefined &&
        patch.quantity === undefined &&
        patch.minPrice === undefined &&
        patch.maxPrice === undefined &&
        patch.locked === undefined;

      applyMutation(
        (proj) => ({
          ...proj,
          items: proj.items.map((it) => {
            if (it.id !== id) return it;
            const next = { ...it, ...patch };
            if (patch.weight !== undefined) {
              next.weight = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, clampWeight(patch.weight)));
              next.weightSource = 'manual';
            }
            if (patch.tag !== undefined) {
              next.tag = patch.tag as PinTag;
            }
            return next;
          }),
        }),
        { rebalanceNow: !onlyMeta }
      );
    },

    deleteItem: (id) => {
      applyMutation((proj) => ({
        ...proj,
        items: proj.items.filter((it) => it.id !== id),
      }));
      if (get().selectedItemId === id) {
        set({ selectedItemId: null });
      }
    },

    unlockAllItems: () => {
      applyMutation((proj) => ({
        ...proj,
        items: proj.items.map((it) => ({ ...it, locked: false })),
      }));
      get().notify('已解锁全部单品并重新平账。', 'info');
    },

    resetEqualWeights: () => {
      applyMutation((proj) => ({
        ...proj,
        cost: { ...proj.cost, gamma: 1.0 },
        items: proj.items.map((it) => ({
          ...it,
          weight: 1.0,
          locked: false,
          weightSource: 'manual',
        })),
      }));
      get().notify('已重置所有单品为均价权重（γ = 1.0）。', 'info');
    },

    applyBlindBoxPreset: (options) => {
      applyMutation((proj) => {
        const nextItems = distributeBlindBoxQuantities(proj.items, {
          mode: options.mode,
          boxCount: options.boxCount,
          totalDraws: options.totalDraws,
          snapshotPrepaid: options.snapshotPrepaid !== false,
        });

        let nextCost = { ...proj.cost };
        if (options.scaleTargetTotal && options.mode === 'boxes' && options.boxCount && options.boxCount >= 1) {
          // Estimate 1-box base cost from current per-item sum if all items were 1 per box
          const oneBoxSum = proj.items.reduce((sum, it) => sum + (it.prepaidPrice ?? it.price), 0);
          if (oneBoxSum > 0) {
            const newTotal = Math.round(oneBoxSum * options.boxCount * 100) / 100;
            nextCost = {
              ...nextCost,
              mode: 'direct',
              targetTotal: newTotal,
            };
          }
        }

        return {
          ...proj,
          cost: nextCost,
          items: nextItems,
        };
      });
    },

    runAiDetect: async () => {
      const { activeProject, settings, isDetecting } = get();
      if (isDetecting) return;
      if (!activeProject || !activeProject.imageDataUrl) {
        get().notify('请先粘贴或上传一张谷子拼团图后再识图。', 'warning');
        return;
      }

      set({ isDetecting: true });
      try {
        const blob = await prepareImageBlobForDetect(activeProject.imageDataUrl);
        const result = await detectGoodsApi({
          imageBlob: blob,
          inviteCode: settings.inviteCode,
          aiConfig: settings.aiConfig,
          ipHint: activeProject.ipName,
          category: activeProject.category,
        });

        applyMutation((proj) => ({
          ...proj,
          ipName: result.ipName || proj.ipName,
          items: result.items.map((it) => ({
            id: createUuid(),
            x: it.x,
            y: it.y,
            box: it.box,
            label: it.label,
            seriesHint: it.seriesHint,
            itemType: it.itemType,
            jpKeywords: it.jpKeywords,
            weight: it.weight,
            quantity: 1,
            price: 0,
            locked: false,
            tag: it.weight >= 1.5 ? '热烫' : it.weight <= 0.65 ? '捆物' : '',
            weightSource: it.weightSource,
            marketPrice: it.marketPrice,
          })),
        }));

        const marketLookupHits = result.items.filter((it) => it.weightSource === 'market_lookup').length;
        const marketDbHits = result.items.filter((it) => it.weightSource === 'market_db').length;
        set({ quota: result.quota ?? get().quota, selectedItemId: null });

        const hitNotes: string[] = [];
        if (marketLookupHits > 0) hitNotes.push(`${marketLookupHits}项查得闲鱼/煤炉市价`);
        if (marketDbHits > 0) hitNotes.push(`${marketDbHits}项命中历史行情库`);

        get().notify(
          `AI（${result.providerUsed}）识别出 ${result.items.length} 个谷子（${result.ipName}）${hitNotes.length > 0 ? `，${hitNotes.join('、')}` : ''}。`,
          'success'
        );
      } catch (err) {
        get().notify(err instanceof Error ? err.message : 'AI 识图失败', 'error');
      } finally {
        set({ isDetecting: false });
      }
    },

    runAiAutoPrice: async () => {
      const { activeProject, rebalance, settings, isAutoPricing } = get();
      if (isAutoPricing) return;
      if (!activeProject || activeProject.items.length < 2) {
        get().notify('画布中至少需要 2 个单品才能使用 AI 自动调价。', 'warning');
        return;
      }

      set({ isAutoPricing: true });
      try {
        const result = await autoPriceGoodsApi({
          inviteCode: settings.inviteCode,
          aiConfig: settings.aiConfig,
          ipName: activeProject.ipName,
          category: activeProject.category,
          targetTotal: rebalance.targetTotal,
          items: rebalance.items,
        });

        const recById = new Map(result.items.map((r) => [r.id, r]));
        applyMutation((proj) => ({
          ...proj,
          ipName: result.ipName || proj.ipName,
          items: proj.items.map((it) => {
            const rec = recById.get(it.id);
            if (!rec) return it;
            if (it.locked) {
              return {
                ...it,
                tag: it.tag || rec.tag,
                marketPrice: rec.marketPrice ?? it.marketPrice,
              };
            }
            return {
              ...it,
              weight: rec.weight,
              tag: rec.tag,
              weightSource: rec.weightSource,
              marketPrice: rec.marketPrice ?? it.marketPrice,
            };
          }),
        }));

        const marketLookupHits = result.items.filter((it) => it.weightSource === 'market_lookup').length;
        const marketDbHits = result.items.filter((it) => it.weightSource === 'market_db').length;
        const summaryNote = result.summary ? `：${result.summary}` : '';
        get().notify(
          `AI 自动调价完成（${result.providerUsed}${marketLookupHits > 0 ? ` · ${marketLookupHits}项真实市价` : marketDbHits > 0 ? ` · ${marketDbHits}项行情库` : ''}）${summaryNote}`,
          'success'
        );
      } catch (err) {
        get().notify(err instanceof Error ? err.message : 'AI 自动调价失败', 'error');
      } finally {
        set({ isAutoPricing: false });
      }
    },

    runBatchPriceLookup: async (forceRefresh = false) => {
      const { activeProject, rebalance, settings, isLookingUpPrices } = get();
      if (isLookingUpPrices) return;
      if (!activeProject || rebalance.items.length === 0) {
        get().notify('当前没有可比价的谷子单品。', 'warning');
        return;
      }

      const targetIds = rebalance.items.map((it) => it.id);
      set({ isLookingUpPrices: true, lookupItemIds: targetIds });

      try {
        const out = await lookupMarketPricesApi({
          inviteCode: settings.inviteCode,
          aiConfig: settings.aiConfig,
          ipName: activeProject.ipName,
          category: activeProject.category,
          jpyRate: activeProject.cost.exchangeRate,
          forceRefresh,
          items: rebalance.items.map((it) => ({
            id: it.id,
            label: it.label,
            seriesHint: it.seriesHint,
            itemType: it.itemType || activeProject.category,
            jpKeywords: it.jpKeywords,
            weight: it.weight,
            forceRefresh,
          })),
        });

        const byId = new Map(out.items.map((r) => [r.id, r]));
        applyMutation((proj) => ({
          ...proj,
          items: proj.items.map((it) => {
            const hit = byId.get(it.id);
            if (!hit) return it;
            if (it.locked) {
              return {
                ...it,
                marketPrice: hit.marketPrice,
              };
            }
            return {
              ...it,
              weight: hit.weight,
              weightSource: hit.weightSource,
              marketPrice: hit.marketPrice,
              tag:
                it.tag ||
                (hit.weight >= 1.55 ? '热烫' : hit.weight <= 0.62 ? '捆物' : ''),
            };
          }),
        }));

        const exactHits = out.items.filter(
          (r) => r.marketPrice.marketPriceMedian !== null
        ).length;
        get().notify(
          exactHits > 0
            ? `全团比价完成：${exactHits}/${out.items.length} 款命中闲鱼/煤炉近期市价，已按市价比例平账。`
            : '已完成比价检索：暂无近期同款挂单，已使用本地历史行情与热度兜底。',
          exactHits > 0 ? 'success' : 'info'
        );
      } catch (err) {
        get().notify(err instanceof Error ? err.message : '全团比价失败', 'error');
      } finally {
        set({ isLookingUpPrices: false, lookupItemIds: [] });
      }
    },

    runSingleItemPriceLookup: async (itemId, overrides) => {
      const { activeProject, rebalance, settings } = get();
      if (!activeProject) return;
      const target = rebalance.items.find((it) => it.id === itemId);
      if (!target) return;

      set((s) => ({
        isLookingUpPrices: true,
        lookupItemIds: Array.from(new Set([...s.lookupItemIds, itemId])),
      }));

      // Compute reference market average from existing items' medians or current group avg price
      const existingMedians = rebalance.items
        .filter((it) => it.id !== itemId && it.marketPrice?.marketPriceMedian)
        .map((it) => it.marketPrice!.marketPriceMedian!);
      const refAvg =
        existingMedians.length > 0
          ? existingMedians.reduce((s, v) => s + v, 0) / existingMedians.length
          : calcEffectiveAvgPrice(rebalance.items) || 35;

      const nextSeriesHint = overrides?.seriesHint ?? target.seriesHint;
      const nextItemType = overrides?.itemType ?? target.itemType ?? activeProject.category;
      const nextJpKeywords = overrides?.jpKeywords ?? target.jpKeywords;

      try {
        const out = await lookupMarketPricesApi({
          inviteCode: settings.inviteCode,
          aiConfig: settings.aiConfig,
          ipName: activeProject.ipName,
          category: activeProject.category,
          jpyRate: activeProject.cost.exchangeRate,
          referenceAvgPrice: refAvg,
          forceRefresh: overrides?.forceRefresh ?? true,
          items: [
            {
              id: target.id,
              label: target.label,
              seriesHint: nextSeriesHint,
              itemType: nextItemType,
              jpKeywords: nextJpKeywords,
              weight: target.weight,
              forceRefresh: overrides?.forceRefresh ?? true,
            },
          ],
        });

        const resItem = out.items[0];
        if (!resItem) return;

        applyMutation((proj) => ({
          ...proj,
          items: proj.items.map((it) => {
            if (it.id !== itemId) return it;
            return {
              ...it,
              seriesHint: nextSeriesHint,
              itemType: nextItemType,
              jpKeywords: nextJpKeywords,
              weight: it.locked ? it.weight : resItem.weight,
              weightSource: it.locked ? it.weightSource : resItem.weightSource,
              marketPrice: resItem.marketPrice,
            };
          }),
        }));

        if (resItem.marketPrice.marketPriceMedian !== null) {
          get().notify(
            `「${target.label}」最新参考市价 ¥${resItem.marketPrice.marketPriceMedian}（样本 ${resItem.marketPrice.sampleCount} 条），已更新权重。`,
            'success'
          );
        } else {
          get().notify(
            `「${target.label}」暂未检索到近 90 天二手单出报价，已回退行情权重 ×${resItem.weight.toFixed(2)}。`,
            'info'
          );
        }
      } catch (err) {
        get().notify(err instanceof Error ? err.message : '单品重查失败', 'error');
      } finally {
        set((s) => {
          const nextIds = s.lookupItemIds.filter((id) => id !== itemId);
          return {
            lookupItemIds: nextIds,
            isLookingUpPrices: nextIds.length > 0,
          };
        });
      }
    },

    contributeCurrentProjectQuietly: async () => {
      const { activeProject, rebalance, settings } = get();
      if (!settings.contributeMarket || !activeProject || !activeProject.ipName.trim()) return;
      const validItems = rebalance.items.filter((it) => it.quantity > 0 && it.price > 0);
      if (validItems.length < 2) return;
      const avgPrice = calcEffectiveAvgPrice(validItems);
      if (avgPrice <= 0) return;

      try {
        await contributeMarketApi({
          inviteCode: settings.inviteCode,
          projectId: activeProject.id,
          ipName: activeProject.ipName,
          category: activeProject.category,
          avgPrice,
          items: validItems.map((it) => ({
            label: it.label,
            finalPrice: it.price,
          })),
        });
      } catch {
        // Silent failure: never disrupt local export UX
      }
    },

    registerPublishedGroup: (shareCode, ownerToken) => {
      const upper = shareCode.trim().toUpperCase();
      set((s) => ({
        ownerTokensByShareCode: {
          ...s.ownerTokensByShareCode,
          [upper]: ownerToken,
        },
      }));
      applyMutation(
        (proj) => ({
          ...proj,
          publishedGroup: {
            shareCode: upper,
            publishedAt: new Date().toISOString(),
          },
        }),
        { pushHistory: false, rebalanceNow: false }
      );
    },

    undo: () => {
      const { past, activeProject, future } = get();
      if (past.length === 0 || !activeProject) return;
      const previous = past[past.length - 1];
      const currentSnap = snapshotOf(activeProject);
      const restored: GachaProject = {
        ...activeProject,
        cost: previous.cost,
        items: previous.items,
        name: previous.name,
        ipName: previous.ipName,
        category: previous.category,
        updatedAt: new Date().toISOString(),
      };
      const rebalanced = computeRebalance(restored);
      const finalProject = { ...restored, items: rebalanced.items };

      set({
        activeProject: finalProject,
        rebalance: rebalanced,
        past: past.slice(0, -1),
        future: [currentSnap, ...future.slice(0, MAX_HISTORY - 1)],
      });
      scheduleProjectSave(finalProject, (summary) => {
        set((s) => ({
          projects: [summary, ...s.projects.filter((p) => p.id !== summary.id)],
        }));
      });
    },

    redo: () => {
      const { future, activeProject, past } = get();
      if (future.length === 0 || !activeProject) return;
      const next = future[0];
      const currentSnap = snapshotOf(activeProject);
      const restored: GachaProject = {
        ...activeProject,
        cost: next.cost,
        items: next.items,
        name: next.name,
        ipName: next.ipName,
        category: next.category,
        updatedAt: new Date().toISOString(),
      };
      const rebalanced = computeRebalance(restored);
      const finalProject = { ...restored, items: rebalanced.items };

      set({
        activeProject: finalProject,
        rebalance: rebalanced,
        past: [...past.slice(-(MAX_HISTORY - 1)), currentSnap],
        future: future.slice(1),
      });
      scheduleProjectSave(finalProject, (summary) => {
        set((s) => ({
          projects: [summary, ...s.projects.filter((p) => p.id !== summary.id)],
        }));
      });
    },

    updateSettings: (patch) => {
      const next: AppSettings = { ...get().settings, ...patch };
      savePersistedSettings(next);
      set({ settings: next });
    },

    updateAiConfig: (patch) => {
      const current = get().settings;
      const next: AppSettings = {
        ...current,
        aiConfig: { ...current.aiConfig, ...patch },
      };
      savePersistedSettings(next);
      set({ settings: next });
    },

    updateExportConfig: (patch) => {
      const current = get().settings;
      const next: AppSettings = {
        ...current,
        exportConfig: { ...current.exportConfig, ...patch },
      };
      savePersistedSettings(next);
      set({ settings: next });
    },

    setQuota: (quota) => set({ quota }),
  };
});
