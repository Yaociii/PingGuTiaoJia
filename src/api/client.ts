import type {
  AiProviderConfig,
  AiTestConnectionResult,
  AutoPriceApiResult,
  DetectApiResult,
  DetectedGoodItem,
  GoodItem,
  MarketStatItem,
  PinTag,
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
}

interface RawQuota {
  code: string;
  daily_limit: number;
  used_today: number;
  remaining_today: number;
}

interface RawDetectItem {
  label: string;
  box: [number, number, number, number];
  x: number;
  y: number;
  weight: number;
  weight_source: WeightSource;
}

interface RawDetectResponse {
  ip_name: string;
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
}

interface RawAutoPriceResponse {
  ip_name: string;
  provider_used: string;
  summary?: string;
  items: RawAutoPriceItem[];
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

export interface ContributeResponse {
  accepted: boolean;
  updated_count?: number;
  reason?: string;
}

function buildAiHeaders(inviteCode: string, aiConfig?: AiProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {};
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

async function parseErrorDetail(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { detail?: string };
    if (typeof data?.detail === 'string' && data.detail.trim()) {
      return data.detail;
    }
  } catch {
    // ignore non-json error body
  }
  if (res.status === 401) return '邀请码无效或已停用，请在设置中检查访问邀请码。';
  if (res.status === 413) return '图片体积超过 15MB 上限。';
  if (res.status === 429) return '今日识图次数已用完，请明日再试或填写自有 API Key。';
  if (res.status === 502) return '上游视觉模型响应异常，请检查 API Key、Base URL 与模型名称。';
  return `请求失败（HTTP ${res.status}）`;
}

export async function fetchServerHealth(): Promise<ServerHealthInfo> {
  const res = await fetch('/api/v1/health');
  if (!res.ok) {
    throw new Error(await parseErrorDetail(res));
  }
  const raw = (await res.json()) as RawHealthResponse;
  return {
    status: raw.status,
    provider: raw.provider,
    model: raw.model,
    version: raw.version,
    geminiConfigured: Boolean(raw.gemini_configured),
  };
}

export async function testAiConnectionApi(params: {
  inviteCode: string;
  aiConfig: AiProviderConfig;
}): Promise<AiTestConnectionResult> {
  const res = await fetch('/api/v1/ai/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildAiHeaders(params.inviteCode, params.aiConfig),
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    throw new Error(await parseErrorDetail(res));
  }

  const raw = (await res.json()) as RawTestResponse;
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
  const timeoutId = window.setTimeout(() => controller.abort(), 65000);

  try {
    const res = await fetch('/api/v1/detect', {
      method: 'POST',
      headers: buildAiHeaders(params.inviteCode, params.aiConfig),
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(await parseErrorDetail(res));
    }

    const raw = (await res.json()) as RawDetectResponse;
    const items: DetectedGoodItem[] = (raw.items || []).map((it) => ({
      label: it.label,
      box: it.box,
      x: it.x,
      y: it.y,
      weight: it.weight,
      weightSource: it.weight_source,
    }));

    return {
      ipName: raw.ip_name,
      providerUsed: raw.provider_used,
      items,
      quota: mapQuota(raw.quota),
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('AI 识图请求超时（>65秒），请检查网络或尝试「网格打点」。');
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
  const timeoutId = window.setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch('/api/v1/auto-price', {
      method: 'POST',
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
          locked: it.locked,
          price: it.price,
          quantity: it.quantity,
          weight: it.weight,
          tag: it.tag,
        })),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(await parseErrorDetail(res));
    }

    const raw = (await res.json()) as RawAutoPriceResponse;
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
    headers: {
      'Content-Type': 'application/json',
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

  if (!res.ok) {
    throw new Error(await parseErrorDetail(res));
  }
  return (await res.json()) as ContributeResponse;
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
    headers: params.inviteCode.trim()
      ? {
          'X-Access-Token': params.inviteCode.trim(),
        }
      : {},
  });

  if (!res.ok) {
    throw new Error(await parseErrorDetail(res));
  }

  const raw = (await res.json()) as RawMarketStatsResponse;
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
