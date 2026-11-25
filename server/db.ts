import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CharacterMarketStatRecord,
  DetectLogRecord,
  GroupClaimRecord,
  GroupOrderItemRecord,
  GroupOrderRecord,
  GroupOrderStatus,
  InviteCodeRecord,
  MarketPriceCacheRecord,
  MarketPriceSourceRecord,
  PriceFreshness,
  PricingTier,
} from './types';
import {
  computeUpdatedWeightRatio,
  isPlaceholderLabel,
  matchMarketStat,
  normalizeKey,
} from './marketMatcher';
import { SCHEMA_SQL } from './sqliteSchema';

export function getUtcDateString(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function createSeedStats(): CharacterMarketStatRecord[] {
  const now = new Date().toISOString();
  const seeds: Array<[string, string, string, number, number]> = [
    ['幻境物语', '紫晶魔女', '立牌', 2.45, 18],
    ['幻境物语', '苍蓝剑士', '立牌', 1.68, 15],
    ['幻境物语', '圣洁祭司', '立牌', 1.15, 11],
    ['幻境物语', '绯红骑士', '立牌', 0.92, 9],
    ['幻境物语', '精灵射手', '立牌', 0.54, 10],
    ['幻境物语', '翠影游侠', '立牌', 0.36, 8],
    ['排球少年', '孤爪研磨', '吧唧', 2.35, 24],
    ['排球少年', '黑尾铁朗', '吧唧', 1.78, 21],
    ['排球少年', '及川彻', '吧唧', 1.86, 19],
    ['排球少年', '日向翔阳', '吧唧', 1.22, 17],
    ['排球少年', '影山飞雄', '吧唧', 1.28, 16],
    ['排球少年', '月岛萤', '吧唧', 1.12, 14],
    ['排球少年', '夜久卫辅', '吧唧', 0.62, 12],
    ['排球少年', '犬冈走', '吧唧', 0.35, 11],
    ['蓝色监狱', '凪诚士郎', '吧唧', 2.25, 15],
    ['蓝色监狱', '糸师凛', '吧唧', 2.1, 14],
    ['蓝色监狱', '洁世一', '吧唧', 1.18, 12],
    ['蓝色监狱', '蜂乐回', '吧唧', 0.88, 9],
  ];

  return seeds.map(([ip_name, character_name, category, avg_weight_ratio, sample_count], idx) => ({
    id: idx + 1,
    ip_name,
    character_name,
    normalized_key: normalizeKey(character_name),
    category,
    avg_weight_ratio,
    sample_count,
    updated_at: now,
  }));
}

function generateShareCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

type SqlRow = Record<string, unknown>;

function mapInviteCodeRow(row: SqlRow): InviteCodeRecord {
  return {
    code: String(row.code),
    owner_note: String(row.owner_note ?? ''),
    daily_limit: Number(row.daily_limit),
    used_today: Number(row.used_today),
    last_reset_date: String(row.last_reset_date),
    is_active: Boolean(row.is_active),
    created_at: String(row.created_at),
  };
}

function mapStatRow(row: SqlRow): CharacterMarketStatRecord {
  return {
    id: Number(row.id),
    ip_name: String(row.ip_name),
    character_name: String(row.character_name),
    normalized_key: String(row.normalized_key),
    category: String(row.category),
    avg_weight_ratio: Number(row.avg_weight_ratio),
    sample_count: Number(row.sample_count),
    updated_at: String(row.updated_at),
  };
}

function mapCacheRow(row: SqlRow): MarketPriceCacheRecord {
  let range: [number, number] | null = null;
  if (typeof row.market_price_range === 'string' && row.market_price_range.trim()) {
    try {
      const parsed = JSON.parse(row.market_price_range);
      if (Array.isArray(parsed) && parsed.length === 2) {
        range = [Number(parsed[0]), Number(parsed[1])];
      }
    } catch {
      range = null;
    }
  }

  let sources: MarketPriceSourceRecord[] = [];
  if (typeof row.sources === 'string' && row.sources.trim()) {
    try {
      const parsed = JSON.parse(row.sources);
      if (Array.isArray(parsed)) {
        sources = parsed.map((s) => ({ ...(s as MarketPriceSourceRecord) }));
      }
    } catch {
      sources = [];
    }
  }

  return {
    cache_key: String(row.cache_key),
    ip_name: String(row.ip_name),
    normalized_char: String(row.normalized_char),
    series_key: String(row.series_key ?? ''),
    item_type: String(row.item_type ?? '通用'),
    market_price_median:
      row.market_price_median === null || row.market_price_median === undefined
        ? null
        : Number(row.market_price_median),
    market_price_range: range,
    sample_count: Number(row.sample_count ?? 0),
    sources,
    pricing_tier: String(row.pricing_tier) as PricingTier,
    freshness: String(row.freshness) as PriceFreshness,
    query_used: String(row.query_used ?? ''),
    cached_at: String(row.cached_at),
    expires_at: String(row.expires_at),
  };
}

function mapDetectLogRow(row: SqlRow): DetectLogRecord {
  return {
    id: Number(row.id),
    token_code: String(row.token_code ?? ''),
    provider: String(row.provider),
    model: String(row.model),
    detected_count: Number(row.detected_count ?? 0),
    latency_ms: Number(row.latency_ms ?? 0),
    status: (row.status === 'error' ? 'error' : 'ok') as 'ok' | 'error',
    error_msg: row.error_msg === null || row.error_msg === undefined ? null : String(row.error_msg),
    created_at: String(row.created_at),
  };
}

function mapGroupOrderRow(row: SqlRow): GroupOrderRecord {
  return {
    id: String(row.id),
    share_code: String(row.share_code),
    title: String(row.title),
    ip_name: String(row.ip_name),
    owner_token: String(row.owner_token),
    annotated_image_data_url: String(row.annotated_image_data_url ?? ''),
    status: String(row.status) as GroupOrderStatus,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapGroupOrderItemRow(row: SqlRow): GroupOrderItemRecord {
  return {
    id: String(row.id),
    order_id: String(row.order_id),
    source_item_id:
      row.source_item_id === null || row.source_item_id === undefined
        ? undefined
        : String(row.source_item_id),
    label: String(row.label),
    price: Number(row.price),
    prepaid_price:
      row.prepaid_price === null || row.prepaid_price === undefined
        ? undefined
        : Number(row.prepaid_price),
    total_qty: Number(row.total_qty),
    claimed_qty: Number(row.claimed_qty),
    tag: String(row.tag ?? ''),
    box_json:
      row.box_json === null || row.box_json === undefined ? undefined : String(row.box_json),
  };
}

function mapGroupClaimRow(row: SqlRow): GroupClaimRecord {
  return {
    id: String(row.id),
    order_id: String(row.order_id),
    item_id: String(row.item_id),
    buyer_name: String(row.buyer_name),
    buyer_contact: String(row.buyer_contact),
    qty: Number(row.qty),
    claim_token: String(row.claim_token),
    status: (row.status === 'cancelled' ? 'cancelled' : 'active') as 'active' | 'cancelled',
    created_at: String(row.created_at),
  };
}

export class GachaDatabase {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(options?: {
    filePath?: string | null;
    defaultInviteCode?: string;
    defaultDailyLimit?: number;
    seedMarketStats?: boolean;
  }) {
    const filePath = options?.filePath === undefined ? null : options.filePath;
    const defaultCode = options?.defaultInviteCode || process.env.DEFAULT_INVITE_CODE || 'dev-local-001';
    const defaultLimit =
      options?.defaultDailyLimit ||
      Math.max(1, Number.parseInt(process.env.DEFAULT_DAILY_LIMIT || '50', 10) || 50);

    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.db = new DatabaseSync(filePath);
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    } else {
      this.db = new DatabaseSync(':memory:');
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    }

    this.db.exec(SCHEMA_SQL);

    // Seed default market stats if empty and seedMarketStats !== false
    const countRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM character_market_stats')
      .get() as { cnt: number | bigint } | undefined;
    if (Number(countRow?.cnt ?? 0) === 0 && options?.seedMarketStats !== false) {
      const seeds = createSeedStats();
      const insertStat = this.db.prepare(`
        INSERT OR IGNORE INTO character_market_stats
          (id, ip_name, character_name, normalized_key, category, avg_weight_ratio, sample_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const s of seeds) {
          insertStat.run(
            s.id,
            s.ip_name,
            s.character_name,
            s.normalized_key,
            s.category,
            s.avg_weight_ratio,
            s.sample_count,
            s.updated_at
          );
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }

    // Ensure default invite code exists
    this.db
      .prepare(`
        INSERT OR IGNORE INTO invite_codes
          (code, owner_note, daily_limit, used_today, last_reset_date, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        defaultCode,
        '默认本地邀请码',
        defaultLimit,
        0,
        getUtcDateString(),
        1,
        new Date().toISOString()
      );

    process.once('beforeExit', () => {
      this.close();
    });
  }

  public get rawDb(): DatabaseSync {
    return this.db;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // ignore already closed
    }
  }

  public addInviteCode(record: InviteCodeRecord): void {
    this.db
      .prepare(`
        INSERT INTO invite_codes
          (code, owner_note, daily_limit, used_today, last_reset_date, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          owner_note      = excluded.owner_note,
          daily_limit     = excluded.daily_limit,
          used_today      = excluded.used_today,
          last_reset_date = excluded.last_reset_date,
          is_active       = excluded.is_active,
          created_at      = excluded.created_at
      `)
      .run(
        record.code,
        record.owner_note ?? '',
        record.daily_limit,
        record.used_today,
        record.last_reset_date,
        record.is_active ? 1 : 0,
        record.created_at
      );
  }

  public verifyInviteCode(code: string | undefined, now = new Date()): InviteCodeRecord | null {
    if (!code || typeof code !== 'string') return null;
    const trimmed = code.trim();
    if (!trimmed) return null;

    const row = this.db
      .prepare('SELECT * FROM invite_codes WHERE code = ?')
      .get(trimmed) as SqlRow | undefined;
    if (!row) return null;

    const record = mapInviteCodeRow(row);
    if (!record.is_active) return null;

    const today = getUtcDateString(now);
    if (record.last_reset_date !== today) {
      this.db
        .prepare('UPDATE invite_codes SET used_today = 0, last_reset_date = ? WHERE code = ?')
        .run(today, record.code);
      record.used_today = 0;
      record.last_reset_date = today;
    }
    return record;
  }

  public checkQuotaAvailable(
    code: string,
    now = new Date()
  ): { allowed: boolean; record: InviteCodeRecord | null } {
    const record = this.verifyInviteCode(code, now);
    if (!record) return { allowed: false, record: null };
    return { allowed: record.used_today < record.daily_limit, record };
  }

  public consumeQuota(code: string, now = new Date()): InviteCodeRecord | null {
    const verified = this.verifyInviteCode(code, now);
    if (!verified) return null;

    const res = this.db
      .prepare(`
        UPDATE invite_codes
           SET used_today = used_today + 1
         WHERE code = ? AND is_active = 1 AND used_today < daily_limit
      `)
      .run(verified.code);

    if (Number(res.changes) === 0) {
      return null;
    }

    const updated = this.db
      .prepare('SELECT * FROM invite_codes WHERE code = ?')
      .get(verified.code) as SqlRow | undefined;
    return updated ? mapInviteCodeRow(updated) : null;
  }

  // --- V2.0 Market Price Cache (default 48h TTL) ---
  public getCachedMarketPrice(
    cacheKey: string,
    now = new Date()
  ): MarketPriceCacheRecord | null {
    const nowIso = now.toISOString();
    const row = this.db
      .prepare('SELECT * FROM market_price_cache WHERE cache_key = ? AND expires_at > ?')
      .get(cacheKey, nowIso) as SqlRow | undefined;
    if (!row) {
      this.db
        .prepare('DELETE FROM market_price_cache WHERE cache_key = ? AND expires_at <= ?')
        .run(cacheKey, nowIso);
      return null;
    }
    const rec = mapCacheRow(row);
    const exp = Date.parse(rec.expires_at);
    if (!Number.isFinite(exp) || exp <= now.getTime()) {
      this.db.prepare('DELETE FROM market_price_cache WHERE cache_key = ?').run(cacheKey);
      return null;
    }
    return rec;
  }

  public setCachedMarketPrice(record: MarketPriceCacheRecord): void {
    this.db
      .prepare(`
        INSERT INTO market_price_cache
          (cache_key, ip_name, normalized_char, series_key, item_type,
           market_price_median, market_price_range, sample_count, sources,
           pricing_tier, freshness, query_used, cached_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          ip_name             = excluded.ip_name,
          normalized_char     = excluded.normalized_char,
          series_key          = excluded.series_key,
          item_type           = excluded.item_type,
          market_price_median = excluded.market_price_median,
          market_price_range  = excluded.market_price_range,
          sample_count        = excluded.sample_count,
          sources             = excluded.sources,
          pricing_tier        = excluded.pricing_tier,
          freshness           = excluded.freshness,
          query_used          = excluded.query_used,
          cached_at           = excluded.cached_at,
          expires_at          = excluded.expires_at
      `)
      .run(
        record.cache_key,
        record.ip_name,
        record.normalized_char,
        record.series_key ?? '',
        record.item_type ?? '通用',
        record.market_price_median === null || record.market_price_median === undefined
          ? null
          : record.market_price_median,
        record.market_price_range ? JSON.stringify(record.market_price_range) : null,
        record.sample_count ?? 0,
        JSON.stringify(record.sources ?? []),
        record.pricing_tier,
        record.freshness,
        record.query_used ?? '',
        record.cached_at,
        record.expires_at
      );

    // Keep cache bounded to 1000 entries
    const countRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM market_price_cache')
      .get() as { cnt: number | bigint } | undefined;
    const total = Number(countRow?.cnt ?? 0);
    if (total > 1000) {
      this.db
        .prepare(`
          DELETE FROM market_price_cache
           WHERE cache_key IN (
             SELECT cache_key FROM market_price_cache
              ORDER BY cached_at ASC
              LIMIT ?
           )
        `)
        .run(total - 1000);
    }
  }

  // --- Character Market Stats with 45-day half-life decay ---
  public matchCharacterWeight(
    ipName: string,
    label: string,
    category = '通用',
    options?: { now?: Date; allowStale?: boolean }
  ): CharacterMarketStatRecord | null {
    const rawRows = this.db.prepare('SELECT * FROM character_market_stats').all() as SqlRow[];
    const stats = rawRows.map(mapStatRow);
    return matchMarketStat(stats, ipName, label, category, options);
  }

  public listMarketStats(filter?: {
    ipName?: string;
    category?: string;
  }): CharacterMarketStatRecord[] {
    const hasCategory = Boolean(filter?.category?.trim() && filter.category !== '全部');
    const rawRows = (
      hasCategory
        ? this.db
            .prepare(
              'SELECT * FROM character_market_stats WHERE category = ? ORDER BY sample_count DESC, avg_weight_ratio DESC'
            )
            .all(filter!.category!.trim())
        : this.db
            .prepare(
              'SELECT * FROM character_market_stats ORDER BY sample_count DESC, avg_weight_ratio DESC'
            )
            .all()
    ) as SqlRow[];

    let rows = rawRows.map(mapStatRow);
    if (filter?.ipName?.trim()) {
      const q = normalizeKey(filter.ipName);
      rows = rows.filter(
        (r) => normalizeKey(r.ip_name).includes(q) || normalizeKey(r.character_name).includes(q)
      );
    }
    return rows.sort(
      (a, b) => b.sample_count - a.sample_count || b.avg_weight_ratio - a.avg_weight_ratio
    );
  }

  public contributeMarketData(payload: {
    tokenCode: string;
    projectId: string;
    ipName: string;
    category: string;
    avgPrice: number;
    items: Array<{ label: string; final_price: number }>;
    now?: Date;
  }): { accepted: boolean; updated_count?: number; reason?: string } {
    const { tokenCode, projectId, ipName, category, avgPrice, items } = payload;
    const now = payload.now ?? new Date();

    const existingContrib = this.db
      .prepare('SELECT 1 FROM market_contributions WHERE token_code = ? AND project_id = ? LIMIT 1')
      .get(tokenCode, projectId);
    if (existingContrib) {
      return { accepted: false, reason: 'already_contributed' };
    }

    const cleanIp = ipName.trim();
    if (
      !cleanIp ||
      !Array.isArray(items) ||
      items.length < 2 ||
      !Number.isFinite(avgPrice) ||
      avgPrice <= 0
    ) {
      return { accepted: false, reason: 'no_price_variance' };
    }

    const validItems = items.filter(
      (it) =>
        it &&
        typeof it.label === 'string' &&
        !isPlaceholderLabel(it.label) &&
        Number.isFinite(it.final_price) &&
        it.final_price > 0
    );

    if (validItems.length < 2) {
      return { accepted: false, reason: 'no_price_variance' };
    }

    const firstPrice = validItems[0].final_price;
    const hasVariance = validItems.some((it) => Math.abs(it.final_price - firstPrice) > 0.009);
    if (!hasVariance) {
      return { accepted: false, reason: 'no_price_variance' };
    }

    const cleanCategory = category?.trim() || '通用';
    const nowIso = now.toISOString();
    let updatedCount = 0;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const dupCheck = this.db
        .prepare('SELECT 1 FROM market_contributions WHERE token_code = ? AND project_id = ? LIMIT 1')
        .get(tokenCode, projectId);
      if (dupCheck) {
        this.db.exec('ROLLBACK');
        return { accepted: false, reason: 'already_contributed' };
      }

      const findStmt = this.db.prepare(
        'SELECT * FROM character_market_stats WHERE normalized_key = ? AND category = ? LIMIT 1'
      );
      const updateStmt = this.db.prepare(`
        UPDATE character_market_stats
           SET avg_weight_ratio = ?, sample_count = ?, updated_at = ?
         WHERE id = ?
      `);
      const insertStmt = this.db.prepare(`
        INSERT INTO character_market_stats
          (ip_name, character_name, normalized_key, category, avg_weight_ratio, sample_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of validItems) {
        const charName = item.label.trim().slice(0, 32);
        const normKey = normalizeKey(charName);
        if (!normKey) continue;

        const existingRow = findStmt.get(normKey, cleanCategory) as SqlRow | undefined;
        if (existingRow) {
          const existing = mapStatRow(existingRow);
          const next = computeUpdatedWeightRatio(
            existing.avg_weight_ratio,
            existing.sample_count,
            item.final_price,
            avgPrice,
            { lastUpdatedAt: existing.updated_at, now }
          );
          updateStmt.run(next.avg_weight_ratio, next.sample_count, nowIso, existing.id);
        } else {
          const next = computeUpdatedWeightRatio(1.0, 0, item.final_price, avgPrice, { now });
          insertStmt.run(
            cleanIp,
            charName,
            normKey,
            cleanCategory,
            next.avg_weight_ratio,
            next.sample_count,
            nowIso
          );
        }
        updatedCount++;
      }

      this.db
        .prepare(`
          INSERT INTO market_contributions (token_code, project_id, ip_name, item_count, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(tokenCode, projectId, cleanIp, updatedCount, nowIso);

      this.db.exec('COMMIT');
      return { accepted: true, updated_count: updatedCount };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public addDetectLog(entry: Omit<DetectLogRecord, 'id' | 'created_at'>): void {
    this.db
      .prepare(`
        INSERT INTO detect_logs
          (token_code, provider, model, detected_count, latency_ms, status, error_msg, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.token_code ?? '',
        entry.provider,
        entry.model,
        entry.detected_count ?? 0,
        entry.latency_ms ?? 0,
        entry.status,
        entry.error_msg ?? null,
        new Date().toISOString()
      );

    // Keep latest 500 logs
    const countRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM detect_logs')
      .get() as { cnt: number | bigint } | undefined;
    if (Number(countRow?.cnt ?? 0) > 500) {
      this.db
        .prepare(`
          DELETE FROM detect_logs
           WHERE id NOT IN (
             SELECT id FROM detect_logs ORDER BY id DESC LIMIT 500
           )
        `)
        .run();
    }
  }

  public getDetectLogs(): DetectLogRecord[] {
    const rows = this.db.prepare('SELECT * FROM detect_logs ORDER BY id ASC').all() as SqlRow[];
    return rows.map(mapDetectLogRow);
  }

  // --- V2.0 Phase 3: Multi-User Live Group-Buy Orders (Atomic Anti-Oversell) ---
  public createGroupOrder(params: {
    title: string;
    ipName: string;
    annotatedImageDataUrl: string;
    items: Array<{
      sourceItemId?: string;
      label: string;
      price: number;
      prepaidPrice?: number;
      totalQty: number;
      tag?: string;
      box?: [number, number, number, number];
    }>;
    now?: Date;
  }): { order: GroupOrderRecord; items: GroupOrderItemRecord[] } {
    const nowIso = (params.now ?? new Date()).toISOString();
    const orderId = crypto.randomUUID();
    const ownerToken = crypto.randomBytes(24).toString('hex');

    const checkCodeStmt = this.db.prepare('SELECT 1 FROM group_orders WHERE share_code = ? LIMIT 1');
    const insertOrderStmt = this.db.prepare(`
      INSERT INTO group_orders
        (id, share_code, title, ip_name, owner_token, annotated_image_data_url, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertItemStmt = this.db.prepare(`
      INSERT INTO group_order_items
        (id, order_id, source_item_id, label, price, prepaid_price, total_qty, claimed_qty, tag, box_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      let shareCode = generateShareCode();
      while (checkCodeStmt.get(shareCode)) {
        shareCode = generateShareCode();
      }

      const order: GroupOrderRecord = {
        id: orderId,
        share_code: shareCode,
        title: params.title.trim().slice(0, 64) || '在线谷子拼团',
        ip_name: params.ipName.trim().slice(0, 60) || '',
        owner_token: ownerToken,
        annotated_image_data_url: params.annotatedImageDataUrl,
        status: 'open',
        created_at: nowIso,
        updated_at: nowIso,
      };

      insertOrderStmt.run(
        order.id,
        order.share_code,
        order.title,
        order.ip_name,
        order.owner_token,
        order.annotated_image_data_url,
        order.status,
        order.created_at,
        order.updated_at
      );

      const createdItems: GroupOrderItemRecord[] = params.items
        .filter((it) => it.totalQty > 0)
        .map((it) => {
          const itemRec: GroupOrderItemRecord = {
            id: crypto.randomUUID(),
            order_id: orderId,
            source_item_id: it.sourceItemId,
            label: it.label.trim().slice(0, 32) || '谷子单品',
            price: Math.max(0, Math.round(it.price * 100) / 100),
            prepaid_price:
              it.prepaidPrice !== undefined && Number.isFinite(it.prepaidPrice)
                ? Math.max(0, Math.round(it.prepaidPrice * 100) / 100)
                : Math.max(0, Math.round(it.price * 100) / 100),
            total_qty: Math.max(1, Math.floor(it.totalQty)),
            claimed_qty: 0,
            tag: (it.tag || '').trim().slice(0, 12),
            box_json: it.box ? JSON.stringify(it.box) : undefined,
          };

          insertItemStmt.run(
            itemRec.id,
            itemRec.order_id,
            itemRec.source_item_id ?? null,
            itemRec.label,
            itemRec.price,
            itemRec.prepaid_price ?? null,
            itemRec.total_qty,
            itemRec.claimed_qty,
            itemRec.tag,
            itemRec.box_json ?? null
          );

          return itemRec;
        });

      this.db.exec('COMMIT');
      return { order: { ...order }, items: createdItems.map((it) => ({ ...it })) };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public getGroupOrderByShareCode(shareCode: string): {
    order: GroupOrderRecord;
    items: GroupOrderItemRecord[];
    claims: GroupClaimRecord[];
  } | null {
    const code = shareCode.trim().toUpperCase();
    const orderRow = this.db
      .prepare('SELECT * FROM group_orders WHERE share_code = ?')
      .get(code) as SqlRow | undefined;
    if (!orderRow) return null;

    const order = mapGroupOrderRow(orderRow);
    const itemRows = this.db
      .prepare('SELECT * FROM group_order_items WHERE order_id = ? ORDER BY rowid ASC')
      .all(order.id) as SqlRow[];
    const claimRows = this.db
      .prepare("SELECT * FROM group_claims WHERE order_id = ? AND status = 'active' ORDER BY rowid ASC")
      .all(order.id) as SqlRow[];

    return {
      order,
      items: itemRows.map(mapGroupOrderItemRow),
      claims: claimRows.map(mapGroupClaimRow),
    };
  }

  /**
   * 原子防超卖认领：在 BEGIN IMMEDIATE 写事务内执行条件更新 WHERE claimed_qty + ? <= total_qty，
   * 库存不足时回滚并返回 oversell_conflict (HTTP 409)
   */
  public claimGroupOrderItem(params: {
    shareCode: string;
    itemId: string;
    buyerName: string;
    buyerContact: string;
    qty: number;
    now?: Date;
  }):
    | { ok: true; claim: GroupClaimRecord; item: GroupOrderItemRecord }
    | { ok: false; reason: 'not_found' | 'order_closed' | 'invalid_qty' | 'oversell_conflict'; remaining?: number } {
    const code = params.shareCode.trim().toUpperCase();
    const qty = Math.floor(params.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, reason: 'invalid_qty' };
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const orderRow = this.db
        .prepare('SELECT * FROM group_orders WHERE share_code = ?')
        .get(code) as SqlRow | undefined;
      if (!orderRow) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const order = mapGroupOrderRow(orderRow);
      if (order.status !== 'open') {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'order_closed' };
      }

      const itemRow = this.db
        .prepare('SELECT * FROM group_order_items WHERE id = ? AND order_id = ?')
        .get(params.itemId, order.id) as SqlRow | undefined;
      if (!itemRow) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const existingItem = mapGroupOrderItemRow(itemRow);

      const res = this.db
        .prepare(`
          UPDATE group_order_items
             SET claimed_qty = claimed_qty + ?
           WHERE id = ? AND order_id = ? AND claimed_qty + ? <= total_qty
        `)
        .run(qty, params.itemId, order.id, qty);

      if (Number(res.changes) === 0) {
        const remaining = Math.max(0, existingItem.total_qty - existingItem.claimed_qty);
        this.db.exec('ROLLBACK');
        return {
          ok: false,
          reason: 'oversell_conflict',
          remaining,
        };
      }

      const nowIso = (params.now ?? new Date()).toISOString();
      const claim: GroupClaimRecord = {
        id: crypto.randomUUID(),
        order_id: order.id,
        item_id: existingItem.id,
        buyer_name: params.buyerName.trim().slice(0, 32),
        buyer_contact: params.buyerContact.trim().slice(0, 48),
        qty,
        claim_token: crypto.randomBytes(16).toString('hex'),
        status: 'active',
        created_at: nowIso,
      };

      this.db
        .prepare(`
          INSERT INTO group_claims
            (id, order_id, item_id, buyer_name, buyer_contact, qty, claim_token, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          claim.id,
          claim.order_id,
          claim.item_id,
          claim.buyer_name,
          claim.buyer_contact,
          claim.qty,
          claim.claim_token,
          claim.status,
          claim.created_at
        );

      this.db
        .prepare('UPDATE group_orders SET updated_at = ? WHERE id = ?')
        .run(nowIso, order.id);

      const updatedItemRow = this.db
        .prepare('SELECT * FROM group_order_items WHERE id = ?')
        .get(existingItem.id) as SqlRow;

      this.db.exec('COMMIT');
      return { ok: true, claim, item: mapGroupOrderItemRow(updatedItemRow) };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public cancelGroupClaim(params: {
    shareCode: string;
    claimId: string;
    ownerToken?: string;
    claimToken?: string;
    now?: Date;
  }):
    | { ok: true; claim: GroupClaimRecord; item: GroupOrderItemRecord }
    | { ok: false; reason: 'not_found' | 'forbidden' | 'already_cancelled' } {
    const code = params.shareCode.trim().toUpperCase();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const orderRow = this.db
        .prepare('SELECT * FROM group_orders WHERE share_code = ?')
        .get(code) as SqlRow | undefined;
      if (!orderRow) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const order = mapGroupOrderRow(orderRow);

      const claimRow = this.db
        .prepare('SELECT * FROM group_claims WHERE id = ? AND order_id = ?')
        .get(params.claimId, order.id) as SqlRow | undefined;
      if (!claimRow) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const claim = mapGroupClaimRow(claimRow);

      const isOwner = Boolean(params.ownerToken && params.ownerToken === order.owner_token);
      const isBuyerSelf = Boolean(params.claimToken && params.claimToken === claim.claim_token);
      if (!isOwner && !isBuyerSelf) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'forbidden' };
      }
      if (claim.status === 'cancelled') {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'already_cancelled' };
      }

      const itemRow = this.db
        .prepare('SELECT * FROM group_order_items WHERE id = ? AND order_id = ?')
        .get(claim.item_id, order.id) as SqlRow | undefined;
      if (!itemRow) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }

      const nowIso = (params.now ?? new Date()).toISOString();
      this.db
        .prepare("UPDATE group_claims SET status = 'cancelled' WHERE id = ?")
        .run(claim.id);
      this.db
        .prepare('UPDATE group_order_items SET claimed_qty = MAX(0, claimed_qty - ?) WHERE id = ?')
        .run(claim.qty, claim.item_id);
      this.db
        .prepare('UPDATE group_orders SET updated_at = ? WHERE id = ?')
        .run(nowIso, order.id);

      const updatedClaimRow = this.db
        .prepare('SELECT * FROM group_claims WHERE id = ?')
        .get(claim.id) as SqlRow;
      const updatedItemRow = this.db
        .prepare('SELECT * FROM group_order_items WHERE id = ?')
        .get(claim.item_id) as SqlRow;

      this.db.exec('COMMIT');
      return {
        ok: true,
        claim: mapGroupClaimRow(updatedClaimRow),
        item: mapGroupOrderItemRow(updatedItemRow),
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public syncGroupOrderFromOrganizer(params: {
    shareCode: string;
    ownerToken: string;
    status?: GroupOrderStatus;
    annotatedImageDataUrl?: string;
    items?: Array<{
      sourceItemId?: string;
      label: string;
      price: number;
      prepaidPrice?: number;
      totalQty?: number;
      tag?: string;
    }>;
    now?: Date;
  }): { ok: true; order: GroupOrderRecord } | { ok: false; reason: 'not_found' | 'forbidden' } {
    const code = params.shareCode.trim().toUpperCase();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const orderRow = this.db
        .prepare('SELECT * FROM group_orders WHERE share_code = ?')
        .get(code) as SqlRow | undefined;
      if (!orderRow) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const order = mapGroupOrderRow(orderRow);
      if (!params.ownerToken || params.ownerToken !== order.owner_token) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'forbidden' };
      }

      const nextStatus: GroupOrderStatus =
        params.status && ['open', 'locked', 'settled'].includes(params.status)
          ? params.status
          : order.status;
      const nextImage = params.annotatedImageDataUrl || order.annotated_image_data_url;
      const nowIso = (params.now ?? new Date()).toISOString();

      this.db
        .prepare(
          'UPDATE group_orders SET status = ?, annotated_image_data_url = ?, updated_at = ? WHERE id = ?'
        )
        .run(nextStatus, nextImage, nowIso, order.id);

      if (Array.isArray(params.items)) {
        const existingRows = this.db
          .prepare('SELECT * FROM group_order_items WHERE order_id = ? ORDER BY rowid ASC')
          .all(order.id) as SqlRow[];
        const existingItems = existingRows.map(mapGroupOrderItemRow);
        const keptIds = new Set<string>();

        const updateItemStmt = this.db.prepare(`
          UPDATE group_order_items
             SET price = ?, prepaid_price = ?, total_qty = ?, tag = ?
           WHERE id = ?
        `);
        const insertItemStmt = this.db.prepare(`
          INSERT INTO group_order_items
            (id, order_id, source_item_id, label, price, prepaid_price, total_qty, claimed_qty, tag, box_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const patch of params.items) {
          const target =
            existingItems.find((it) => patch.sourceItemId && it.source_item_id === patch.sourceItemId) ||
            existingItems.find((it) => normalizeKey(it.label) === normalizeKey(patch.label));

          const nextPrice = Math.max(0, Math.round(patch.price * 100) / 100);
          if (target) {
            keptIds.add(target.id);
            const nextPrepaid =
              patch.prepaidPrice !== undefined && Number.isFinite(patch.prepaidPrice)
                ? Math.max(0, Math.round(patch.prepaidPrice * 100) / 100)
                : (target.prepaid_price ?? null);
            const nextTotalQty =
              patch.totalQty !== undefined && Number.isFinite(patch.totalQty)
                ? Math.max(target.claimed_qty, Math.floor(patch.totalQty))
                : target.total_qty;
            const nextTag =
              patch.tag !== undefined ? patch.tag.trim().slice(0, 12) : target.tag;

            updateItemStmt.run(nextPrice, nextPrepaid, nextTotalQty, nextTag, target.id);
          } else {
            const newId = crypto.randomUUID();
            keptIds.add(newId);
            const nextPrepaid =
              patch.prepaidPrice !== undefined && Number.isFinite(patch.prepaidPrice)
                ? Math.max(0, Math.round(patch.prepaidPrice * 100) / 100)
                : nextPrice;
            const nextTotalQty =
              patch.totalQty !== undefined && Number.isFinite(patch.totalQty)
                ? Math.max(1, Math.floor(patch.totalQty))
                : 1;
            insertItemStmt.run(
              newId,
              order.id,
              patch.sourceItemId ?? null,
              patch.label.trim().slice(0, 32) || '谷子单品',
              nextPrice,
              nextPrepaid,
              nextTotalQty,
              0,
              (patch.tag || '').trim().slice(0, 12),
              null
            );
          }
        }

        // Remove items that disappeared from organizer's synced list (clean up their claims first)
        if (params.items.length > 0) {
          const deleteClaimsStmt = this.db.prepare('DELETE FROM group_claims WHERE item_id = ?');
          const deleteItemStmt = this.db.prepare('DELETE FROM group_order_items WHERE id = ?');
          for (const existing of existingItems) {
            if (!keptIds.has(existing.id)) {
              deleteClaimsStmt.run(existing.id);
              deleteItemStmt.run(existing.id);
            }
          }
        }
      }

      const updatedOrderRow = this.db
        .prepare('SELECT * FROM group_orders WHERE id = ?')
        .get(order.id) as SqlRow;

      this.db.exec('COMMIT');
      return { ok: true, order: mapGroupOrderRow(updatedOrderRow) };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
