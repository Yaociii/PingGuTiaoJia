import express from 'express';
import multer from 'multer';
import type { GachaDatabase } from './db';
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

export function createApiRouter(options: {
  db: GachaDatabase;
  vlmProvider: VlmProvider;
  getNow?: () => Date;
}): express.Router {
  const { db, vlmProvider } = options;
  const getNow = options.getNow ?? (() => new Date());

  const router = express.Router();
  router.use(express.json({ limit: '6mb' }));

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
      version: '1.1.0',
      gemini_configured: vlmProvider.isConfigured(),
      supported_protocols: ['server_default', 'openai_compatible', 'gemini', 'anthropic'],
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
      res.status(502).json({
        detail: err instanceof Error ? err.message : '连接测试失败',
      });
    }
  });

  // 4.2 图像识别与初始热度推荐（支持默认服务端 Key 及用户自定义多协议 Key）
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

      // 1. 鉴权校验：使用默认内置服务必须校验邀请码；使用用户自有 Key 不消耗服务器默认额度
      if (!isByok && !tokenRecord) {
        res.status(401).json({ detail: '邀请码无效或已停用，请在设置中检查邀请码，或改用您自己的 API Key。' });
        return;
      }

      // 2. 图片存在性与格式校验（格式失败不扣额度）
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

      // 3. 每日限流校验（仅对默认服务端额度扣减）
      let updatedToken = tokenRecord;
      if (!isByok && tokenRecord) {
        const quotaCheck = db.checkQuotaAvailable(tokenRecord.code, now);
        if (!quotaCheck.allowed) {
          res.status(429).json({
            detail: `今日识图次数已用完（${tokenRecord.used_today}/${tokenRecord.daily_limit}），UTC 次日零点重置，您也可以在设置中填写自有 API Key 继续使用。`,
          });
          return;
        }
        updatedToken = db.consumeQuota(tokenRecord.code, now);
      }

      const ipHint = typeof req.body?.ip_hint === 'string' ? req.body.ip_hint.trim().slice(0, 60) : '';
      const category =
        typeof req.body?.category === 'string' && req.body.category.trim()
          ? req.body.category.trim().slice(0, 24)
          : '通用';

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
            .status(502)
            .json({ detail: '未能从图片中识别出独立的谷子单品，请尝试使用「网格打点」或手动加点。' });
          return;
        }

        // 4. 融合历史行情权重
        const enrichedItems = parsed.items.map((item) => {
          const hit = db.matchCharacterWeight(parsed.ip_name, item.label, category);
          if (hit && hit.sample_count >= 3) {
            return {
              label: item.label,
              box: item.box,
              x: item.x,
              y: item.y,
              weight: hit.avg_weight_ratio,
              weight_source: 'market_db' as const,
            };
          }
          return {
            label: item.label,
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
        res.status(502).json({ detail: `识图服务暂时不可用：${message}` });
      }
    }
  );

  // 4.2b AI 自动调价推荐（结合谷圈市场热度与历史行情库，推荐每个角色权重与热烫/捆物标记）
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

    const inputItems: AutoPriceInputItem[] = rawItems
      .filter((it): it is Record<string, unknown> => Boolean(it && typeof it === 'object'))
      .slice(0, 60)
      .map((it, idx) => ({
        id: typeof it.id === 'string' && it.id.trim() ? it.id.trim().slice(0, 64) : `item-${idx}`,
        label: typeof it.label === 'string' ? it.label.trim().slice(0, 32) : `谷子${idx + 1}`,
        locked: Boolean(it.locked),
        price: Number.isFinite(Number(it.price)) ? Math.max(0, Number(it.price)) : 0,
        quantity: Number.isFinite(Number(it.quantity)) ? Math.max(0, Math.floor(Number(it.quantity))) : 1,
        weight: Number.isFinite(Number(it.weight)) ? Math.max(0.1, Number(it.weight)) : 1,
        tag: typeof it.tag === 'string' ? it.tag.slice(0, 12) : '',
      }));

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
      db.consumeQuota(tokenRecord.code, now);
    }

    try {
      const { rawText, providerUsed } = await vlmProvider.autoPriceGoods({
        ipName,
        category,
        targetTotal,
        items: inputItems,
        customConfig: extracted.config,
      });

      const parsed = parseAutoPriceResponseText(rawText, inputItems, ipName);
      const effectiveIp = parsed.ip_name || ipName;

      // 优先融合历史行情库（样本 >= 3 覆盖权重并标记 market_db）
      const enriched = parsed.items.map((item) => {
        const hit = effectiveIp
          ? db.matchCharacterWeight(effectiveIp, item.label, category)
          : null;
        if (hit && hit.sample_count >= 3) {
          return {
            id: item.id,
            label: item.label,
            weight: hit.avg_weight_ratio,
            tag: item.tag,
            weight_source: 'market_db' as const,
            reason: item.reason || `历史行情库 ${hit.sample_count} 团均值`,
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
      res.status(502).json({ detail: `AI 自动调价暂时不可用：${message}` });
    }
  });

  // 4.3 匿名成团调价数据回流
  router.post('/market/contribute', (req, res) => {
    const tokenHeader = req.header('X-Access-Token')?.trim();
    const tokenRecord = db.verifyInviteCode(tokenHeader, getNow());
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
    });

    res.json(result);
  });

  // 查询行情库统计与当前邀请码额度（行情参考数据为公开聚合权重，BYOK 用户无需邀请码也可查阅）
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

  return router;
}
