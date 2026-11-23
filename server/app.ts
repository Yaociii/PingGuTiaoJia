import express from 'express';
import multer from 'multer';
import type { GachaDatabase } from './db';
import { parseVlmResponseText } from './vlmParser';
import { detectImageMimeType, type VlmProvider } from './vlmProvider';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB

export function createApiRouter(options: {
  db: GachaDatabase;
  vlmProvider: VlmProvider;
  getNow?: () => Date;
}): express.Router {
  const { db, vlmProvider } = options;
  const getNow = options.getNow ?? (() => new Date());

  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

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
      version: '1.0.0',
      gemini_configured: vlmProvider.isConfigured(),
    });
  });

  // 4.2 图像识别与初始热度推荐
  router.post('/detect', (req, res, next) => {
    upload.single('image')(req, res, (err: unknown) => {
      if (err) {
        const multerErr = err as { code?: string; message?: string };
        if (multerErr.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ detail: '图片大小超过 15MB 上限，请压缩后再试。' });
          return;
        }
        res.status(400).json({ detail: '图片上传格式无效，请上传 PNG / JPG / WEBP 图片。' });
        return;
      }
      next();
    });
  }, async (req, res) => {
    const startMs = Date.now();
    const tokenHeader = req.header('X-Access-Token')?.trim();
    const now = getNow();

    // 1. 鉴权校验
    const tokenRecord = db.verifyInviteCode(tokenHeader, now);
    if (!tokenRecord) {
      res.status(401).json({ detail: '邀请码无效或已停用，请在设置中检查访问邀请码。' });
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

    // 3. 每日限流校验（在调用 VLM 前校验并扣减）
    const quotaCheck = db.checkQuotaAvailable(tokenRecord.code, now);
    if (!quotaCheck.allowed) {
      res.status(429).json({
        detail: `今日识图次数已用完（${tokenRecord.used_today}/${tokenRecord.daily_limit}），UTC 次日零点自动重置。`,
      });
      return;
    }

    const ipHint = typeof req.body?.ip_hint === 'string' ? req.body.ip_hint.trim().slice(0, 60) : '';
    const category = typeof req.body?.category === 'string' && req.body.category.trim()
      ? req.body.category.trim().slice(0, 24)
      : '通用';

    const updatedToken = db.consumeQuota(tokenRecord.code, now);

    try {
      const rawVlmText = await vlmProvider.detectGoods({
        imageBuffer: file.buffer,
        mimeType: detectedMime,
        ipHint,
      });

      const parsed = parseVlmResponseText(rawVlmText, ipHint);
      if (parsed.items.length === 0) {
        db.addDetectLog({
          token_code: tokenRecord.code,
          provider: vlmProvider.providerName,
          model: vlmProvider.modelName,
          detected_count: 0,
          latency_ms: Date.now() - startMs,
          status: 'error',
          error_msg: '未检测到有效谷子单品',
        });
        res.status(502).json({ detail: '未能从图片中识别出独立的谷子单品，请尝试使用「网格打点」或手动加点。' });
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
        token_code: tokenRecord.code,
        provider: vlmProvider.providerName,
        model: vlmProvider.modelName,
        detected_count: enrichedItems.length,
        latency_ms: Date.now() - startMs,
        status: 'ok',
        error_msg: null,
      });

      res.json({
        ip_name: parsed.ip_name,
        provider_used: `${vlmProvider.providerName}:${vlmProvider.modelName}`,
        items: enrichedItems,
        quota: updatedToken
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
        token_code: tokenRecord.code,
        provider: vlmProvider.providerName,
        model: vlmProvider.modelName,
        detected_count: 0,
        latency_ms: Date.now() - startMs,
        status: 'error',
        error_msg: message,
      });
      res.status(502).json({ detail: `识图服务暂时不可用：${message}` });
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
    const category = typeof body.category === 'string' && body.category.trim() ? body.category.trim().slice(0, 24) : '通用';
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

  // 查询行情库统计与当前邀请码额度
  router.get('/market/stats', (req, res) => {
    const tokenHeader = req.header('X-Access-Token')?.trim();
    const tokenRecord = db.verifyInviteCode(tokenHeader, getNow());
    if (!tokenRecord) {
      res.status(401).json({ detail: '邀请码无效或已停用。' });
      return;
    }

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
      quota: {
        code: tokenRecord.code,
        daily_limit: tokenRecord.daily_limit,
        used_today: tokenRecord.used_today,
        remaining_today: Math.max(0, tokenRecord.daily_limit - tokenRecord.used_today),
      },
    });
  });

  return router;
}
