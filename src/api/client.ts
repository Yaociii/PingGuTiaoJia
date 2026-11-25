import type {
  AiProviderConfig,
  AiTestConnectionResult,
  AutoPriceApiResult,
  BuyerBillRow,
  DetectApiResult,
  DetectedGoodItem,
  GoodItem,
  GroupClaim,
  GroupOrderDetail,
  GroupOrderItem,
  GroupOrderStatus,
  ItemMarketPriceInfo,
  MarketStatItem,
  PinTag,
  PriceFreshness,
  PriceLookupApiResult,
  PricingTier,
  QuotaInfo,
  ServerHealthInfo,
  WeightSource,
} from '../types/pricing';

interface RawHealthResponse {
  status: string;
  provider: string;
  model: string;
  version: string;
  gemini_configured?: boolean;
  price_lookup_sources?: string[];
}

interface RawQuota {
  code: string;
  daily_limit: number;
  used_today: number;
  remaining_today: number;
}

interface RawMarketPriceSource {
  platform: string;
  title: string;
  raw_price: number;
  currency: 'CNY' | 'JPY';
  cny_price: number;
  listed_at: string;
  url?: string;
  freshness: PriceFreshness;
  sold?: boolean;
}

interface RawMarketPriceInfo {
  market_price_median: number | null;
  market_price_range: [number, number] | null;
  sample_count: number;
  sources: RawMarketPriceSource[];
  pricing_tier: PricingTier;
  freshness: PriceFreshness;
  from_cache?: boolean;
  cached_at?: string;
  query_used?: string;
}

interface RawDetectItem {
  label: string;
  series_hint?: string;
  item_type?: string;
  jp_keywords?: string;
  box: [number, number, number, number];
  x: number;
  y: number;
  weight: number;
  weight_source: WeightSource;
  market_price?: RawMarketPriceInfo;
}

interface RawDetectResponse {
  ip_name: string;
  series_hint?: string;
  provider_used: string;
  items: RawDetectItem[];
  quota?: RawQuota;
}

interface RawAutoPriceItem {
  id: string;
  label: string;
  weight: number;
  tag: PinTag;
  weight_source: WeightSource;
  reason?: string;
  market_price?: RawMarketPriceInfo;
}

interface RawAutoPriceResponse {
  ip_name: string;
  provider_used: string;
  summary?: string;
  items: RawAutoPriceItem[];
}

interface RawPriceLookupItem {
  id: string;
  label: string;
  series_hint?: string;
  item_type?: string;
  jp_keywords?: string;
  weight: number;
  weight_source: WeightSource;
  market_price: RawMarketPriceInfo;
}

interface RawPriceLookupResponse {
  ip_name: string;
  jpy_rate: number;
  items: RawPriceLookupItem[];
}

interface RawTestResponse {
  ok: boolean;
  provider_used: string;
  latency_ms: number;
  reply_preview: string;
}

interface RawMarketStat {
  id: number;
  ip_name: string;
  character_name: string;
  category: string;
  avg_weight_ratio: number;
  sample_count: number;
  updated_at: string;
}

interface RawMarketStatsResponse {
  stats: RawMarketStat[];
  invite_valid?: boolean;
  quota: RawQuota | null;
}

interface RawGroupOrder {
  id: string;
  share_code: string;
  share_url: string;
  title: string;
  ip_name: string;
  status: GroupOrderStatus;
  annotated_image_data_url: string;
  created_at: string;
  updated_at: string;
  items: Array<{
    id: string;
    order_id: string;
    source_item_id?: string;
    label: string;
    price: number;
    prepaid_price?: number;
    total_qty: number;
    claimed_qty: number;
    remaining_qty: number;
    tag: string;
    box?: [number, number, number, number];
  }>;
  claims: Array<{
    id: string;
    order_id: string;
    item_id: string;
    item_label: string;
    buyer_name: string;
    buyer_contact: string;
    qty: number;
    unit_price: number;
    prepaid_price?: number;
    status: 'active' | 'cancelled';
    created_at: string;
  }>;
  buyer_bills: Array<{
    buyer_name: string;
    buyer_contact: string;
    total_qty: number;
    total_amount: number;
    prepaid_total: number;
    delta_total: number;
    items: Array<{
      item_id: string;
      label: string;
      qty: number;
      unit_price: number;
      prepaid_price: number;
      delta: number;
    }>;
  }>;
}

export interface ContributeResponse {
  accepted: boolean;
  updated_count?: number;
  reason?: string;
}

export function sanitizeSafeHref(url?: string): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    // ignore invalid URL
  }
  return undefined;
}

function mapMarketPrice(raw?: RawMarketPriceInfo): ItemMarketPriceInfo | undefined {
  if (!raw) return undefined;
  return {
    marketPriceMedian: raw.market_price_median,
    marketPriceRange: raw.market_price_range,
    sampleCount: raw.sample_count,
    sources: (raw.sources || []).map((s) => ({
      platform: s.platform,
      title: s.title,
      rawPrice: s.raw_price,
      currency: s.currency,
      cnyPrice: s.cny_price,
      listedAt: s.listed_at,
      url: sanitizeSafeHref(s.url),
      freshness: s.freshness,
      sold: s.sold,
    })),
    pricingTier: raw.pricing_tier,
    freshness: raw.freshness,
    fromCache: raw.from_cache,
    cachedAt: raw.cached_at,
    queryUsed: raw.query_used,
  };
}

export function mapGroupOrderDetail(raw: RawGroupOrder): GroupOrderDetail {
  const items: GroupOrderItem[] = (raw.items || []).map((it) => ({
    id: it.id,
    orderId: it.order_id,
    sourceItemId: it.source_item_id,
    label: it.label,
    price: it.price,
    prepaidPrice: it.prepaid_price,
    totalQty: it.total_qty,
    claimedQty: it.claimed_qty,
    remainingQty: it.remaining_qty,
    tag: (it.tag || '') as PinTag,
    box: it.box,
  }));

  const claims: GroupClaim[] = (raw.claims || []).map((c) => ({
    id: c.id,
    orderId: c.order_id,
    itemId: c.item_id,
    itemLabel: c.item_label,
    buyerName: c.buyer_name,
    buyerContact: c.buyer_contact,
    qty: c.qty,
    unitPrice: c.unit_price,
    prepaidPrice: c.prepaid_price,
    status: c.status,
    createdAt: c.created_at,
  }));

  const buyerBills: BuyerBillRow[] = (raw.buyer_bills || []).map((b) => ({
    buyerName: b.buyer_name,
    buyerContact: b.buyer_contact,
    totalQty: b.total_qty,
    totalAmount: b.total_amount,
    prepaidTotal: b.prepaid_total,
    deltaTotal: b.delta_total,
    items: (b.items || []).map((line) => ({
      itemId: line.item_id,
      label: line.label,
      qty: line.qty,
      unitPrice: line.unit_price,
      prepaidPrice: line.prepaid_price,
      delta: line.delta,
    })),
  }));

  return {
    id: raw.id,
    shareCode: raw.share_code,
    shareUrl: raw.share_url,
    title: raw.title,
    ipName: raw.ip_name,
    status: raw.status,
    annotatedImageDataUrl: raw.annotated_image_data_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    items,
    claims,
    buyerBills,
  };
}

function buildAiHeaders(inviteCode: string, aiConfig?: AiProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (inviteCode.trim()) {
    headers['X-Access-Token'] = inviteCode.trim();
  }
  if (aiConfig && aiConfig.protocol !== 'server_default') {
    headers['X-AI-Protocol'] = aiConfig.protocol;
    if (aiConfig.apiKey.trim()) {
      headers['X-AI-Api-Key'] = aiConfig.apiKey.trim();
    }
    if (aiConfig.baseUrl.trim()) {
      headers['X-AI-Base-Url'] = aiConfig.baseUrl.trim();
    }
    if (aiConfig.model.trim()) {
      headers['X-AI-Model'] = aiConfig.model.trim();
    }
  } else {
    headers['X-AI-Protocol'] = 'server_default';
  }
  return headers;
}

function mapQuota(raw?: RawQuota): QuotaInfo | undefined {
  if (!raw) return undefined;
  return {
    code: raw.code,
    dailyLimit: raw.daily_limit,
    usedToday: raw.used_today,
    remainingToday: raw.remaining_today,
  };
}

function isHtmlLikeBody(contentType: string, bodyText: string): boolean {
  if (contentType.toLowerCase().includes('text/html')) return true;
  const trimmed = bodyText.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<head');
}

function formatHtmlResponseError(res: Response, endpointLabel: string): string {
  if (res.redirected) {
    return `${endpointLabel}失败：预览访问会话可能已过期（请求被重定向至登录/网页），请刷新当前页面后重试。`;
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return `${endpointLabel}超时或网关暂不可用（HTTP ${res.status}），请稍后重试。`;
  }
  if (res.status === 413) {
    return '上传图片体积超过网关上限，请压缩图片后再试。';
  }
  return `${endpointLabel}失败：接口返回了网页内容而非 JSON（后端服务可能正在重启或处于纯静态预览模式），请刷新页面后重试。`;
}

export async function parseJsonResponse<T>(res: Response, endpointLabel = '请求'): Promise<T> {
  const contentType = res.headers?.get('content-type') || '';
  const bodyText = await res.text();

  if (isHtmlLikeBody(contentType, bodyText)) {
    throw new Error(formatHtmlResponseError(res, endpointLabel));
  }

  let parsed: unknown;
  try {
    parsed = bodyText.trim() ? JSON.parse(bodyText) : null;
  } catch {
    if (!res.ok) {
      throw new Error(formatStatusFallbackError(res.status));
    }
    throw new Error(`${endpointLabel}返回了无法解析的非 JSON 数据，请刷新页面或稍后重试。`);
  }

  if (!res.ok) {
    const detail =
      parsed && typeof parsed === 'object' && typeof (parsed as { detail?: unknown }).detail === 'string'
        ? ((parsed as { detail: string }).detail || '').trim()
        : '';
    throw new Error(detail || formatStatusFallbackError(res.status));
  }

  if (parsed === null || parsed === undefined) {
    throw new Error(`${endpointLabel}返回为空，请稍后重试。`);
  }

  return parsed as T;
}

function formatStatusFallbackError(status: number): string {
  if (status === 401) return '邀请码无效或已停用，请在设置中检查访问邀请码。';
  if (status === 413) return '图片体积超过 15MB 上限。';
  if (status === 429) return '今日识图次数已用完，请明日再试或填写自有 API Key。';
  if (status === 502) return '上游视觉模型响应异常，请检查 API Key、Base URL 与模型名称。';
  if (status === 504) return '请求超时（HTTP 504），请稍后重试。';
  return `请求失败（HTTP ${status}）`;
}

export async function fetchServerHealth(): Promise<ServerHealthInfo> {
  const res = await fetch('/api/v1/health', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  const raw = await parseJsonResponse<RawHealthResponse>(res, '服务状态检查');
  return {
    status: raw.status,
    provider: raw.provider,
    model: raw.model,
    version: raw.version,
    geminiConfigured: Boolean(raw.gemini_configured),
    priceLookupSources: raw.price_lookup_sources,
  };
}

export async function testAiConnectionApi(params: {
  inviteCode: string;
  aiConfig: AiProviderConfig;
}): Promise<AiTestConnectionResult> {
  const res = await fetch('/api/v1/ai/test', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...buildAiHeaders(params.inviteCode, params.aiConfig),
    },
    body: JSON.stringify({}),
  });

  const raw = await parseJsonResponse<RawTestResponse>(res, 'AI 连通性测试');
  return {
    ok: Boolean(raw.ok),
    providerUsed: raw.provider_used,
    latencyMs: raw.latency_ms,
    replyPreview: raw.reply_preview,
  };
}

export async function detectGoodsApi(params: {
  imageBlob: Blob;
  inviteCode: string;
  aiConfig: AiProviderConfig;
  ipHint?: string;
  category?: string;
}): Promise<DetectApiResult> {
  const form = new FormData();
  form.append('image', params.imageBlob, 'merch-sheet.jpg');
  if (params.ipHint?.trim()) {
    form.append('ip_hint', params.ipHint.trim());
  }
  if (params.category?.trim()) {
    form.append('category', params.category.trim());
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 75000);

  try {
    const res = await fetch('/api/v1/detect', {
      method: 'POST',
      credentials: 'same-origin',
      headers: buildAiHeaders(params.inviteCode, params.aiConfig),
      body: form,
      signal: controller.signal,
    });

    const raw = await parseJsonResponse<RawDetectResponse>(res, 'AI 识图');
    const items: DetectedGoodItem[] = (raw.items || []).map((it) => ({
      label: it.label,
      seriesHint: it.series_hint || raw.series_hint || '',
      itemType: it.item_type,
      jpKeywords: it.jp_keywords,
      box: it.box,
      x: it.x,
      y: it.y,
      weight: it.weight,
      weightSource: it.weight_source,
      marketPrice: mapMarketPrice(it.market_price),
    }));

    return {
      ipName: raw.ip_name,
      providerUsed: raw.provider_used,
      items,
      quota: mapQuota(raw.quota),
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('AI 识图与比价请求超时（>75秒），请检查网络或尝试「网格打点」。');
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function autoPriceGoodsApi(params: {
  inviteCode: string;
  aiConfig: AiProviderConfig;
  ipName: string;
  category: string;
  targetTotal: number;
  items: GoodItem[];
}): Promise<AutoPriceApiResult> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 70000);

  try {
    const res = await fetch('/api/v1/auto-price', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...buildAiHeaders(params.inviteCode, params.aiConfig),
      },
      body: JSON.stringify({
        ip_name: params.ipName,
        category: params.category,
        target_total: params.targetTotal,
        items: params.items.map((it) => ({
          id: it.id,
          label: it.label,
          series_hint: it.seriesHint,
          item_type: it.itemType,
          jp_keywords: it.jpKeywords,
          locked: it.locked,
          price: it.price,
          quantity: it.quantity,
          weight: it.weight,
          tag: it.tag,
        })),
      }),
      signal: controller.signal,
    });

    const raw = await parseJsonResponse<RawAutoPriceResponse>(res, 'AI 自动调价');
    return {
      ipName: raw.ip_name,
      providerUsed: raw.provider_used,
      summary: raw.summary,
      items: (raw.items || []).map((it) => ({
        id: it.id,
        label: it.label,
        weight: it.weight,
        tag: it.tag,
        weightSource: it.weight_source,
        reason: it.reason,
        marketPrice: mapMarketPrice(it.market_price),
      })),
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('AI 自动调价请求超时，请检查接口连通性或稍后重试。');
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function lookupMarketPricesApi(params: {
  inviteCode: string;
  aiConfig: AiProviderConfig;
  ipName: string;
  category: string;
  jpyRate?: number;
  referenceAvgPrice?: number;
  forceRefresh?: boolean;
  items: Array<{
    id: string;
    label: string;
    seriesHint?: string;
    itemType?: string;
    jpKeywords?: string;
    weight?: number;
    forceRefresh?: boolean;
  }>;
}): Promise<PriceLookupApiResult> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 55000);

  try {
    const res = await fetch('/api/v1/price-lookup', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...buildAiHeaders(params.inviteCode, params.aiConfig),
      },
      body: JSON.stringify({
        ip_name: params.ipName,
        category: params.category,
        jpy_rate: params.jpyRate,
        reference_avg_price: params.referenceAvgPrice,
        force_refresh: Boolean(params.forceRefresh),
        items: params.items.map((it) => ({
          id: it.id,
          label: it.label,
          series_hint: it.seriesHint,
          item_type: it.itemType,
          jp_keywords: it.jpKeywords,
          weight: it.weight,
          force_refresh: it.forceRefresh,
        })),
      }),
      signal: controller.signal,
    });

    const raw = await parseJsonResponse<RawPriceLookupResponse>(res, '市场比价');
    return {
      ipName: raw.ip_name,
      jpyRate: raw.jpy_rate,
      items: (raw.items || []).map((it) => ({
        id: it.id,
        label: it.label,
        seriesHint: it.series_hint,
        itemType: it.item_type,
        jpKeywords: it.jp_keywords,
        weight: it.weight,
        weightSource: it.weight_source,
        marketPrice: mapMarketPrice(it.market_price) ?? {
          marketPriceMedian: null,
          marketPriceRange: null,
          sampleCount: 0,
          sources: [],
          pricingTier: 'vlm_fallback',
          freshness: 'recent',
        },
      })),
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('市场比价请求超时，已保留当前本地权重。');
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function contributeMarketApi(params: {
  inviteCode: string;
  projectId: string;
  ipName: string;
  category: string;
  avgPrice: number;
  items: Array<{ label: string; finalPrice: number }>;
}): Promise<ContributeResponse> {
  const res = await fetch('/api/v1/market/contribute', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Access-Token': params.inviteCode.trim(),
    },
    body: JSON.stringify({
      project_id: params.projectId,
      ip_name: params.ipName,
      category: params.category,
      avg_price: params.avgPrice,
      items: params.items.map((it) => ({
        label: it.label,
        final_price: it.finalPrice,
      })),
    }),
  });

  return parseJsonResponse<ContributeResponse>(res, '行情贡献');
}

export async function fetchMarketStatsApi(params: {
  inviteCode: string;
  ipName?: string;
  category?: string;
}): Promise<{ stats: MarketStatItem[]; quota: QuotaInfo | null; inviteValid: boolean }> {
  const qs = new URLSearchParams();
  if (params.ipName?.trim()) qs.set('ip_name', params.ipName.trim());
  if (params.category?.trim() && params.category !== '全部') qs.set('category', params.category.trim());

  const url = `/api/v1/market/stats${qs.toString() ? `?${qs.toString()}` : ''}`;
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(params.inviteCode.trim()
        ? {
            'X-Access-Token': params.inviteCode.trim(),
          }
        : {}),
    },
  });

  const raw = await parseJsonResponse<RawMarketStatsResponse>(res, '行情库查询');
  return {
    stats: (raw.stats || []).map((s) => ({
      id: s.id,
      ipName: s.ip_name,
      characterName: s.character_name,
      category: s.category,
      avgWeightRatio: s.avg_weight_ratio,
      sampleCount: s.sample_count,
      updatedAt: s.updated_at,
    })),
    quota: mapQuota(raw.quota ?? undefined) ?? null,
    inviteValid: raw.invite_valid ?? Boolean(raw.quota),
  };
}

// --- Phase 3: Multi-User Live Group-Buy Client APIs ---
export async function createGroupOrderApi(params: {
  title: string;
  ipName: string;
  annotatedImageDataUrl: string;
  items: GoodItem[];
}): Promise<{
  shareCode: string;
  shareUrl: string;
  ownerToken: string;
  order: GroupOrderDetail;
}> {
  const res = await fetch('/api/v1/groups', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      title: params.title,
      ip_name: params.ipName,
      annotated_image_data_url: params.annotatedImageDataUrl,
      items: params.items.map((it) => ({
        source_item_id: it.id,
        label: it.label,
        price: it.price,
        prepaid_price: it.prepaidPrice ?? it.price,
        total_qty: it.quantity,
        tag: it.tag,
        box: it.box,
      })),
    }),
  });

  const raw = await parseJsonResponse<{
    share_code: string;
    share_url: string;
    owner_token: string;
    order: RawGroupOrder;
  }>(res, '发布在线拼团');

  return {
    shareCode: raw.share_code,
    shareUrl: raw.share_url,
    ownerToken: raw.owner_token,
    order: mapGroupOrderDetail(raw.order),
  };
}

export async function fetchGroupOrderApi(params: {
  shareCode: string;
  ownerToken?: string;
}): Promise<{ isOwner: boolean; order: GroupOrderDetail }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (params.ownerToken) {
    headers.Authorization = `Bearer ${params.ownerToken}`;
  }
  const res = await fetch(`/api/v1/groups/${encodeURIComponent(params.shareCode)}`, {
    credentials: 'same-origin',
    headers,
  });
  const raw = await parseJsonResponse<{ is_owner: boolean; order: RawGroupOrder }>(res, '查询在线拼团');
  return {
    isOwner: Boolean(raw.is_owner),
    order: mapGroupOrderDetail(raw.order),
  };
}

export async function cancelGroupClaimApi(params: {
  shareCode: string;
  claimId: string;
  ownerToken: string;
}): Promise<GroupOrderDetail> {
  const res = await fetch(
    `/api/v1/groups/${encodeURIComponent(params.shareCode)}/claims/${encodeURIComponent(params.claimId)}`,
    {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${params.ownerToken}`,
      },
    }
  );
  const raw = await parseJsonResponse<{ order: RawGroupOrder }>(res, '撤销排谷记录');
  return mapGroupOrderDetail(raw.order);
}

export async function syncGroupOrderApi(params: {
  shareCode: string;
  ownerToken: string;
  status?: GroupOrderStatus;
  annotatedImageDataUrl?: string;
  items?: GoodItem[];
}): Promise<GroupOrderDetail> {
  const res = await fetch(`/api/v1/groups/${encodeURIComponent(params.shareCode)}/sync`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${params.ownerToken}`,
    },
    body: JSON.stringify({
      status: params.status,
      annotated_image_data_url: params.annotatedImageDataUrl,
      items: params.items?.map((it) => ({
        source_item_id: it.id,
        label: it.label,
        price: it.price,
        prepaid_price: it.prepaidPrice ?? it.price,
        total_qty: it.quantity,
        tag: it.tag,
      })),
    }),
  });
  const raw = await parseJsonResponse<{ order: RawGroupOrder }>(res, '同步在线拼团');
  return mapGroupOrderDetail(raw.order);
}
