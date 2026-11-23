export type PinTag = '' | '捆1' | '捆2' | '捆物' | '自留' | '热烫';
export type PriceStep = 0.5 | 1 | 5;
export type WeightSource = 'market_db' | 'vlm_guess' | 'manual';
export type MerchCategory = '通用' | '吧唧' | '立牌' | '色纸' | '盲抽周边';

export const PIN_TAGS: PinTag[] = ['', '热烫', '捆1', '捆2', '捆物', '自留'];
export const MERCH_CATEGORIES: MerchCategory[] = ['通用', '吧唧', '立牌', '色纸', '盲抽周边'];

export interface GoodItem {
  id: string;
  /** 归一化锚点坐标 (0.02 ~ 0.98) */
  x: number;
  y: number;
  /** 归一化检测框 [ymin, xmin, ymax, xmax] (0 ~ 1)，用于“单谷裁切到剪贴板” */
  box?: [number, number, number, number];
  label: string;
  weight: number; // 正数，默认 1.0
  quantity: number; // 常规抱盒为 1；盲抽二调可为 0 或 >= 2
  price: number; // 单价
  locked: boolean;
  tag: PinTag;
  minPrice?: number;
  maxPrice?: number;
  prepaidPrice?: number; // 盲抽二调：开团预收单价
  weightSource?: WeightSource;
}

export interface CostConfig {
  mode: 'direct' | 'foreign';
  targetTotal: number; // 目标总价（direct 模式手填；foreign 模式自动算得）
  foreignPrice: number; // 外币原价（如日元）
  exchangeRate: number; // 汇率（如 0.048）
  shippingFee: number; // 国际/国内运费（人民币）
  feeRate: number; // 手续费率（如 0.01 表示 1%）
  step: PriceStep; // 调价最小步长：0.5 / 1 / 5
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

export interface AppSettings {
  inviteCode: string;
  contributeMarket: boolean;
  exportConfig: ExportConfig;
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
}

export interface QuotaInfo {
  code: string;
  dailyLimit: number;
  usedToday: number;
  remainingToday: number;
}

export interface DetectedGoodItem {
  label: string;
  box: [number, number, number, number];
  x: number;
  y: number;
  weight: number;
  weightSource: WeightSource;
}

export interface DetectApiResult {
  ipName: string;
  providerUsed: string;
  items: DetectedGoodItem[];
  quota?: QuotaInfo;
}
