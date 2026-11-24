export type PinTag = '' | '捆1' | '捆2' | '捆物' | '自留' | '热烫';
export type PriceStep = 0.5 | 1 | 5;
export type WeightSource = 'market_lookup' | 'market_db' | 'vlm_guess' | 'manual';
export type MerchCategory = '通用' | '吧唧' | '立牌' | '色纸' | '拍立得' | '挂件' | '盲抽周边';
export type PricingTier = 'exact_market' | 'char_market' | 'local_db' | 'vlm_fallback';
export type PriceFreshness = 'fresh' | 'recent' | 'stale';

export const PIN_TAGS: PinTag[] = ['', '热烫', '捆1', '捆2', '捆物', '自留'];
export const MERCH_CATEGORIES: MerchCategory[] = [
  '通用',
  '吧唧',
  '立牌',
  '色纸',
  '拍立得',
  '挂件',
  '盲抽周边',
];

export const WEIGHT_MIN = 0.1;
export const WEIGHT_MAX = 10.0;
export const GAMMA_MIN = 0.5;
export const GAMMA_MAX = 2.5;

export interface MarketPriceSourceSample {
  platform: string; // e.g. '闲鱼' | '煤炉 Mercari' | '行情库'
  title: string;
  rawPrice: number;
  currency: 'CNY' | 'JPY';
  cnyPrice: number;
  listedAt: string; // YYYY-MM-DD or ISO
  url?: string;
  freshness: PriceFreshness;
  sold?: boolean;
}

export interface ItemMarketPriceInfo {
  marketPriceMedian: number | null;
  marketPriceRange: [number, number] | null;
  sampleCount: number;
  sources: MarketPriceSourceSample[];
  pricingTier: PricingTier;
  freshness: PriceFreshness;
  fromCache?: boolean;
  cachedAt?: string;
  queryUsed?: string;
}

export interface GoodItem {
  id: string;
  /** 归一化锚点坐标 (0.02 ~ 0.98) */
  x: number;
  y: number;
  /** 归一化检测框 [ymin, xmin, ymax, xmax] (0 ~ 1)，用于“单谷裁切到剪贴板” */
  box?: [number, number, number, number];
  label: string;
  /** V2.0 系列/柄图特征（如“原画展吧唧”） */
  seriesHint?: string;
  /** V2.0 细化品类（如“吧唧”、“立牌”） */
  itemType?: string;
  /** V2.0 日文检索关键词（如“ハイキュー 孤爪研磨 缶バッジ”） */
  jpKeywords?: string;
  weight: number; // V2.0 放宽至 [0.1, 10.0]，默认 1.0
  quantity: number; // 常规抱盒为 1；盲抽二调可为 0 或 >= 2
  price: number; // 单价
  locked: boolean;
  tag: PinTag;
  minPrice?: number;
  maxPrice?: number;
  prepaidPrice?: number; // 盲抽二调：开团预收单价
  weightSource?: WeightSource;
  /** V2.0 可追溯的外部市场比价信息 */
  marketPrice?: ItemMarketPriceInfo;
}

export interface CostConfig {
  mode: 'direct' | 'foreign';
  targetTotal: number; // 目标总价（direct 模式手填；foreign 模式自动算得）
  foreignPrice: number; // 外币原价（如日元）
  exchangeRate: number; // 汇率（如 0.048）
  shippingFee: number; // 国际/国内运费（人民币）
  feeRate: number; // 手续费率（如 0.01 表示 1%）
  step: PriceStep; // 调价最小步长：0.5 / 1 / 5
  /** V2.0 冷烫温差系数 γ ∈ [0.5, 2.5]，默认 1.0 */
  gamma?: number;
}

export interface GachaProjectMeta {
  version: 1;
  id: string;
  name: string;
  ipName: string;
  category: MerchCategory;
  updatedAt: string; // ISO 8601
  naturalWidth: number;
  naturalHeight: number;
  thumbDataUrl?: string; // 轻量缩略图，供左侧工程列表快速渲染
  cost: CostConfig;
  items: GoodItem[];
  /** V2.0 若已发布为在线拼团，保存关联信息 */
  publishedGroup?: {
    shareCode: string;
    ownerToken: string;
    publishedAt: string;
  };
}

export interface GachaProject extends GachaProjectMeta {
  imageDataUrl: string; // 完整原图 DataURL 或静态资源 URL
}

export interface ProjectSummary {
  id: string;
  name: string;
  ipName: string;
  category: MerchCategory;
  updatedAt: string;
  itemCount: number;
  targetTotal: number;
  thumbDataUrl?: string;
}

export type RebalanceStatus =
  | 'OK'
  | 'RESIDUAL_NONZERO' // 存在多数量项(Q>1)导致数学上无法整除的微小余差
  | 'LOCKED_EXCEEDS_TARGET' // 锁定项总额已超过目标总价
  | 'NO_UNLOCKED_ITEMS'; // 所有有效项均已锁定

export interface RebalanceResult {
  items: GoodItem[];
  targetTotal: number;
  actualTotal: number;
  residual: number; // actualTotal - targetTotal
  status: RebalanceStatus;
  exceedAmount: number; // 仅 LOCKED_EXCEEDS_TARGET 时 > 0
}

export interface SettlementRow {
  itemId: string;
  label: string;
  quantity: number;
  prepaidPrice: number;
  finalPrice: number;
  deltaPerItem: number; // 正数补款，负数退款
  subtotalDelta: number;
}

export interface SecondarySettlementResult {
  avgPrice: number;
  rows: SettlementRow[];
  zeroQtyLabels: string[];
  totalPrepaid: number;
  totalFinal: number;
  totalDelta: number;
  announcementText: string;
}

export interface ExportConfig {
  displayMode: 'price_only' | 'label_and_price';
  scale: number; // 0.8 ~ 1.4
  showTag: boolean;
}

export type AiProtocol = 'server_default' | 'openai_compatible' | 'gemini' | 'anthropic';

export interface AiProviderConfig {
  protocol: AiProtocol;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface AppSettings {
  inviteCode: string;
  contributeMarket: boolean;
  exportConfig: ExportConfig;
  aiConfig: AiProviderConfig;
}

export interface MarketStatItem {
  id: number;
  ipName: string;
  characterName: string;
  category: string;
  avgWeightRatio: number;
  sampleCount: number;
  updatedAt: string;
}

export interface ServerHealthInfo {
  status: string;
  provider: string;
  model: string;
  version: string;
  geminiConfigured: boolean;
  priceLookupSources?: string[];
}

export interface QuotaInfo {
  code: string;
  dailyLimit: number;
  usedToday: number;
  remainingToday: number;
}

export interface DetectedGoodItem {
  label: string;
  seriesHint?: string;
  itemType?: string;
  jpKeywords?: string;
  box: [number, number, number, number];
  x: number;
  y: number;
  weight: number;
  weightSource: WeightSource;
  marketPrice?: ItemMarketPriceInfo;
}

export interface DetectApiResult {
  ipName: string;
  providerUsed: string;
  items: DetectedGoodItem[];
  quota?: QuotaInfo;
}

export interface AutoPriceItemRecommendation {
  id: string;
  label: string;
  weight: number;
  tag: PinTag;
  weightSource: WeightSource;
  reason?: string;
  marketPrice?: ItemMarketPriceInfo;
}

export interface AutoPriceApiResult {
  ipName: string;
  providerUsed: string;
  items: AutoPriceItemRecommendation[];
  summary?: string;
}

export interface PriceLookupItemResult {
  id: string;
  label: string;
  seriesHint?: string;
  itemType?: string;
  jpKeywords?: string;
  weight: number;
  weightSource: WeightSource;
  marketPrice: ItemMarketPriceInfo;
}

export interface PriceLookupApiResult {
  ipName: string;
  jpyRate: number;
  items: PriceLookupItemResult[];
}

export interface AiTestConnectionResult {
  ok: boolean;
  providerUsed: string;
  latencyMs: number;
  replyPreview: string;
}

// --- V2.0 Phase 3: Built-in Multi-User Live Group Buy ---
export type GroupOrderStatus = 'open' | 'locked' | 'settled';

export interface GroupOrderItem {
  id: string;
  orderId: string;
  sourceItemId?: string;
  label: string;
  price: number;
  prepaidPrice?: number;
  totalQty: number;
  claimedQty: number;
  remainingQty: number;
  tag: PinTag;
  box?: [number, number, number, number];
}

export interface GroupClaim {
  id: string;
  orderId: string;
  itemId: string;
  itemLabel: string;
  buyerName: string;
  buyerContact: string;
  qty: number;
  unitPrice: number;
  prepaidPrice?: number;
  status: 'active' | 'cancelled';
  createdAt: string;
}

export interface BuyerBillRow {
  buyerName: string;
  buyerContact: string;
  totalQty: number;
  totalAmount: number;
  prepaidTotal: number;
  deltaTotal: number; // >0 需补款, <0 应退款
  items: Array<{
    itemId: string;
    label: string;
    qty: number;
    unitPrice: number;
    prepaidPrice: number;
    delta: number;
  }>;
}

export interface GroupOrderDetail {
  id: string;
  shareCode: string;
  shareUrl: string;
  title: string;
  ipName: string;
  status: GroupOrderStatus;
  annotatedImageDataUrl: string;
  createdAt: string;
  updatedAt: string;
  items: GroupOrderItem[];
  claims: GroupClaim[];
  buyerBills: BuyerBillRow[];
}
