import express from 'express';
import multer from 'multer';
import type { GachaDatabase } from './db';
import {
  PriceLookupService,
  type ItemLookupResult,
  type PriceLookupQuery,
} from './priceLookup';
import type {
  GroupClaimRecord,
  GroupOrderItemRecord,
  GroupOrderRecord,
  GroupOrderStatus,
} from './types';
import {
  parseAutoPriceResponseText,
  parseVlmResponseText,
  type AutoPriceInputItem,
} from './vlmParser';
import {
  detectImageMimeType,
  validateSafeExternalBaseUrl,
  type CustomAiConfig,
  type ServerAiProtocol,
  type VlmProvider,
} from './vlmProvider';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB
const ALLOWED_PROTOCOLS = new Set<ServerAiProtocol>([
  'server_default',
  'openai_compatible',
  'gemini',
  'anthropic',
]);

function extractCustomAiConfig(req: express.Request): {
  config: CustomAiConfig;
  error?: string;
} {
  const rawProtocol = (req.header('X-AI-Protocol')?.trim() || 'server_default') as ServerAiProtocol;
  if (!ALLOWED_PROTOCOLS.has(rawProtocol)) {
    return {
      config: { protocol: 'server_default' },
      error: `不支持的 AI 接口协议：${rawProtocol}`,
    };
  }

  if (rawProtocol === 'server_default') {
    return { config: { protocol: 'server_default' } };
  }

  const apiKey = req.header('X-AI-Api-Key')?.trim() || '';
  const baseUrl = req.header('X-AI-Base-Url')?.trim() || '';
  const model = req.header('X-AI-Model')?.trim() || '';

  if (!apiKey) {
    return {
      config: { protocol: rawProtocol },
      error: '使用自定义 AI 协议时必须填写 API Key。',
    };
  }

  if (baseUrl) {
    try {
      validateSafeExternalBaseUrl(baseUrl);
    } catch (err) {
      return {
        config: { protocol: rawProtocol },
        error: err instanceof Error ? err.message : '自定义接口地址不合法。',
      };
    }
  }

  return {
    config: {
      protocol: rawProtocol,
      apiKey,
      baseUrl: baseUrl || undefined,
      model: model || undefined,
    },
  };
}

function extractOwnerToken(req: express.Request): string | undefined {
  const auth = req.header('Authorization')?.trim();
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const custom = req.header('X-Owner-Token')?.trim();
  return custom || undefined;
}

function maskBuyerContact(contact: string, isOwner: boolean): string {
  const trimmed = (contact || '').trim();
  if (!trimmed || isOwner) return trimmed;
  if (trimmed.length <= 3) return `${trimmed[0]}**`;
  if (trimmed.length <= 6) return `${trimmed.slice(0, 2)}***${trimmed.slice(-1)}`;
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-2)}`;
}

function serializeMarketPrice(r: ItemLookupResult) {
  return {
    market_price_median: r.market_price_median,
    market_price_range: r.market_price_range,
    sample_count: r.sample_count,
    sources: r.sources,
    pricing_tier: r.pricing_tier,
    freshness: r.freshness,
    from_cache: r.from_cache,
    cached_at: r.cached_at,
    query_used: r.query_used,
  };
}

function formatGroupOrderResponse(
  bundle: {
    order: GroupOrderRecord;
    items: GroupOrderItemRecord[];
    claims: GroupClaimRecord[];
  },
  isOwner: boolean
) {
  const itemMap = new Map(bundle.items.map((it) => [it.id, it]));

  const itemsOut = bundle.items.map((it) => {
    let parsedBox: [number, number, number, number] | undefined;
    if (it.box_json) {
      try {
        const b = JSON.parse(it.box_json);
        if (Array.isArray(b) && b.length === 4) {
          parsedBox = [Number(b[0]), Number(b[1]), Number(b[2]), Number(b[3])];
        }
      } catch {
        // ignore invalid box json
      }
    }
    return {
      id: it.id,
      order_id: it.order_id,
      source_item_id: it.source_item_id,
      label: it.label,
      price: it.price,
      prepaid_price: it.prepaid_price ?? it.price,
      total_qty: it.total_qty,
      claimed_qty: it.claimed_qty,
      remaining_qty: Math.max(0, it.total_qty - it.claimed_qty),
      tag: it.tag,
      box: parsedBox,
    };
  });

  const claimsOut = bundle.claims.map((c) => {
    const it = itemMap.get(c.item_id);
    return {
      id: c.id,
      order_id: c.order_id,
      item_id: c.item_id,
      item_label: it?.label || '未知款式',
      buyer_name: c.buyer_name,
      buyer_contact: maskBuyerContact(c.buyer_contact, isOwner),
      qty: c.qty,
      unit_price: it?.price ?? 0,
      prepaid_price: it?.prepaid_price ?? it?.price ?? 0,
      status: c.status,
      created_at: c.created_at,
    };
  });

  // Aggregate per-buyer bill ("分人肾表")
  const billMap = new Map<
    string,
    {
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
    }
  >();

  for (const c of bundle.claims) {
    const it = itemMap.get(c.item_id);
    if (!it) continue;
    const unitPrice = it.price;
    const prepaid = it.prepaid_price ?? unitPrice;
    const key = `${c.buyer_name.toLowerCase()}::${c.buyer_contact.toLowerCase()}`;
    let entry = billMap.get(key);
    if (!entry) {
      entry = {
        buyer_name: c.buyer_name,
        buyer_contact: maskBuyerContact(c.buyer_contact, isOwner),
        total_qty: 0,
        total_amount: 0,
        prepaid_total: 0,
        delta_total: 0,
        items: [],
      };
      billMap.set(key, entry);
    }

    const lineAmount = Math.round(unitPrice * c.qty * 100) / 100;
    const linePrepaid = Math.round(prepaid * c.qty * 100) / 100;
    const lineDelta = Math.round((lineAmount - linePrepaid) * 100) / 100;

    entry.total_qty += c.qty;
    entry.total_amount = Math.round((entry.total_amount + lineAmount) * 100) / 100;
    entry.prepaid_total = Math.round((entry.prepaid_total + linePrepaid) * 100) / 100;
    entry.delta_total = Math.round((entry.total_amount - entry.prepaid_total) * 100) / 100;

    const existingLine = entry.items.find((x) => x.item_id === it.id);
    if (existingLine) {
      existingLine.qty += c.qty;
      existingLine.delta = Math.round((existingLine.delta + lineDelta) * 100) / 100;
    } else {
      entry.items.push({
        item_id: it.id,
        label: it.label,
        qty: c.qty,
        unit_price: unitPrice,
        prepaid_price: prepaid,
        delta: lineDelta,
      });
    }
  }

  return {
    id: bundle.order.id,
    share_code: bundle.order.share_code,
    share_url: `/g/${bundle.order.share_code}`,
    title: bundle.order.title,
    ip_name: bundle.order.ip_name,
    status: bundle.order.status,
    annotated_image_data_url: bundle.order.annotated_image_data_url,
    created_at: bundle.order.created_at,
    updated_at: bundle.order.updated_at,
    items: itemsOut,
    claims: claimsOut,
    buyer_bills: Array.from(billMap.values()),
  };
}

export function createApiRouter(options: {
  db: GachaDatabase;
  vlmProvider: VlmProvider;
  priceLookupService?: PriceLookupService;
  getNow?: () => Date;
}): express.Router {
  const { db, vlmProvider } = options;
  const priceLookupService = options.priceLookupService ?? new PriceLookupService();
  const getNow = options.getNow ?? (() => new Date());

  const router = express.Router();
  router.use(express.json({ limit: '10mb' }));

  // SSE room subscribers keyed by uppercase shareCode
  const sseSubscribers = new Map<string, Set<express.Response>>();

  function broadcastGroupUpdate(shareCode: string): void {
    const code = shareCode.trim().toUpperCase();
    const subs = sseSubscribers.get(code);
    if (!subs || subs.size === 0) return;
    const bundle = db.getGroupOrderByShareCode(code);
    if (!bundle) return;
    const publicPayload = JSON.stringify(formatGroupOrderResponse(bundle, false));
    for (const client of subs) {
      try {
        client.write(`event: update\ndata: ${publicPayload}\n\n`);
      } catch {
        subs.delete(client);
      }
    }
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_IMAGE_BYTES,
      files: 1,
    },
  });

  // 4.1 健康检查（无需鉴权）
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      provider: vlmProvider.providerName,
      model: vlmProvider.modelName,
      version: '2.0.0',
      gemini_configured: vlmProvider.isConfigured(),
      supported_protocols: ['server_default', 'openai_compatible', 'gemini', 'anthropic'],
      price_lookup_sources: priceLookupService.getEnabledSourceNames(),
    });
  });

  // 4.1b AI 协议与密钥连通性测试（绝不落盘存储用户 Key）
  router.post('/ai/test', async (req, res) => {
    const extracted = extractCustomAiConfig(req);
    if (extracted.error) {
      res.status(400).json({ detail: extracted.error });
      return;
    }

    const isByok = extracted.config.protocol !== 'server_default';
    if (!isByok) {
      const tokenRecord = db.verifyInviteCode(req.header('X-Access-Token')?.trim(), getNow());
      if (!tokenRecord) {
        res.status(401).json({ detail: '使用默认服务需要有效的邀请码。' });
        return;
      }
    }

    try {
      const result = await vlmProvider.testConnection({ customConfig: extracted.config });
      res.json({
        ok: true,
        provider_used: result.providerUsed,
        latency_ms: result.latencyMs,
        reply_preview: result.replyPreview,
      });
    } catch (err) {
      res.status(500).json({
        detail: err instanceof Error ? err.message : '连接测试失败',
      });
    }
  });

  // 4.2 图像识别 + 自动二手市场比价与历史行情融合
  router.post(
    '/detect',
    (req, res, next) => {
      upload.single('image')(req, res, (err: unknown) => {
        if (err) {
          const multerErr = err as { code?: string };
          if (multerErr.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ detail: '图片大小超过 15MB 上限，请压缩后再试。' });
            return;
          }
          res.status(400).json({ detail: '图片上传格式无效，请上传 PNG / JPG / WEBP 图片。' });
          return;
        }
        next();
      });
    },
    async (req, res) => {
      const startMs = Date.now();
      const now = getNow();
      const extracted = extractCustomAiConfig(req);
      if (extracted.error) {
        res.status(400).json({ detail: extracted.error });
        return;
      }

      const isByok = extracted.config.protocol !== 'server_default';
      const tokenHeader = req.header('X-Access-Token')?.trim();
      const tokenRecord = db.verifyInviteCode(tokenHeader, now);

      if (!isByok && !tokenRecord) {
        res.status(401).json({ detail: '邀请码无效或已停用，请在设置中检查邀请码，或改用您自己的 API Key。' });
        return;
      }

      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        res.status(400).json({ detail: '请上传需要识别的谷子图片（支持 PNG / JPG / WEBP）。' });
        return;
      }
      if (file.buffer.length > MAX_IMAGE_BYTES) {
        res.status(413).json({ detail: '图片大小超过 15MB 上限，请压缩后再试。' });
        return;
      }

      const detectedMime = detectImageMimeType(file.buffer);
      if (!detectedMime) {
        res.status(400).json({ detail: '图片损坏或格式不支持，仅支持 PNG / JPG / WEBP 格式。' });
        return;
      }

      let updatedToken = tokenRecord;
      if (!isByok && tokenRecord) {
        const quotaCheck = db.checkQuotaAvailable(tokenRecord.code, now);
        if (!quotaCheck.allowed) {
          res.status(429).json({
            detail: `今日识图次数已用完（${tokenRecord.used_today}/${tokenRecord.daily_limit}），UTC 次日零点重置，您也可以在设置中填写自有 API Key 继续使用。`,
          });
          return;
        }
      }

      const ipHint = typeof req.body?.ip_hint === 'string' ? req.body.ip_hint.trim().slice(0, 60) : '';
      const category =
        typeof req.body?.category === 'string' && req.body.category.trim()
          ? req.body.category.trim().slice(0, 24)
          : '通用';
      const skipLookup = req.body?.auto_lookup === 'false';

      try {
        const { rawText, providerUsed } = await vlmProvider.detectGoods({
          imageBuffer: file.buffer,
          mimeType: detectedMime,
          ipHint,
          customConfig: extracted.config,
        });

        const parsed = parseVlmResponseText(rawText, ipHint);
        if (parsed.items.length === 0) {
          db.addDetectLog({
            token_code: isByok ? 'byok' : tokenRecord?.code || 'unknown',
            provider: extracted.config.protocol,
            model: extracted.config.model || vlmProvider.modelName,
            detected_count: 0,
            latency_ms: Date.now() - startMs,
            status: 'error',
            error_msg: '未检测到有效谷子单品',
          });
          res
            .status(422)
            .json({ detail: '未能从图片中识别出独立的谷子单品，请尝试使用「网格打点」或手动加点。' });
          return;
        }

        if (!isByok && tokenRecord) {
          updatedToken = db.consumeQuota(tokenRecord.code, now);
        }

        // V2.0 闭环：识图 -> 多源市场比价 -> IQR 清洗归一化权重 -> 本地行情库 / VLM 四级降级
        const queries: PriceLookupQuery[] = parsed.items.map((it, idx) => ({
          id: `det-${idx}`,
          ipName: parsed.ip_name,
          label: it.label,
          seriesHint: it.series_hint,
          itemType: it.item_type && it.item_type !== '通用' ? it.item_type : category,
          jpKeywords: it.jp_keywords,
          vlmWeight: it.weight,
        }));

        const lookupOut = skipLookup
          ? null
          : await priceLookupService.lookupBatch({
              db,
              queries,
              customAiConfig: extracted.config,
              now,
              maxTotalBudgetMs: 18000,
              perSourceTimeoutMs: 7500,
              concurrency: 6,
            });
        const lookupById = new Map((lookupOut?.results ?? []).map((r) => [r.id, r]));

        const enrichedItems = parsed.items.map((item, idx) => {
          const lookedUp = lookupById.get(`det-${idx}`);
          if (lookedUp) {
            return {
              label: item.label,
              series_hint: item.series_hint,
              item_type: lookedUp.item_type,
              jp_keywords: item.jp_keywords,
              box: item.box,
              x: item.x,
              y: item.y,
              weight: lookedUp.weight,
              weight_source: lookedUp.weight_source,
              market_price: serializeMarketPrice(lookedUp),
            };
          }

          const hit = db.matchCharacterWeight(parsed.ip_name, item.label, category, { now });
          if (hit && hit.sample_count >= 3) {
            return {
              label: item.label,
              series_hint: item.series_hint,
              item_type: item.item_type || category,
              jp_keywords: item.jp_keywords,
              box: item.box,
              x: item.x,
              y: item.y,
              weight: hit.avg_weight_ratio,
              weight_source: 'market_db' as const,
            };
          }
          return {
            label: item.label,
            series_hint: item.series_hint,
            item_type: item.item_type || category,
            jp_keywords: item.jp_keywords,
            box: item.box,
            x: item.x,
            y: item.y,
            weight: item.weight,
            weight_source: 'vlm_guess' as const,
          };
        });

        db.addDetectLog({
          token_code: isByok ? 'byok' : tokenRecord?.code || 'unknown',
          provider: extracted.config.protocol,
          model: extracted.config.model || vlmProvider.modelName,
          detected_count: enrichedItems.length,
          latency_ms: Date.now() - startMs,
          status: 'ok',
          error_msg: null,
        });

        res.json({
          ip_name: parsed.ip_name,
          series_hint: parsed.series_hint,
          provider_used: providerUsed,
          items: enrichedItems,
          quota:
            !isByok && updatedToken
              ? {
                  code: updatedToken.code,
                  daily_limit: updatedToken.daily_limit,
                  used_today: updatedToken.used_today,
                  remaining_today: Math.max(0, updatedToken.daily_limit - updatedToken.used_today),
                }
              : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : '上游视觉模型调用失败';
        db.addDetectLog({
          token_code: isByok ? 'byok' : tokenRecord?.code || 'unknown',
          provider: extracted.config.protocol,
          model: extracted.config.model || vlmProvider.modelName,
          detected_count: 0,
          latency_ms: Date.now() - startMs,
          status: 'error',
          error_msg: message.slice(0, 200),
        });
        res.status(500).json({ detail: `识图服务暂时不可用：${message}` });
      }
    }
  );

  // 4.2b AI 自动调价推荐（结合真实二手市场比价、历史行情库与宽幅冷烫梯度）
  router.post('/auto-price', async (req, res) => {
    const startMs = Date.now();
    const now = getNow();
    const extracted = extractCustomAiConfig(req);
    if (extracted.error) {
      res.status(400).json({ detail: extracted.error });
      return;
    }

    const isByok = extracted.config.protocol !== 'server_default';
    const tokenRecord = db.verifyInviteCode(req.header('X-Access-Token')?.trim(), now);
    if (!isByok && !tokenRecord) {
      res.status(401).json({ detail: '邀请码无效或已停用，请在设置中检查邀请码，或填写自有 API Key。' });
      return;
    }

    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ detail: '请求体必须为合法 JSON 对象。' });
      return;
    }

    const ipName = typeof body.ip_name === 'string' ? body.ip_name.trim().slice(0, 60) : '';
    const category =
      typeof body.category === 'string' && body.category.trim()
        ? body.category.trim().slice(0, 24)
        : '通用';
    const targetTotal = Math.max(0, Number(body.target_total) || 0);
    const rawItems = Array.isArray(body.items) ? body.items : [];

    const extraMetaById = new Map<
      string,
      { seriesHint: string; itemType: string; jpKeywords: string }
    >();

    const inputItems: AutoPriceInputItem[] = rawItems
      .filter((it): it is Record<string, unknown> => Boolean(it && typeof it === 'object'))
      .slice(0, 60)
      .map((it, idx) => {
        const id = typeof it.id === 'string' && it.id.trim() ? it.id.trim().slice(0, 64) : `item-${idx}`;
        extraMetaById.set(id, {
          seriesHint: typeof it.series_hint === 'string' ? it.series_hint.trim().slice(0, 48) : '',
          itemType: typeof it.item_type === 'string' ? it.item_type.trim().slice(0, 24) : category,
          jpKeywords: typeof it.jp_keywords === 'string' ? it.jp_keywords.trim().slice(0, 80) : '',
        });
        return {
          id,
          label: typeof it.label === 'string' ? it.label.trim().slice(0, 32) : `谷子${idx + 1}`,
          locked: Boolean(it.locked),
          price: Number.isFinite(Number(it.price)) ? Math.max(0, Number(it.price)) : 0,
          quantity: Number.isFinite(Number(it.quantity)) ? Math.max(0, Math.floor(Number(it.quantity))) : 1,
          weight: Number.isFinite(Number(it.weight)) ? Math.max(0.1, Number(it.weight)) : 1,
          tag: typeof it.tag === 'string' ? it.tag.slice(0, 12) : '',
        };
      });

    if (inputItems.length < 2) {
      res.status(400).json({ detail: '至少需要 2 个单品才能进行 AI 自动调价。' });
      return;
    }

    if (!isByok && tokenRecord) {
      const quotaCheck = db.checkQuotaAvailable(tokenRecord.code, now);
      if (!quotaCheck.allowed) {
        res.status(429).json({
          detail: `今日默认服务次数已用完（${tokenRecord.used_today}/${tokenRecord.daily_limit}），请明日再试或在设置中填写自有 API Key。`,
        });
        return;
      }
    }

    try {
      const { rawText, providerUsed } = await vlmProvider.autoPriceGoods({
        ipName,
        category,
        targetTotal,
        items: inputItems,
        customConfig: extracted.config,
      });

      if (!isByok && tokenRecord) {
        db.consumeQuota(tokenRecord.code, now);
      }

      const parsed = parseAutoPriceResponseText(rawText, inputItems, ipName);
      const effectiveIp = parsed.ip_name || ipName;

      // Run multi-source market lookup & 4-tier fallback fusion
      const lookupQueries: PriceLookupQuery[] = parsed.items.map((item) => {
        const meta = extraMetaById.get(item.id);
        return {
          id: item.id,
          ipName: effectiveIp,
          label: item.label,
          seriesHint: meta?.seriesHint,
          itemType: meta?.itemType || category,
          jpKeywords: meta?.jpKeywords,
          vlmWeight: item.weight,
        };
      });

      const lookupOut = await priceLookupService.lookupBatch({
        db,
        queries: lookupQueries,
        customAiConfig: extracted.config,
        now,
        maxTotalBudgetMs: 22000,
        perSourceTimeoutMs: 8500,
        concurrency: 6,
      });
      const lookupMap = new Map(lookupOut.results.map((r) => [r.id, r]));

      const enriched = parsed.items.map((item) => {
        const lookedUp = lookupMap.get(item.id);
        if (lookedUp) {
          return {
            id: item.id,
            label: item.label,
            weight: lookedUp.weight,
            tag: item.tag,
            weight_source: lookedUp.weight_source,
            reason:
              lookedUp.market_price_median !== null
                ? `二手市价中位 ¥${lookedUp.market_price_median}（${lookedUp.sample_count}条）`
                : item.reason,
            market_price: serializeMarketPrice(lookedUp),
          };
        }
        return {
          id: item.id,
          label: item.label,
          weight: item.weight,
          tag: item.tag,
          weight_source: 'vlm_guess' as const,
          reason: item.reason,
        };
      });

      db.addDetectLog({
        token_code: isByok ? 'byok' : tokenRecord?.code || 'unknown',
        provider: `${extracted.config.protocol}:auto-price`,
        model: extracted.config.model || vlmProvider.modelName,
        detected_count: enriched.length,
        latency_ms: Date.now() - startMs,
        status: 'ok',
        error_msg: null,
      });

      res.json({
        ip_name: effectiveIp,
        provider_used: providerUsed,
        summary: parsed.summary,
        items: enriched,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI 自动调价失败';
      res.status(500).json({ detail: `AI 自动调价暂时不可用：${message}` });
    }
  });

  // 4.2c V2.0 多源市场自动比价接口（支持单品微调关键词重查 & 一键全团比价 & force_refresh 穿透缓存）
  router.post('/price-lookup', async (req, res) => {
    const now = getNow();
    const extracted = extractCustomAiConfig(req);
    if (extracted.error) {
      res.status(400).json({ detail: extracted.error });
      return;
    }

    const isByok = extracted.config.protocol !== 'server_default';
    const tokenRecord = db.verifyInviteCode(req.header('X-Access-Token')?.trim(), now);
    if (!isByok && !tokenRecord) {
      res.status(401).json({ detail: '邀请码无效或已停用，请在设置中检查邀请码，或填写自有 API Key。' });
      return;
    }

    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ detail: '请求体必须为合法 JSON 对象。' });
      return;
    }

    const ipName = typeof body.ip_name === 'string' ? body.ip_name.trim().slice(0, 60) : '';
    const category =
      typeof body.category === 'string' && body.category.trim()
        ? body.category.trim().slice(0, 24)
        : '通用';
    const jpyRate = Number(body.jpy_rate);
    const referenceAvgPrice = Number(body.reference_avg_price);
    const forceRefreshAll = Boolean(body.force_refresh);
    const rawItems = Array.isArray(body.items) ? body.items : [];

    if (rawItems.length === 0) {
      res.status(400).json({ detail: '请提供需要比价的谷子列表。' });
      return;
    }

    const queries: PriceLookupQuery[] = rawItems
      .filter((it): it is Record<string, unknown> => Boolean(it && typeof it === 'object'))
      .slice(0, 60)
      .map((it, idx) => ({
        id: typeof it.id === 'string' && it.id.trim() ? it.id.trim().slice(0, 64) : `lookup-${idx}`,
        ipName,
        label: typeof it.label === 'string' ? it.label.trim().slice(0, 32) : `谷子${idx + 1}`,
        seriesHint: typeof it.series_hint === 'string' ? it.series_hint.trim().slice(0, 48) : '',
        itemType:
          typeof it.item_type === 'string' && it.item_type.trim()
            ? it.item_type.trim().slice(0, 24)
            : category,
        jpKeywords: typeof it.jp_keywords === 'string' ? it.jp_keywords.trim().slice(0, 80) : '',
        vlmWeight: Number.isFinite(Number(it.weight)) ? Math.max(0.1, Number(it.weight)) : 1.0,
        forceRefresh: forceRefreshAll || Boolean(it.force_refresh),
      }));

    try {
      const out = await priceLookupService.lookupBatch({
        db,
        queries,
        jpyRate: Number.isFinite(jpyRate) && jpyRate > 0 ? jpyRate : undefined,
        referenceAvgMarketPrice:
          Number.isFinite(referenceAvgPrice) && referenceAvgPrice > 0 ? referenceAvgPrice : undefined,
        customAiConfig: extracted.config,
        now,
      });

      res.json({
        ip_name: ipName,
        jpy_rate: out.jpyRate,
        items: out.results.map((r) => ({
          id: r.id,
          label: r.label,
          series_hint: r.series_hint,
          item_type: r.item_type,
          jp_keywords: r.jp_keywords,
          weight: r.weight,
          weight_source: r.weight_source,
          market_price: serializeMarketPrice(r),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '市场比价服务异常';
      res.status(500).json({ detail: `自动比价暂时不可用：${message}` });
    }
  });

  // 4.3 匿名成团调价数据回流（带 45 天半衰期时间衰减）
  router.post('/market/contribute', (req, res) => {
    const now = getNow();
    const tokenHeader = req.header('X-Access-Token')?.trim();
    const tokenRecord = db.verifyInviteCode(tokenHeader, now);
    if (!tokenRecord) {
      res.status(401).json({ detail: '邀请码无效或已停用。' });
      return;
    }

    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ detail: '请求体必须为合法 JSON 对象。' });
      return;
    }

    const projectId = typeof body.project_id === 'string' ? body.project_id.trim().slice(0, 80) : '';
    const ipName = typeof body.ip_name === 'string' ? body.ip_name.trim().slice(0, 60) : '';
    const category =
      typeof body.category === 'string' && body.category.trim()
        ? body.category.trim().slice(0, 24)
        : '通用';
    const avgPrice = Number(body.avg_price);
    const rawItems = Array.isArray(body.items) ? body.items : [];

    if (!projectId) {
      res.status(400).json({ detail: '缺少有效的 project_id。' });
      return;
    }

    const items = rawItems
      .filter((it): it is Record<string, unknown> => Boolean(it && typeof it === 'object'))
      .map((it) => ({
        label: typeof it.label === 'string' ? it.label : '',
        final_price: Number(it.final_price),
      }));

    const result = db.contributeMarketData({
      tokenCode: tokenRecord.code,
      projectId,
      ipName,
      category,
      avgPrice,
      items,
      now,
    });

    res.json(result);
  });

  // 查询行情库统计与当前邀请码额度
  router.get('/market/stats', (req, res) => {
    const tokenHeader = req.header('X-Access-Token')?.trim();
    const tokenRecord = db.verifyInviteCode(tokenHeader, getNow());

    const ipQuery = typeof req.query.ip_name === 'string' ? req.query.ip_name : undefined;
    const categoryQuery = typeof req.query.category === 'string' ? req.query.category : undefined;
    const stats = db.listMarketStats({ ipName: ipQuery, category: categoryQuery });

    res.json({
      stats: stats.map((s) => ({
        id: s.id,
        ip_name: s.ip_name,
        character_name: s.character_name,
        category: s.category,
        avg_weight_ratio: s.avg_weight_ratio,
        sample_count: s.sample_count,
        updated_at: s.updated_at,
      })),
      invite_valid: Boolean(tokenRecord),
      quota: tokenRecord
        ? {
            code: tokenRecord.code,
            daily_limit: tokenRecord.daily_limit,
            used_today: tokenRecord.used_today,
            remaining_today: Math.max(0, tokenRecord.daily_limit - tokenRecord.used_today),
          }
        : null,
    });
  });

  // ============================================================================
  // Phase 3: Built-in Multi-User Live Group-Buy APIs (Atomic Anti-Oversell + SSE)
  // ============================================================================

  // 发布在线拼团
  router.post('/groups', (req, res) => {
    const now = getNow();
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ detail: '请求体必须为合法 JSON 对象。' });
      return;
    }

    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 64) : '在线谷子拼团';
    const ipName = typeof body.ip_name === 'string' ? body.ip_name.trim().slice(0, 60) : '';
    const annotatedImageDataUrl =
      typeof body.annotated_image_data_url === 'string' ? body.annotated_image_data_url.trim() : '';

    if (
      annotatedImageDataUrl &&
      !annotatedImageDataUrl.startsWith('data:image/') &&
      !annotatedImageDataUrl.startsWith('/')
    ) {
      res.status(400).json({ detail: '拼团图片格式不合法。' });
      return;
    }

    const rawItems = Array.isArray(body.items) ? body.items : [];
    const parsedItems = rawItems
      .filter((it): it is Record<string, unknown> => Boolean(it && typeof it === 'object'))
      .slice(0, 80)
      .map((it) => {
        const boxRaw = it.box;
        const box =
          Array.isArray(boxRaw) &&
          boxRaw.length === 4 &&
          boxRaw.every((v) => Number.isFinite(Number(v)))
            ? ([Number(boxRaw[0]), Number(boxRaw[1]), Number(boxRaw[2]), Number(boxRaw[3])] as [
                number,
                number,
                number,
                number,
              ])
            : undefined;
        return {
          sourceItemId: typeof it.source_item_id === 'string' ? it.source_item_id.slice(0, 64) : undefined,
          label: typeof it.label === 'string' ? it.label.trim().slice(0, 32) : '谷子单品',
          price: Math.max(0, Number(it.price) || 0),
          prepaidPrice:
            it.prepaid_price !== undefined && Number.isFinite(Number(it.prepaid_price))
              ? Math.max(0, Number(it.prepaid_price))
              : undefined,
          totalQty: Math.max(0, Math.floor(Number(it.total_qty) || 0)),
          tag: typeof it.tag === 'string' ? it.tag.trim().slice(0, 12) : '',
          box,
        };
      })
      .filter((it) => it.totalQty > 0 && it.tag !== '自留');

    if (parsedItems.length === 0) {
      res.status(400).json({ detail: '至少需要 1 个有效可认领单品（数量 > 0 且非自留）才能发起在线拼团。' });
      return;
    }

    const created = db.createGroupOrder({
      title,
      ipName,
      annotatedImageDataUrl,
      items: parsedItems,
      now,
    });

    const bundle = db.getGroupOrderByShareCode(created.order.share_code)!;
    res.status(201).json({
      share_code: created.order.share_code,
      share_url: `/g/${created.order.share_code}`,
      owner_token: created.order.owner_token,
      order: formatGroupOrderResponse(bundle, true),
    });
  });

  // 查询拼团详情与实时余量
  router.get('/groups/:shareCode', (req, res) => {
    const shareCode = String(req.params.shareCode || '').trim().toUpperCase();
    const bundle = db.getGroupOrderByShareCode(shareCode);
    if (!bundle) {
      res.status(404).json({ detail: '未找到该拼团链接，请确认分享码是否正确。' });
      return;
    }
    const ownerToken = extractOwnerToken(req);
    const isOwner = Boolean(ownerToken && ownerToken === bundle.order.owner_token);
    res.json({
      is_owner: isOwner,
      order: formatGroupOrderResponse(bundle, isOwner),
    });
  });

  // SSE 实时排表与库存流
  router.get('/groups/:shareCode/events', (req, res) => {
    const shareCode = String(req.params.shareCode || '').trim().toUpperCase();
    const bundle = db.getGroupOrderByShareCode(shareCode);
    if (!bundle) {
      res.status(404).json({ detail: '拼团不存在' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const snapshotPayload = JSON.stringify(formatGroupOrderResponse(bundle, false));
    res.write(`event: snapshot\ndata: ${snapshotPayload}\n\n`);

    let subs = sseSubscribers.get(shareCode);
    if (!subs) {
      subs = new Set();
      sseSubscribers.set(shareCode, subs);
    }
    subs.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      const currentSubs = sseSubscribers.get(shareCode);
      if (currentSubs) {
        currentSubs.delete(res);
        if (currentSubs.size === 0) {
          sseSubscribers.delete(shareCode);
        }
      }
    });
  });

  // 团员原子防超卖认领（排谷）
  router.post('/groups/:shareCode/claim', (req, res) => {
    const shareCode = String(req.params.shareCode || '').trim().toUpperCase();
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ detail: '请求体必须为合法 JSON 对象。' });
      return;
    }

    const itemId = typeof body.item_id === 'string' ? body.item_id.trim() : '';
    const buyerName = typeof body.buyer_name === 'string' ? body.buyer_name.trim() : '';
    const buyerContact = typeof body.buyer_contact === 'string' ? body.buyer_contact.trim() : '';
    const qty = Math.floor(Number(body.qty) || 1);

    if (!itemId) {
      res.status(400).json({ detail: '请选择要认领的角色款式。' });
      return;
    }
    if (!buyerName || buyerName.length > 32) {
      res.status(400).json({ detail: '请填写有效的CN/群昵称（1~32字）。' });
      return;
    }
    if (!buyerContact || buyerContact.length > 48) {
      res.status(400).json({ detail: '请填写有效的联系方式（QQ或微信号，仅团长可见完整号）。' });
      return;
    }
    if (qty <= 0 || qty > 50) {
      res.status(400).json({ detail: '单次认领数量需在 1 ~ 50 之间。' });
      return;
    }

    const result = db.claimGroupOrderItem({
      shareCode,
      itemId,
      buyerName,
      buyerContact,
      qty,
      now: getNow(),
    });

    if (!result.ok) {
      if (result.reason === 'not_found') {
        res.status(404).json({ detail: '未找到对应的拼团或角色款式。' });
        return;
      }
      if (result.reason === 'order_closed') {
        res.status(409).json({ detail: '当前拼团已锁单或截团，暂不可继续排谷。' });
        return;
      }
      if (result.reason === 'oversell_conflict') {
        res.status(409).json({
          detail:
            result.remaining && result.remaining > 0
              ? `手慢啦，该角色库存不足，当前仅剩 ${result.remaining} 件！`
              : '手慢啦，该角色刚刚被排完啦！',
          remaining: result.remaining ?? 0,
        });
        return;
      }
      res.status(400).json({ detail: '认领数量不合法。' });
      return;
    }

    broadcastGroupUpdate(shareCode);
    const updatedBundle = db.getGroupOrderByShareCode(shareCode)!;
    res.json({
      ok: true,
      claim_id: result.claim.id,
      claim_token: result.claim.claim_token,
      order: formatGroupOrderResponse(updatedBundle, false),
    });
  });

  // 取消认领并释放库存（团长凭 Bearer ownerToken 或团员凭 X-Claim-Token）
  router.delete('/groups/:shareCode/claims/:claimId', (req, res) => {
    const shareCode = String(req.params.shareCode || '').trim().toUpperCase();
    const claimId = String(req.params.claimId || '').trim();
    const ownerToken = extractOwnerToken(req);
    const claimToken =
      req.header('X-Claim-Token')?.trim() ||
      (typeof req.body?.claim_token === 'string' ? req.body.claim_token.trim() : undefined);

    const result = db.cancelGroupClaim({
      shareCode,
      claimId,
      ownerToken,
      claimToken,
      now: getNow(),
    });

    if (!result.ok) {
      if (result.reason === 'not_found') {
        res.status(404).json({ detail: '未找到该认领记录。' });
        return;
      }
      if (result.reason === 'forbidden') {
        res.status(401).json({ detail: '无权撤销该认领记录（仅团长或认领本人可操作）。' });
        return;
      }
      res.status(409).json({ detail: '该记录已被撤销。' });
      return;
    }

    broadcastGroupUpdate(shareCode);
    const updatedBundle = db.getGroupOrderByShareCode(shareCode)!;
    const isOwner = Boolean(ownerToken && ownerToken === updatedBundle.order.owner_token);
    res.json({
      ok: true,
      order: formatGroupOrderResponse(updatedBundle, isOwner),
    });
  });

  // 团长同步状态 / 盲抽二调最新价格与出货数
  router.patch('/groups/:shareCode/sync', (req, res) => {
    const shareCode = String(req.params.shareCode || '').trim().toUpperCase();
    const ownerToken = extractOwnerToken(req);
    if (!ownerToken) {
      res.status(401).json({ detail: '缺少团长管理凭证。' });
      return;
    }

    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ detail: '请求体必须为合法 JSON 对象。' });
      return;
    }

    const status =
      typeof body.status === 'string' && ['open', 'locked', 'settled'].includes(body.status)
        ? (body.status as GroupOrderStatus)
        : undefined;
    const annotatedImageDataUrl =
      typeof body.annotated_image_data_url === 'string' &&
      (body.annotated_image_data_url.startsWith('data:image/') ||
        body.annotated_image_data_url.startsWith('/'))
        ? body.annotated_image_data_url
        : undefined;

    const rawItems = Array.isArray(body.items) ? body.items : undefined;
    const items = rawItems
      ?.filter((it): it is Record<string, unknown> => Boolean(it && typeof it === 'object'))
      .map((it) => ({
        sourceItemId: typeof it.source_item_id === 'string' ? it.source_item_id : undefined,
        label: typeof it.label === 'string' ? it.label : '',
        price: Math.max(0, Number(it.price) || 0),
        prepaidPrice:
          it.prepaid_price !== undefined && Number.isFinite(Number(it.prepaid_price))
            ? Math.max(0, Number(it.prepaid_price))
            : undefined,
        totalQty:
          it.total_qty !== undefined && Number.isFinite(Number(it.total_qty))
            ? Math.max(0, Math.floor(Number(it.total_qty)))
            : undefined,
        tag: typeof it.tag === 'string' ? it.tag : undefined,
      }));

    const synced = db.syncGroupOrderFromOrganizer({
      shareCode,
      ownerToken,
      status,
      annotatedImageDataUrl,
      items,
      now: getNow(),
    });

    if (!synced.ok) {
      if (synced.reason === 'not_found') {
        res.status(404).json({ detail: '未找到该在线拼团。' });
        return;
      }
      res.status(401).json({ detail: '团长管理凭证无效，无法修改该拼团。' });
      return;
    }

    broadcastGroupUpdate(shareCode);
    const updatedBundle = db.getGroupOrderByShareCode(shareCode)!;
    res.json({
      ok: true,
      order: formatGroupOrderResponse(updatedBundle, true),
    });
  });

  // Ensure unmatched /api/v1/* routes always return JSON rather than falling through to SPA HTML
  router.use((_req, res) => {
    res.status(404).json({ detail: '请求的 API 接口不存在。' });
  });

  // Ensure middleware errors (e.g. malformed JSON body, payload too large) always return JSON
  router.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (res.headersSent) return;
      const errObj = err as { status?: number; type?: string; message?: string } | null;
      if (errObj?.type === 'entity.too.large' || errObj?.status === 413) {
        res.status(413).json({ detail: '请求数据体积过大，请压缩图片后重试。' });
        return;
      }
      if (errObj?.type === 'entity.parse.failed' || errObj?.status === 400) {
        res.status(400).json({ detail: '请求体 JSON 格式不合法。' });
        return;
      }
      res.status(500).json({
        detail: errObj?.message ? `服务端内部异常：${errObj.message}` : '服务端处理请求时发生异常，请稍后重试。',
      });
    }
  );

  return router;
}
