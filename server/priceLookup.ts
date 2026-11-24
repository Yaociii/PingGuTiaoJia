import { GoogleGenAI } from '@google/genai';
import type { GachaDatabase } from './db';
import { normalizeKey } from './marketMatcher';
import type {
  MarketPriceCacheRecord,
  MarketPriceSourceRecord,
  PriceFreshness,
  PricingTier,
} from './types';
import { cleanDirtyJson } from './vlmParser';
import { validateSafeExternalBaseUrl, type CustomAiConfig } from './vlmProvider';

export interface PriceLookupQuery {
  id: string;
  ipName: string;
  label: string;
  seriesHint?: string;
  itemType?: string;
  jpKeywords?: string;
  vlmWeight?: number;
  forceRefresh?: boolean;
}

export interface RawMarketSample {
  platform: string;
  title: string;
  rawPrice: number;
  currency: 'CNY' | 'JPY';
  listedAt?: string;
  url?: string;
  sold?: boolean;
  matchesSeries?: boolean;
}

export interface PriceSourceContext {
  now: Date;
  jpyRate: number;
  intlShippingFactor: number;
  timeoutMs: number;
  customAiConfig?: CustomAiConfig;
  fetchImpl: typeof fetch;
}

export interface BasePriceSource {
  readonly name: string;
  isEnabled(): boolean;
  lookup(query: PriceLookupQuery, ctx: PriceSourceContext): Promise<RawMarketSample[]>;
}

export interface ItemLookupResult {
  id: string;
  label: string;
  series_hint: string;
  item_type: string;
  jp_keywords: string;
  market_price_median: number | null;
  market_price_range: [number, number] | null;
  sample_count: number;
  sources: MarketPriceSourceRecord[];
  pricing_tier: PricingTier;
  freshness: PriceFreshness;
  from_cache: boolean;
  cached_at?: string;
  query_used: string;
  weight: number;
  weight_source: 'market_lookup' | 'market_db' | 'vlm_guess';
}

const BUNDLE_TITLE_REGEX =
  /(打包|抱盒|全套|一整盒|整盒|整组|捆出|捆绑|合售|一套出|全员|大合集|拼团总价|まとめ売り|セット売り|コンプリート|BOX売り|全\d+種)/i;

const MIN_VALID_CNY = 3;
const MAX_VALID_CNY = 3000;
const FRESH_DAYS = 30;
const RECENT_DAYS = 90;

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function sanitizeExternalUrl(raw?: string): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    // invalid url
  }
  return undefined;
}

/**
 * 识别打包/抱盒/整组/捆出等非单出报价标题
 */
export function isBundleOrLotListing(title: string): boolean {
  if (!title) return false;
  return BUNDLE_TITLE_REGEX.test(title);
}

/**
 * 将原始币种单价折算为人民币参考价：
 * - CNY 原样返回
 * - JPY 按 rawPrice * jpyRate * (1 + intlShippingFactor) 折算
 */
export function convertToCny(
  rawPrice: number,
  currency: 'CNY' | 'JPY',
  jpyRate = 0.048,
  intlShippingFactor = 0.12
): number {
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) return 0;
  if (currency === 'JPY') {
    return round2(rawPrice * Math.max(0.01, jpyRate) * (1 + Math.max(0, intlShippingFactor)));
  }
  return round2(rawPrice);
}

/**
 * 过滤明显引流异常价（如 1元、9999元 等）
 */
export function isValidSingleMerchCnyPrice(cnyPrice: number): boolean {
  return Number.isFinite(cnyPrice) && cnyPrice >= MIN_VALID_CNY && cnyPrice <= MAX_VALID_CNY;
}

/**
 * 判定单条市场报价的新鲜度：
 * - <= 30 天：fresh
 * - 31 ~ 90 天：recent
 * - > 90 天：stale（丢弃，不参与计算）
 */
export function classifyFreshness(listedAt: string | undefined, now = new Date()): PriceFreshness {
  if (!listedAt) return 'recent';
  const ts = Date.parse(listedAt);
  if (!Number.isFinite(ts)) return 'recent';
  const ageDays = Math.max(0, (now.getTime() - ts) / (24 * 60 * 60 * 1000));
  if (ageDays <= FRESH_DAYS) return 'fresh';
  if (ageDays <= RECENT_DAYS) return 'recent';
  return 'stale';
}

function medianOfSorted(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 统计清洗与 IQR 四分位去噪 + 时效窗口治理：
 * 1. 过滤打包总价标题、引流异常价（<¥3 或 >¥3000）以及 >90天过期样本
 * 2. 优先取 30 天内 (fresh) 样本；若不足 2 条则放宽至 90 天内 (fresh + recent)
 * 3. 对样本执行 IQR（Q1 - 1.5*IQR ~ Q3 + 1.5*IQR）去噪，计算中位价与合理区间
 */
export function cleanAndAggregateMarketSamples(
  rawSamples: RawMarketSample[],
  options: {
    now?: Date;
    jpyRate?: number;
    intlShippingFactor?: number;
    hasSeriesHint?: boolean;
  } = {}
): {
  median: number | null;
  range: [number, number] | null;
  sampleCount: number;
  sources: MarketPriceSourceRecord[];
  freshness: PriceFreshness;
  pricingTier: 'exact_market' | 'char_market' | null;
} {
  const now = options.now ?? new Date();
  const jpyRate = options.jpyRate ?? 0.048;
  const shippingFactor = options.intlShippingFactor ?? 0.12;

  const validMapped: Array<MarketPriceSourceRecord & { matchesSeries: boolean }> = [];

  for (const s of rawSamples) {
    if (!s || typeof s.rawPrice !== 'number' || !Number.isFinite(s.rawPrice)) continue;
    const title = (s.title || '').trim();
    if (isBundleOrLotListing(title)) continue;

    const currency: 'CNY' | 'JPY' = s.currency === 'JPY' ? 'JPY' : 'CNY';
    const cnyPrice = convertToCny(s.rawPrice, currency, jpyRate, shippingFactor);
    if (!isValidSingleMerchCnyPrice(cnyPrice)) continue;

    const freshness = classifyFreshness(s.listedAt, now);
    if (freshness === 'stale') continue; // > 90 天强制丢弃

    validMapped.push({
      platform: (s.platform || '二手市场').trim().slice(0, 24),
      title: title.slice(0, 80) || '二手单出参考',
      raw_price: round2(s.rawPrice),
      currency,
      cny_price: cnyPrice,
      listed_at: s.listedAt && Number.isFinite(Date.parse(s.listedAt))
        ? s.listedAt.slice(0, 10)
        : now.toISOString().slice(0, 10),
      url: sanitizeExternalUrl(s.url),
      freshness,
      sold: Boolean(s.sold),
      matchesSeries: Boolean(s.matchesSeries),
    });
  }

  if (validMapped.length === 0) {
    return {
      median: null,
      range: null,
      sampleCount: 0,
      sources: [],
      freshness: 'stale',
      pricingTier: null,
    };
  }

  // 优先限定 30 天内样本；若不足 2 条则自动放宽至 90 天内
  const freshOnly = validMapped.filter((s) => s.freshness === 'fresh');
  const activePool = freshOnly.length >= 2 ? freshOnly : validMapped;
  const overallFreshness: PriceFreshness =
    activePool.every((s) => s.freshness === 'fresh') ? 'fresh' : 'recent';

  // IQR 四分位去噪（>= 4 条样本时启用；3 条时若极端值偏离中位数 > 2.5x 也做截尾）
  const sortedPrices = activePool.map((s) => s.cny_price).sort((a, b) => a - b);
  let denoisedPool = activePool;

  if (sortedPrices.length >= 4) {
    const q1 = percentileSorted(sortedPrices, 0.25);
    const q3 = percentileSorted(sortedPrices, 0.75);
    const iqr = q3 - q1;
    const lowFence = q1 - 1.5 * iqr;
    const highFence = q3 + 1.5 * iqr;
    const filtered = activePool.filter((s) => s.cny_price >= lowFence && s.cny_price <= highFence);
    if (filtered.length > 0) {
      denoisedPool = filtered;
    }
  } else if (sortedPrices.length === 3) {
    const med = sortedPrices[1];
    const filtered = activePool.filter((s) => s.cny_price >= med * 0.35 && s.cny_price <= med * 2.5);
    if (filtered.length >= 2) {
      denoisedPool = filtered;
    }
  }

  // 已售出/近期样本优先排前
  const ordered = [...denoisedPool].sort((a, b) => {
    if (Boolean(b.sold) !== Boolean(a.sold)) return Number(Boolean(b.sold)) - Number(Boolean(a.sold));
    if (a.freshness !== b.freshness) return a.freshness === 'fresh' ? -1 : 1;
    return b.listed_at.localeCompare(a.listed_at);
  });

  const finalPrices = ordered.map((s) => s.cny_price).sort((a, b) => a - b);
  const median = round2(medianOfSorted(finalPrices));
  const range: [number, number] = [round2(finalPrices[0]), round2(finalPrices[finalPrices.length - 1])];

  const hasExactSeriesMatch =
    Boolean(options.hasSeriesHint) && ordered.some((s) => s.matchesSeries);
  const pricingTier: 'exact_market' | 'char_market' = hasExactSeriesMatch
    ? 'exact_market'
    : 'char_market';

  const cleanSources: MarketPriceSourceRecord[] = ordered.slice(0, 8).map(
    ({ matchesSeries: _ignore, ...rec }) => rec
  );

  return {
    median,
    range,
    sampleCount: ordered.length,
    sources: cleanSources,
    freshness: overallFreshness,
    pricingTier,
  };
}

/**
 * 构建中/日双语定向检索 Query
 */
export function buildBilingualSearchQueries(query: PriceLookupQuery): {
  cnQuery: string;
  jpQuery: string;
  displayQuery: string;
} {
  const partsCn = [query.ipName, query.label, query.seriesHint, query.itemType]
    .map((s) => (s || '').trim())
    .filter((s) => s && s !== '通用');
  const cnBase = partsCn.join(' ');
  const cnQuery = `${cnBase} 闲鱼 出 OR 价 site:goofish.com`;

  const jpCore =
    query.jpKeywords?.trim() ||
    [query.ipName, query.label, query.itemType].filter(Boolean).join(' ');
  const jpQuery = `site:jp.mercari.com "${jpCore}"`;

  return {
    cnQuery,
    jpQuery,
    displayQuery: `${cnBase}${query.jpKeywords ? ` | ${query.jpKeywords}` : ''}`,
  };
}

function buildSearchExtractionPrompt(query: PriceLookupQuery, todayIso: string, searchSnippets?: string): string {
  const { cnQuery, jpQuery } = buildBilingualSearchQueries(query);
  const snippetBlock = searchSnippets
    ? `\n以下是搜索引擎返回的最新结果摘要，请仅基于这些真实搜索结果提取单品报价：\n${searchSnippets}\n`
    : `\n请使用联网搜索分别检索国内闲鱼/二手单出价（${cnQuery}）与日本煤炉 Mercari 单出价（${jpQuery}）。\n`;

  return `你是二次元谷子二手市场行情核价员。今天日期是 ${todayIso}。
目标商品：
- 作品 IP：${query.ipName || '未知'}
- 角色名：${query.label}
- 系列/柄图特征：${query.seriesHint || '未指定'}
- 品类：${query.itemType || '通用'}
- 日文检索词：${query.jpKeywords || '无'}
${snippetBlock}
严格筛选规则：
1. 仅提取最近 30 天（最多不超过 90 天）的**单品单出**报价，优先选择“已售出 / SOLD”或近期活跃挂单。
2. 明确排除打包出、抱盒整套、全员合售、捆出总价，以及 1元/9999元 等引流占位价。
3. 如实记录币种（国内闲鱼为 "CNY"，日本煤炉 Mercari 为 "JPY"）与原始标价。
4. 仅返回严格 JSON，不要包含 Markdown 围栏或多余解释：
{
  "samples": [
    {
      "platform": "闲鱼 或 煤炉 Mercari",
      "title": "简短商品标题",
      "rawPrice": 65,
      "currency": "CNY",
      "listedAt": "${todayIso}",
      "url": "https://...",
      "sold": true,
      "matchesSeries": true
    }
  ]
}`;
}

function parseSamplesFromLlmJson(rawText: string, fallbackUrls: string[] = []): RawMarketSample[] {
  try {
    const cleaned = cleanDirtyJson(rawText);
    const parsed = JSON.parse(cleaned) as { samples?: unknown[] };
    const list = Array.isArray(parsed?.samples) ? parsed.samples : [];
    const results: RawMarketSample[] = [];
    list.forEach((entry, idx) => {
      if (!entry || typeof entry !== 'object') return;
      const obj = entry as Record<string, unknown>;
      const rawPrice = Number(obj.rawPrice ?? obj.raw_price ?? obj.price);
      if (!Number.isFinite(rawPrice) || rawPrice <= 0) return;
      const currencyRaw = String(obj.currency || 'CNY').toUpperCase();
      const currency: 'CNY' | 'JPY' = currencyRaw === 'JPY' ? 'JPY' : 'CNY';
      const urlCandidate =
        typeof obj.url === 'string' && obj.url.trim() ? obj.url.trim() : fallbackUrls[idx];
      results.push({
        platform: typeof obj.platform === 'string' && obj.platform.trim() ? obj.platform.trim() : '二手市场',
        title: typeof obj.title === 'string' ? obj.title.trim() : '',
        rawPrice,
        currency,
        listedAt: typeof obj.listedAt === 'string' ? obj.listedAt.trim() : undefined,
        url: sanitizeExternalUrl(urlCandidate),
        sold: Boolean(obj.sold),
        matchesSeries: Boolean(obj.matchesSeries),
      });
    });
    return results;
  } catch {
    return [];
  }
}

/**
 * 通道 A：联网搜索比价适配器（默认启用，零反爬风险）
 * 策略 1：Gemini 原生 Google Search Grounding (tools: [{ googleSearch: {} }])
 * 策略 2：通用搜索 API（SEARCH_API_PROVIDER=tavily|serper|bocha + SEARCH_API_KEY）+ LLM 价格提取
 */
export class SearchGroundingPriceSource implements BasePriceSource {
  public readonly name = 'search_grounding';

  public isEnabled(): boolean {
    const flag = (process.env.PRICE_LOOKUP_SEARCH_ENABLED ?? 'true').trim().toLowerCase();
    return flag !== 'false' && flag !== '0';
  }

  public async lookup(query: PriceLookupQuery, ctx: PriceSourceContext): Promise<RawMarketSample[]> {
    const provider = (process.env.SEARCH_API_PROVIDER || 'gemini_grounding').trim().toLowerCase();
    const searchApiKey = process.env.SEARCH_API_KEY?.trim();

    if (searchApiKey && (provider === 'tavily' || provider === 'serper' || provider === 'bocha')) {
      return this.lookupViaExternalSearchApi(provider, searchApiKey, query, ctx);
    }

    return this.lookupViaGeminiSearchGrounding(query, ctx);
  }

  private async lookupViaGeminiSearchGrounding(
    query: PriceLookupQuery,
    ctx: PriceSourceContext
  ): Promise<RawMarketSample[]> {
    const geminiKey =
      ctx.customAiConfig?.protocol === 'gemini' && ctx.customAiConfig.apiKey?.trim()
        ? ctx.customAiConfig.apiKey.trim()
        : process.env.GEMINI_API_KEY?.trim();

    if (!geminiKey || geminiKey === 'MY_GEMINI_API_KEY') {
      return [];
    }

    const ai = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const todayIso = ctx.now.toISOString().slice(0, 10);
    const prompt = buildSearchExtractionPrompt(query, todayIso);

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const text = response.text || '';
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const groundingUrls = chunks
      .map((c) => (c as { web?: { uri?: string } })?.web?.uri)
      .filter((u): u is string => typeof u === 'string' && u.startsWith('http'));

    return parseSamplesFromLlmJson(text, groundingUrls);
  }

  private async lookupViaExternalSearchApi(
    provider: 'tavily' | 'serper' | 'bocha',
    apiKey: string,
    query: PriceLookupQuery,
    ctx: PriceSourceContext
  ): Promise<RawMarketSample[]> {
    const { cnQuery, jpQuery } = buildBilingualSearchQueries(query);
    const snippets: Array<{ title: string; snippet: string; url?: string }> = [];

    const runQuery = async (q: string) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
      try {
        if (provider === 'tavily') {
          const res = await ctx.fetchImpl('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: apiKey, query: q, search_depth: 'basic', max_results: 5 }),
            signal: controller.signal,
          });
          if (!res.ok) return;
          const data = (await res.json()) as { results?: Array<{ title?: string; content?: string; url?: string }> };
          for (const r of data.results ?? []) {
            snippets.push({ title: r.title || '', snippet: r.content || '', url: r.url });
          }
        } else if (provider === 'serper') {
          const res = await ctx.fetchImpl('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
            body: JSON.stringify({ q, num: 5, tbs: 'qdr:m' }),
            signal: controller.signal,
          });
          if (!res.ok) return;
          const data = (await res.json()) as { organic?: Array<{ title?: string; snippet?: string; link?: string }> };
          for (const r of data.organic ?? []) {
            snippets.push({ title: r.title || '', snippet: r.snippet || '', url: r.link });
          }
        } else if (provider === 'bocha') {
          const res = await ctx.fetchImpl('https://api.bochaai.com/v1/web-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ query: q, freshness: 'oneMonth', count: 5 }),
            signal: controller.signal,
          });
          if (!res.ok) return;
          const data = (await res.json()) as {
            data?: { webPages?: { value?: Array<{ name?: string; snippet?: string; url?: string }> } };
          };
          for (const r of data.data?.webPages?.value ?? []) {
            snippets.push({ title: r.name || '', snippet: r.snippet || '', url: r.url });
          }
        }
      } finally {
        clearTimeout(timer);
      }
    };

    await Promise.allSettled([runQuery(cnQuery), runQuery(jpQuery)]);
    if (snippets.length === 0) return [];

    // Heuristic price extraction directly from snippets when no LLM key is configured,
    // or structured extraction via Gemini when available.
    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    if (geminiKey && geminiKey !== 'MY_GEMINI_API_KEY') {
      const ai = new GoogleGenAI({
        apiKey: geminiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });
      const snippetText = snippets
        .slice(0, 10)
        .map((s, i) => `${i + 1}. [${s.title}] ${s.snippet} (${s.url || ''})`)
        .join('\n');
      const prompt = buildSearchExtractionPrompt(query, ctx.now.toISOString().slice(0, 10), snippetText);
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      });
      return parseSamplesFromLlmJson(
        response.text || '',
        snippets.map((s) => s.url || '')
      );
    }

    // Fallback regex extraction from snippets
    const fallbackSamples: RawMarketSample[] = [];
    for (const s of snippets) {
      const combined = `${s.title} ${s.snippet}`;
      const isJp = (s.url || '').includes('mercari') || /[¥￥]\s?\d{3,5}\s?(?:円|JPY)/i.test(combined);
      const jpMatch = combined.match(/([0-9,]{3,6})\s*円|¥\s*([0-9,]{3,6})/);
      const cnMatch = combined.match(/[¥￥]\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*(?:元|r|R)/);
      if (isJp && jpMatch) {
        const val = Number((jpMatch[1] || jpMatch[2] || '').replace(/,/g, ''));
        if (Number.isFinite(val) && val > 0) {
          fallbackSamples.push({
            platform: '煤炉 Mercari',
            title: s.title,
            rawPrice: val,
            currency: 'JPY',
            url: s.url,
            listedAt: ctx.now.toISOString().slice(0, 10),
          });
        }
      } else if (cnMatch) {
        const val = Number(cnMatch[1] || cnMatch[2] || '');
        if (Number.isFinite(val) && val > 0) {
          fallbackSamples.push({
            platform: '闲鱼',
            title: s.title,
            rawPrice: val,
            currency: 'CNY',
            url: s.url,
            listedAt: ctx.now.toISOString().slice(0, 10),
          });
        }
      }
    }
    return fallbackSamples;
  }
}

/**
 * 通道 B：Mercari JP / 闲鱼合规代理数据源适配器基类
 */
export class ProxyMarketAdapter implements BasePriceSource {
  public readonly name: string;
  private readonly platformLabel: string;
  private readonly currency: 'CNY' | 'JPY';
  private readonly envUrlKey: string;
  private readonly envTokenKey: string;

  constructor(options: {
    name: string;
    platformLabel: string;
    currency: 'CNY' | 'JPY';
    envUrlKey: string;
    envTokenKey: string;
  }) {
    this.name = options.name;
    this.platformLabel = options.platformLabel;
    this.currency = options.currency;
    this.envUrlKey = options.envUrlKey;
    this.envTokenKey = options.envTokenKey;
  }

  public isEnabled(): boolean {
    return Boolean(process.env[this.envUrlKey]?.trim());
  }

  public async lookup(query: PriceLookupQuery, ctx: PriceSourceContext): Promise<RawMarketSample[]> {
    const rawUrl = process.env[this.envUrlKey]?.trim();
    if (!rawUrl) return [];

    // Strict SSRF check: only allow public HTTPS proxy endpoints
    const safeBase = validateSafeExternalBaseUrl(rawUrl);
    const token = process.env[this.envTokenKey]?.trim();
    const keyword =
      this.currency === 'JPY'
        ? query.jpKeywords?.trim() || `${query.ipName} ${query.label}`
        : `${query.ipName} ${query.label} ${query.seriesHint || ''}`.trim();

    const url = new URL(safeBase);
    url.searchParams.set('q', keyword);
    url.searchParams.set('days', '30');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      const res = await ctx.fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
      const items = Array.isArray(data?.items) ? data.items : [];
      return items
        .map((it): RawMarketSample | null => {
          const price = Number(it.price ?? it.raw_price);
          if (!Number.isFinite(price) || price <= 0) return null;
          return {
            platform: this.platformLabel,
            title: String(it.title || ''),
            rawPrice: price,
            currency: this.currency,
            listedAt: typeof it.listed_at === 'string' ? it.listed_at : undefined,
            url: typeof it.url === 'string' ? it.url : undefined,
            sold: Boolean(it.sold),
            matchesSeries: Boolean(it.matches_series),
          };
        })
        .filter((x): x is RawMarketSample => x !== null);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createMercariAdapter(): BasePriceSource {
  return new ProxyMarketAdapter({
    name: 'mercari_adapter',
    platformLabel: '煤炉 Mercari',
    currency: 'JPY',
    envUrlKey: 'MERCARI_PROXY_URL',
    envTokenKey: 'MERCARI_PROXY_TOKEN',
  });
}

export function createXianyuAdapter(): BasePriceSource {
  return new ProxyMarketAdapter({
    name: 'xianyu_adapter',
    platformLabel: '闲鱼',
    currency: 'CNY',
    envUrlKey: 'XIANYU_PROXY_URL',
    envTokenKey: 'XIANYU_PROXY_TOKEN',
  });
}

export function buildPriceCacheKey(query: {
  ipName: string;
  label: string;
  seriesHint?: string;
  itemType?: string;
}): string {
  return [
    normalizeKey(query.ipName || 'unknown'),
    normalizeKey(query.label || 'unknown'),
    normalizeKey(query.seriesHint || ''),
    normalizeKey(query.itemType || '通用'),
  ].join('::');
}

/**
 * 将一组中位市价归一化为宽幅权重 [0.1, 10.0]，严格保持相对市价比例
 * （例如某烫门市价 85 元、冷门市价 12 元 -> 权重比直接为 85:12）
 */
export function normalizeMarketPricesToWeights(
  items: Array<{ id: string; median: number | null; fallbackWeight: number }>
): Map<string, number> {
  const result = new Map<string, number>();
  const validMedians = items
    .map((it) => it.median)
    .filter((m): m is number => m !== null && Number.isFinite(m) && m > 0);

  if (validMedians.length === 0) {
    for (const it of items) {
      result.set(it.id, clamp(round2(it.fallbackWeight || 1), 0.1, 10.0));
    }
    return result;
  }

  // Use average of observed market medians as 1.0 reference so ratios stay exact (m_i / m_j)
  const avgMarket = validMedians.reduce((sum, v) => sum + v, 0) / validMedians.length;
  for (const it of items) {
    if (it.median !== null && it.median > 0 && avgMarket > 0) {
      const ratio = it.median / avgMarket;
      result.set(it.id, clamp(round2(ratio), 0.1, 10.0));
    } else {
      result.set(it.id, clamp(round2(it.fallbackWeight || 1), 0.1, 10.0));
    }
  }
  return result;
}

export class PriceLookupService {
  private readonly sources: BasePriceSource[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheTtlHours: number;

  constructor(options?: {
    sources?: BasePriceSource[];
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    cacheTtlHours?: number;
  }) {
    this.sources = options?.sources ?? [
      new SearchGroundingPriceSource(),
      createMercariAdapter(),
      createXianyuAdapter(),
    ];
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.timeoutMs = options?.timeoutMs ?? 12000;
    this.cacheTtlHours =
      options?.cacheTtlHours ??
      Math.max(1, Number.parseFloat(process.env.PRICE_CACHE_TTL_HOURS || '48') || 48);
  }

  public getEnabledSourceNames(): string[] {
    return this.sources.filter((s) => s.isEnabled()).map((s) => s.name);
  }

  public async lookupBatch(params: {
    db: GachaDatabase;
    queries: PriceLookupQuery[];
    jpyRate?: number;
    intlShippingFactor?: number;
    customAiConfig?: CustomAiConfig;
    now?: Date;
  }): Promise<{ jpyRate: number; results: ItemLookupResult[] }> {
    const now = params.now ?? new Date();
    const jpyRate =
      params.jpyRate && Number.isFinite(params.jpyRate) && params.jpyRate > 0
        ? params.jpyRate
        : Number.parseFloat(process.env.DEFAULT_JPY_RATE || '0.048') || 0.048;
    const intlShippingFactor =
      params.intlShippingFactor !== undefined && Number.isFinite(params.intlShippingFactor)
        ? Math.max(0, params.intlShippingFactor)
        : Number.parseFloat(process.env.INTL_SHIPPING_FACTOR || '0.12') || 0.12;

    const ctx: PriceSourceContext = {
      now,
      jpyRate,
      intlShippingFactor,
      timeoutMs: this.timeoutMs,
      customAiConfig: params.customAiConfig,
      fetchImpl: this.fetchImpl,
    };

    const enabledSources = this.sources.filter((s) => s.isEnabled());

    // Execute item lookups with bounded concurrency (4 at a time)
    const rawItemResults: Array<{
      query: PriceLookupQuery;
      median: number | null;
      range: [number, number] | null;
      sampleCount: number;
      sources: MarketPriceSourceRecord[];
      pricingTier: PricingTier;
      freshness: PriceFreshness;
      fromCache: boolean;
      cachedAt?: string;
      queryUsed: string;
      localDbWeight?: number;
    }> = [];

    const concurrency = 4;
    for (let i = 0; i < params.queries.length; i += concurrency) {
      const slice = params.queries.slice(i, i + concurrency);
      const batchOut = await Promise.all(
        slice.map((q) => this.lookupSingleItem(params.db, q, enabledSources, ctx))
      );
      rawItemResults.push(...batchOut);
    }

    // Normalize medians across the batch into exact relative weights
    const normalizedWeights = normalizeMarketPricesToWeights(
      rawItemResults.map((r) => ({
        id: r.query.id,
        median: r.median,
        fallbackWeight: r.localDbWeight ?? r.query.vlmWeight ?? 1.0,
      }))
    );

    const results: ItemLookupResult[] = rawItemResults.map((r) => {
      const weight = normalizedWeights.get(r.query.id) ?? r.query.vlmWeight ?? 1.0;
      const weight_source: 'market_lookup' | 'market_db' | 'vlm_guess' =
        r.pricingTier === 'exact_market' || r.pricingTier === 'char_market'
          ? 'market_lookup'
          : r.pricingTier === 'local_db'
            ? 'market_db'
            : 'vlm_guess';

      return {
        id: r.query.id,
        label: r.query.label,
        series_hint: r.query.seriesHint || '',
        item_type: r.query.itemType || '通用',
        jp_keywords: r.query.jpKeywords || '',
        market_price_median: r.median,
        market_price_range: r.range,
        sample_count: r.sampleCount,
        sources: r.sources,
        pricing_tier: r.pricingTier,
        freshness: r.freshness,
        from_cache: r.fromCache,
        cached_at: r.cachedAt,
        query_used: r.queryUsed,
        weight,
        weight_source,
      };
    });

    return { jpyRate, results };
  }

  private async lookupSingleItem(
    db: GachaDatabase,
    query: PriceLookupQuery,
    enabledSources: BasePriceSource[],
    ctx: PriceSourceContext
  ): Promise<{
    query: PriceLookupQuery;
    median: number | null;
    range: [number, number] | null;
    sampleCount: number;
    sources: MarketPriceSourceRecord[];
    pricingTier: PricingTier;
    freshness: PriceFreshness;
    fromCache: boolean;
    cachedAt?: string;
    queryUsed: string;
    localDbWeight?: number;
  }> {
    const cacheKey = buildPriceCacheKey(query);
    const { displayQuery } = buildBilingualSearchQueries(query);

    // 1. Check 48h short-term cache unless forceRefresh=true
    if (!query.forceRefresh) {
      const cached = db.getCachedMarketPrice(cacheKey, ctx.now);
      if (cached) {
        return {
          query,
          median: cached.market_price_median,
          range: cached.market_price_range,
          sampleCount: cached.sample_count,
          sources: cached.sources,
          pricingTier: cached.pricing_tier,
          freshness: cached.freshness,
          fromCache: true,
          cachedAt: cached.cached_at,
          queryUsed: cached.query_used || displayQuery,
        };
      }
    }

    // 2. Concurrent query across all enabled pluggable adapters with timeout circuit-breaker
    const collectedSamples: RawMarketSample[] = [];
    if (enabledSources.length > 0) {
      const settled = await Promise.allSettled(
        enabledSources.map((src) =>
          Promise.race([
            src.lookup(query, ctx),
            new Promise<RawMarketSample[]>((resolve) =>
              setTimeout(() => resolve([]), ctx.timeoutMs + 500)
            ),
          ])
        )
      );
      for (const s of settled) {
        if (s.status === 'fulfilled' && Array.isArray(s.value)) {
          collectedSamples.push(...s.value);
        }
      }
    }

    // 3. Clean, filter stale >90d, IQR denoise
    const aggregated = cleanAndAggregateMarketSamples(collectedSamples, {
      now: ctx.now,
      jpyRate: ctx.jpyRate,
      intlShippingFactor: ctx.intlShippingFactor,
      hasSeriesHint: Boolean(query.seriesHint?.trim()),
    });

    if (aggregated.median !== null && aggregated.pricingTier) {
      const cachedRecord: MarketPriceCacheRecord = {
        cache_key: cacheKey,
        ip_name: query.ipName,
        normalized_char: normalizeKey(query.label),
        series_key: normalizeKey(query.seriesHint || ''),
        item_type: query.itemType || '通用',
        market_price_median: aggregated.median,
        market_price_range: aggregated.range,
        sample_count: aggregated.sampleCount,
        sources: aggregated.sources,
        pricing_tier: aggregated.pricingTier,
        freshness: aggregated.freshness,
        query_used: displayQuery,
        cached_at: ctx.now.toISOString(),
        expires_at: new Date(ctx.now.getTime() + this.cacheTtlHours * 3600 * 1000).toISOString(),
      };
      db.setCachedMarketPrice(cachedRecord);

      return {
        query,
        median: aggregated.median,
        range: aggregated.range,
        sampleCount: aggregated.sampleCount,
        sources: aggregated.sources,
        pricingTier: aggregated.pricingTier,
        freshness: aggregated.freshness,
        fromCache: false,
        cachedAt: cachedRecord.cached_at,
        queryUsed: displayQuery,
      };
    }

    // 4. Fallback tier 3: local_db (only if fresh/recent within 90 days)
    const localHit = db.matchCharacterWeight(
      query.ipName,
      query.label,
      query.itemType || '通用',
      { now: ctx.now, allowStale: false }
    );
    if (localHit) {
      const freshness = classifyFreshness(localHit.updated_at, ctx.now);
      return {
        query,
        median: null,
        range: null,
        sampleCount: localHit.sample_count,
        sources: [
          {
            platform: '历史行情库',
            title: `${localHit.ip_name} · ${localHit.character_name}（${localHit.sample_count} 团历史权重 ×${localHit.avg_weight_ratio.toFixed(2)}）`,
            raw_price: localHit.avg_weight_ratio,
            currency: 'CNY',
            cny_price: localHit.avg_weight_ratio,
            listed_at: localHit.updated_at.slice(0, 10),
            freshness,
          },
        ],
        pricingTier: 'local_db',
        freshness,
        fromCache: false,
        queryUsed: displayQuery,
        localDbWeight: localHit.avg_weight_ratio,
      };
    }

    // 5. Fallback tier 4: vlm_fallback
    return {
      query,
      median: null,
      range: null,
      sampleCount: 0,
      sources: [],
      pricingTier: 'vlm_fallback',
      freshness: 'recent',
      fromCache: false,
      queryUsed: displayQuery,
    };
  }
}
